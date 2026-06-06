"""
Field-coverage evaluation for the hybrid (OpenCV + Textract->Bedrock) pipeline on one image.
Reports how many detected labels carry each key field.

  python eval_fields.py ../IMG_5816.jpeg
"""
from __future__ import annotations
import sys, json, time
from pipeline import process


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "../IMG_5816.jpeg"
    engine = sys.argv[2] if len(sys.argv) > 2 else "hybrid"
    t0 = time.time()
    res = process(path, engine=engine)
    res["seconds"] = round(time.time() - t0, 1)
    labels = res["labels"]
    n = len(labels)
    keys = ["shop_name", "destination", "order_number", "number", "date",
            "time", "line_code", "box_code", "total"]
    cov = {k: 0 for k in keys}
    has_products = 0
    for l in labels:
        f = l["fields"]
        for k in keys:
            if f.get(k):
                cov[k] += 1
        if f.get("products"):
            has_products += 1
    print(f"image={path}  engine={engine}  labels={n}  seconds={res['seconds']}")
    for k in keys:
        print(f"  {k:14} {cov[k]:>3}/{n}")
    print(f"  {'products':14} {has_products:>3}/{n}")


if __name__ == "__main__":
    main()
