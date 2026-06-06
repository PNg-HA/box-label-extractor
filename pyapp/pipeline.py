"""
End-to-end: OpenCV detects/crops each label, then Textract or Bedrock reads it.

Usage:
  python pipeline.py <image> [--engine textract|bedrock|hybrid] [--profile gapv50k] [--annotate]

- textract : OCR each label -> raw lines (fast)
- bedrock  : Claude Sonnet 4.6 -> structured fields per label
- hybrid   : Textract lines fed to Bedrock as a hint -> structured fields, best accuracy
"""
from __future__ import annotations
import sys, os, json, argparse, time
from concurrent.futures import ThreadPoolExecutor
import cv2
from detector import detect_labels
from ocr import textract_lines, bedrock_fields


def crop(img, b, pad=12):
    H, W = img.shape[:2]
    x0 = max(0, b["x0"] - pad); y0 = max(0, b["y0"] - pad)
    x1 = min(W, b["x1"] + pad); y1 = min(H, b["y1"] + pad)
    return img[y0:y1, x0:x1]


def process(path, engine="hybrid", profile="gapv50k", annotate=False, max_workers=8):
    img_raw = cv2.imread(path)
    if img_raw is None:
        raise FileNotFoundError(path)
    img, boxes = detect_labels(img_raw)

    def handle(b):
        c = crop(img, b)
        if engine == "textract":
            return {"col": b["col"], "fields": {"_lines": textract_lines(c, profile)}}
        if engine == "bedrock":
            return {"col": b["col"], "fields": bedrock_fields(c, profile)}
        # hybrid
        lines = textract_lines(c, profile)
        return {"col": b["col"], "fields": bedrock_fields(c, profile, ocr_hint=lines)}

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        labels = list(ex.map(handle, boxes))

    for i, l in enumerate(labels, 1):
        l["index"] = i

    if annotate:
        vis = img.copy()
        for b in boxes:
            cv2.rectangle(vis, (b["x0"], b["y0"]), (b["x1"], b["y1"]), (0, 0, 255), 6)
        out = os.path.splitext(os.path.basename(path))[0] + "_annotated.jpg"
        H, W = vis.shape[:2]
        cv2.imwrite(out, cv2.resize(vis, (W // 4, H // 4)))
        print("annotated ->", out, file=sys.stderr)

    return {"box_count": len(boxes), "labels": labels}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--engine", default="hybrid", choices=["textract", "bedrock", "hybrid"])
    ap.add_argument("--profile", default="gapv50k")
    ap.add_argument("--annotate", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    res = process(a.image, a.engine, a.profile, a.annotate)
    res["seconds"] = round(time.time() - t0, 1)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
