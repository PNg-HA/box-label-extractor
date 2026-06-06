"""
Bedrock-based counting (for DENSE stacks where OpenCV under-counts).

Two entry points:
  - quick_count(img): one cheap Bedrock call on the whole (downscaled) image, returns just an
    integer box count based on intact white labels. Used as a ROUTER: >35 -> dense method.
  - count_dense(img): the accurate method for many boxes — split into vertical columns, count
    each column with extended thinking + ENSEMBLE majority vote (all calls fire in parallel),
    sum columns. Also returns the per-label fields read while counting.

Claude downscales any image to ~1.15 MP, so a dense pallet becomes unreadable as a whole; we
tile into columns so each column gets the full budget and boxes appear ~3x larger.
"""
from __future__ import annotations
import json, time, base64, collections
from concurrent.futures import ThreadPoolExecutor
import cv2
import numpy as np
from ocr import session, bedrock_client, BEDROCK_MODEL

THINKING_BUDGET = 16000   # measured optimal in the Node worker (64k slower, not better)
MAX_TOKENS = 24000
VOTES = 3                 # ensemble runs per column, all parallel


def _encode_maxdim(img_bgr: np.ndarray, max_dim: int = 1560, quality: int = 92) -> bytes:
    """Resize so the LONGEST side <= max_dim (matches Claude's ~1568px cap), JPEG-encode."""
    h, w = img_bgr.shape[:2]
    s = max_dim / float(max(h, w))
    if s < 1.0:
        img_bgr = cv2.resize(img_bgr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()


QUICK_PROMPT = """This is a photo of cardboard boxes STACKED in horizontal layers (often in 2-3 vertical columns).
Count how many BOXES there are. Each box layer shows ONE main white printed label (and usually a round hole).
Count one box per layer by its main intact white label. A box with several labels still counts ONCE.
Do NOT count torn/peeled unreadable labels, small slips/stickers, or printed cardboard text.
This is only a rough total to route processing, so answer fast.
Return ONLY raw JSON on the last line: { "box_count": <int> }"""


def quick_count(img_bgr: np.ndarray, profile: str = "gapv50k") -> int:
    """Cheap whole-image count (no thinking). Returns an int (0 on failure)."""
    br = session(profile).client("bedrock-runtime")
    data = _encode_maxdim(img_bgr, 1560)
    content = [{"image": {"format": "jpeg", "source": {"bytes": data}}}, {"text": QUICK_PROMPT}]
    for attempt in range(5):
        try:
            r = br.converse(
                modelId=BEDROCK_MODEL,
                messages=[{"role": "user", "content": content}],
                inferenceConfig={"maxTokens": 800, "temperature": 0},
            )
            text = "".join(p.get("text", "") for p in r["output"]["message"]["content"])
            s, e = text.rfind("{"), text.rfind("}")
            return int(json.loads(text[s:e + 1]).get("box_count", 0))
        except Exception as ex:
            if "Throttl" in type(ex).__name__ or "TooManyRequests" in type(ex).__name__:
                time.sleep(1.5 * (attempt + 1)); continue
            if attempt == 4:
                return 0
    return 0


# Reused column-counting prompt (boxes stacked, hole anchor, fixed field keys).
COLUMN_PROMPT = """This image is a CROPPED vertical COLUMN from a photo of cardboard boxes STACKED in horizontal layers (one box on top of another). Count how many BOXES are in this column, and read each box's main label.

WHAT IS ONE BOX:
- Scan strictly TOP to BOTTOM and count each distinct box layer.
- Each box's front face normally shows ONE round viewing hole (a dark circle) AND ONE main white printed label.
- Use the round hole as an ANCHOR to locate each layer. A box may show 1 OR MORE holes; that is still ONE box. Never multiply a box by its holes.
- ONE BOX = ONE entry. If a box has several labels, use its LARGEST INTACT label and count ONCE.
- Coloured/retail boxes still count as a box by their main label.

DO NOT count: small slips/mini stickers, torn/peeled unreadable labels, a label clipped by the LEFT/RIGHT edge (belongs to the neighbouring column), or printed cardboard text ("VC9", "VC11.2", recycling triangle, "UP").

For each box read its main label using EXACTLY these fixed snake_case keys (omit a key only if truly absent; never invent key spellings):
shop_name (no comma), destination (address WITH a comma), order_number (starts "TO-"), number (e.g. "1.1"), date, time, lot, line_code (e.g. "VC9-B"), box_code (large code on the CARTON e.g. "VC9"), total, products (array of { name, code, type, grade, size, qty }).

OUTPUT: raw JSON on the LAST line, exactly:
{ "box_count": <int>, "labels": [ { "fields": { ... } } ] }
box_count MUST equal labels.length."""


def _count_column_once(col_bgr: np.ndarray, profile: str) -> dict:
    br = bedrock_client(profile)
    data = _encode_maxdim(col_bgr, 1560)
    content = [{"image": {"format": "jpeg", "source": {"bytes": data}}}, {"text": COLUMN_PROMPT}]
    for attempt in range(8):
        try:
            r = br.converse_stream(
                modelId=BEDROCK_MODEL,
                messages=[{"role": "user", "content": content}],
                inferenceConfig={"maxTokens": MAX_TOKENS},
                additionalModelRequestFields={"thinking": {"type": "enabled", "budget_tokens": THINKING_BUDGET}},
            )
            text = ""
            for ev in r["stream"]:
                d = ev.get("contentBlockDelta", {}).get("delta", {})
                if "text" in d:            # only normal text, not reasoning
                    text += d["text"]
            s, e = text.find("{"), text.rfind("}")
            data_j = json.loads(text[s:e + 1])
            labels = [{"fields": l.get("fields", {})} for l in data_j.get("labels", [])]
            return {"count": len(labels), "labels": labels}
        except Exception as ex:
            name = type(ex).__name__
            if "Throttl" in name or "TooManyRequests" in name or "ServiceUnavailable" in name:
                time.sleep(min(30, 2.0 * (attempt + 1) ** 2)); continue
            if attempt == 7:
                return {"count": 0, "labels": []}
            time.sleep(1.0)
    return {"count": 0, "labels": []}


def _pick(runs: list[dict], count: int) -> list[dict]:
    """Among ensemble runs, take a run whose count == majority and has the most filled fields."""
    matching = [r for r in runs if r["count"] == count] or runs
    best, best_score = matching[0], -1
    for r in matching:
        score = sum(1 for l in r["labels"] for v in l["fields"].values() if v)
        if score > best_score:
            best, best_score = r, score
    return best["labels"]


def count_dense(img_bgr: np.ndarray, columns: int = 3, votes: int = VOTES,
                profile: str = "gapv50k", max_workers: int = 4) -> dict:
    """Column tiling + ensemble vote counting. Returns {box_count, labels, per_column}."""
    from detector import auto_orient
    img = auto_orient(img_bgr)
    H, W = img.shape[:2]
    tile_w = W // columns
    cols = []
    for c in range(columns):
        left = c * tile_w
        w = (W - left) if c == columns - 1 else tile_w
        cols.append(img[:, left:left + w])

    # fire EVERY (column x vote) call in parallel
    jobs = [(ci, cols[ci]) for ci in range(columns) for _ in range(votes)]
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        results = list(ex.map(lambda j: (j[0], _count_column_once(j[1], profile)), jobs))

    per_col_runs: dict[int, list] = collections.defaultdict(list)
    for ci, r in results:
        per_col_runs[ci].append(r)

    total = 0
    all_labels = []
    per_column = []
    for ci in range(columns):
        runs = per_col_runs[ci]
        counts = [r["count"] for r in runs]
        # ignore failed/throttled votes (count 0) when at least one vote succeeded,
        # so an API error never drags a column's count down to zero
        good = [c for c in counts if c > 0]
        majority = collections.Counter(good or counts).most_common(1)[0][0]
        labels = _pick(runs, majority)
        per_column.append({"col": ci, "votes": counts, "count": majority})
        total += majority
        for l in labels:
            l["col"] = ci
            all_labels.append(l)

    for i, l in enumerate(all_labels, 1):
        l["index"] = i
    return {"box_count": total, "labels": all_labels, "per_column": per_column}
