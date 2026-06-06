"""
Batch detection benchmark for the OpenCV detector across all ground-truth images.
Measures detected label count vs true box count per image (no OCR, fast).

  python batch_detect.py
"""
from __future__ import annotations
import os, time, json
import cv2
from detector import detect_labels

IMG_DIR = ".."
TRUTH = {
    "IMG_5816.jpeg": 31,
    "IMG_5817.jpeg": 34,
    "IMG_5818.jpeg": 4,
    "IMG_5819.jpeg": 15,
    "IMG_5825.jpeg": 22,
    "z7684272505382_c6246306bfd98e30b517ecf83e168fea.jpg": 45,
    "z7684272512641_ad8f1ab954706c9fb0c3f3323e4c9318.jpg": 27,
    "z7684272609303_0427067caf3a7fc990dc1624d92df2da.jpg": 42,
    "z7684272634118_fd6cb398bd8149242fbd967023d2dd7a.jpg": 45,
    "z7706421817056_b9ad273ea1c75c9f3af8df19961ce0b8.jpg": 36,
    "z7706421874606_a5df4ab4329ae93b039b4253f6dabca9.jpg": 30,
    "z7706425611275_f11dff944c8214b8296bb7997b00b70d.jpg": 40,
}


def main():
    rows = []
    tot_err = 0
    exact = 0
    for name, truth in TRUTH.items():
        path = os.path.join(IMG_DIR, name)
        img = cv2.imread(path)
        if img is None:
            print(f"MISSING {name}")
            continue
        t0 = time.time()
        _, boxes = detect_labels(img)
        dt = time.time() - t0
        n = len(boxes)
        err = abs(n - truth)
        tot_err += err
        if err == 0:
            exact += 1
        rows.append((name, truth, n, n - truth, round(dt, 2)))

    print(f"{'image':52} {'true':>5} {'det':>5} {'diff':>5} {'sec':>6}")
    for name, truth, n, d, dt in rows:
        print(f"{name:52} {truth:>5} {n:>5} {d:>+5} {dt:>6}")
    print(f"\nexact: {exact}/{len(rows)}   total abs error: {tot_err}")


if __name__ == "__main__":
    main()
