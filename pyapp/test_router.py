"""Test quick_count routing across all ground-truth images (count only, no OCR/dense)."""
from __future__ import annotations
import os, time, cv2
from detector import auto_orient
from counter import quick_count
from batch_detect import TRUTH

TH = 35
print(f"{'image':52} {'true':>5} {'quick':>5} {'route':>7}")
for name, truth in TRUTH.items():
    img = cv2.imread(os.path.join("..", name))
    if img is None:
        print("MISSING", name); continue
    q = quick_count(auto_orient(img))
    route = "dense" if q > TH else "opencv"
    flag = "" if (q > TH) == (truth > TH) else "  <-- mismatch vs truth-route"
    print(f"{name:52} {truth:>5} {q:>5} {route:>7}{flag}")
