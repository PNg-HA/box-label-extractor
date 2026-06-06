"""
Adaptive COUNTING benchmark across all images: quick_count routes each image, then
opencv-detect count (<=threshold) or dense ensemble count (>threshold). Measures final
box_count vs ground truth + timing. (No per-label OCR — counting only.)

  python batch_count.py [threshold]
"""
from __future__ import annotations
import os, sys, time, cv2
from detector import auto_orient, detect_labels
from counter import quick_count, count_dense
from batch_detect import TRUTH

TH = int(sys.argv[1]) if len(sys.argv) > 1 else 35


def main():
    rows = []
    tot_err = 0; exact = 0
    for name, truth in TRUTH.items():
        img = auto_orient(cv2.imread(os.path.join("..", name)))
        t0 = time.time()
        q = quick_count(img)
        if q > TH:
            res = count_dense(img); n = res["box_count"]; method = "dense"
        else:
            _, boxes = detect_labels(img); n = len(boxes); method = "opencv"
        dt = round(time.time() - t0, 1)
        err = abs(n - truth); tot_err += err; exact += (err == 0)
        rows.append((name, truth, q, method, n, n - truth, dt))

    print(f"{'image':52} {'true':>5} {'quick':>5} {'method':>7} {'final':>5} {'diff':>5} {'sec':>6}")
    for name, truth, q, m, n, d, dt in rows:
        print(f"{name:52} {truth:>5} {q:>5} {m:>7} {n:>5} {d:>+5} {dt:>6}")
    print(f"\nexact: {exact}/{len(rows)}   total abs error: {tot_err}")


if __name__ == "__main__":
    main()
