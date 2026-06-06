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

THRESHOLD = 35


def crop(img, b, pad=12):
    H, W = img.shape[:2]
    x0 = max(0, b["x0"] - pad); y0 = max(0, b["y0"] - pad)
    x1 = min(W, b["x1"] + pad); y1 = min(H, b["y1"] + pad)
    return img[y0:y1, x0:x1]


def run_opencv(img, engine, profile, max_workers=8):
    """Current method: OpenCV detect + per-label OCR."""
    _, boxes = detect_labels(img)

    def handle(b):
        c = crop(img, b)
        if engine == "textract":
            return {"col": b["col"], "fields": {"_lines": textract_lines(c, profile)}}
        if engine == "bedrock":
            return {"col": b["col"], "fields": bedrock_fields(c, profile)}
        lines = textract_lines(c, profile)
        return {"col": b["col"], "fields": bedrock_fields(c, profile, ocr_hint=lines)}

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        labels = list(ex.map(handle, boxes))
    for i, l in enumerate(labels, 1):
        l["index"] = i
    return {"box_count": len(boxes), "labels": labels, "method": "opencv", "boxes": boxes}


def process(path, engine="hybrid", method="auto", threshold=THRESHOLD,
            profile="gapv50k", annotate=False):
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
        res = run_opencv(img, engine, profile)

    res["routing"] = {"method": chosen, "quick_count": estimate, "threshold": threshold}

    if annotate and chosen == "opencv":
        vis = img.copy()
        for b in res.get("boxes", []):
            cv2.rectangle(vis, (b["x0"], b["y0"]), (b["x1"], b["y1"]), (0, 0, 255), 6)
        out = os.path.splitext(os.path.basename(path))[0] + "_annotated.jpg"
        H, W = vis.shape[:2]
        cv2.imwrite(out, cv2.resize(vis, (W // 4, H // 4)))
        print("annotated ->", out, file=sys.stderr)
    res.pop("boxes", None)
    return res


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--engine", default="hybrid", choices=["textract", "bedrock", "hybrid"])
    ap.add_argument("--method", default="auto", choices=["auto", "opencv", "dense"])
    ap.add_argument("--threshold", type=int, default=THRESHOLD)
    ap.add_argument("--profile", default="gapv50k")
    ap.add_argument("--annotate", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    res = process(a.image, a.engine, a.method, a.threshold, a.profile, a.annotate)
    res["seconds"] = round(time.time() - t0, 1)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
