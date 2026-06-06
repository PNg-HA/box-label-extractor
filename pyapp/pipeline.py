"""
End-to-end with ADAPTIVE ROUTING by box count.

A cheap Bedrock "quick_count" first estimates how many boxes (intact white labels) are in the
photo. Then:
  - count <= THRESHOLD (default 35): OpenCV detects/crops each label, Textract/Bedrock reads it
    (deterministic detection, OCR per native-res label). Best field coverage on normal stacks.
  - count >  THRESHOLD: DENSE method — split into vertical columns and count each column with
    extended thinking + ensemble majority vote (all calls parallel), which handles tightly
    stacked pallets where OpenCV labels merge.

Usage:
  python pipeline.py <image> [--engine textract|bedrock|hybrid] [--method auto|opencv|dense]
                            [--threshold 35] [--profile gapv50k] [--annotate]
"""
from __future__ import annotations
import sys, os, json, argparse, time
from concurrent.futures import ThreadPoolExecutor
import cv2
from detector import detect_labels
from ocr import textract_lines, bedrock_fields
from counter import quick_count, count_dense

THRESHOLD = 25


def crop(img, b, pad=12):
    H, W = img.shape[:2]
    x0 = max(0, b["x0"] - pad); y0 = max(0, b["y0"] - pad)
    x1 = min(W, b["x1"] + pad); y1 = min(H, b["y1"] + pad)
    return img[y0:y1, x0:x1]


# Key fields that a MAIN delivery label should carry. A secondary slip / torn / erased label
# typically yields only 0-1 of these. We score each detected label by how many it has and
# drop the weak ones (handles over-detection without manual tuning of the detector).
KEY_FIELDS = ["order_number", "shop_name", "destination", "number",
              "line_code", "box_code", "total", "time", "date"]


def label_score(fields: dict) -> int:
    """Number of distinct key fields present (products array counts as one)."""
    if not isinstance(fields, dict):
        return 0
    s = sum(1 for k in KEY_FIELDS if str(fields.get(k) or "").strip())
    if fields.get("products"):
        s += 1
    return s


def _fields_from_lines(lines: list[str]) -> dict:
    """Rough structured guess from raw Textract lines, to score textract-only runs."""
    text = "\n".join(lines)
    import re
    f = {}
    if re.search(r"TO[-\s]?[A-Z]{1,3}", text):
        f["order_number"] = "1"
    if re.search(r"\bVC\d", text):
        f["line_code"] = "1"
    if re.search(r"\d{1,2}[:.]\d{2}", text):
        f["time"] = "1"
    if re.search(r"\b\d{1,3}\b", text):
        f["total"] = "1"
    if len(lines) >= 3:
        f["shop_name"] = "1"
    return f


def run_opencv(img, engine, profile, max_workers=8, min_fields=2):
    """OpenCV detect + per-label OCR, then drop labels that are not real MAIN labels
    (too few fields = secondary slip / torn / erased label)."""
    _, boxes = detect_labels(img)

    def handle(b):
        c = crop(img, b)
        if engine == "textract":
            lines = textract_lines(c, profile)
            return {"col": b["col"], "fields": {"_lines": lines},
                    "_score": label_score(_fields_from_lines(lines))}
        if engine == "bedrock":
            f = bedrock_fields(c, profile)
            return {"col": b["col"], "fields": f, "_score": label_score(f)}
        lines = textract_lines(c, profile)
        f = bedrock_fields(c, profile, ocr_hint=lines)
        return {"col": b["col"], "fields": f, "_score": label_score(f)}

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        raw = list(ex.map(handle, boxes))

    kept = [l for l in raw if l["_score"] >= min_fields]
    dropped = len(raw) - len(kept)
    for l in kept:
        l.pop("_score", None)
    for i, l in enumerate(kept, 1):
        l["index"] = i
    return {"box_count": len(kept), "labels": kept, "method": "opencv",
            "detected": len(boxes), "dropped_weak": dropped}


def process(path, engine="hybrid", method="auto", threshold=THRESHOLD,
            profile="gapv50k", annotate=False, min_fields=2):
    img_raw = cv2.imread(path)
    if img_raw is None:
        raise FileNotFoundError(path)
    from detector import auto_orient
    img = auto_orient(img_raw)

    chosen = method
    estimate = None
    if method == "auto":
        estimate = quick_count(img, profile)
        chosen = "dense" if estimate > threshold else "opencv"

    if chosen == "dense":
        res = count_dense(img, profile=profile)
        res["method"] = "dense"
    else:
        res = run_opencv(img, engine, profile, min_fields=min_fields)

    res["routing"] = {"method": chosen, "quick_count": estimate, "threshold": threshold}
    return res


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--engine", default="hybrid", choices=["textract", "bedrock", "hybrid"])
    ap.add_argument("--method", default="auto", choices=["auto", "opencv", "dense"])
    ap.add_argument("--threshold", type=int, default=THRESHOLD)
    ap.add_argument("--min-fields", type=int, default=2, dest="min_fields",
                    help="drop a detected label if it has fewer than this many key fields "
                         "(secondary slip / torn / erased label)")
    ap.add_argument("--profile", default="gapv50k")
    ap.add_argument("--annotate", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    res = process(a.image, a.engine, a.method, a.threshold, a.profile, a.annotate, a.min_fields)
    res["seconds"] = round(time.time() - t0, 1)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
