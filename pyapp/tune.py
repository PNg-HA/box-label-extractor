"""Quick parameter sweep for the detector against ground truth (detection only)."""
from __future__ import annotations
import itertools, cv2
from detector import detect_labels
from batch_detect import TRUTH
import os

imgs = {n: cv2.imread(os.path.join("..", n)) for n in TRUTH}

grid = {
    "rect_fill_min": [0.4, 0.5],
    "aspect_hi": [5.0, 6.5],
    "min_area_frac": [0.0025, 0.004],
    "max_area_frac": [0.06, 0.09],
    "left_frac": [0.66, 0.72],
}
keys = list(grid)
best = None
for combo in itertools.product(*[grid[k] for k in keys]):
    kw = dict(zip(keys, combo))
    tot = 0; exact = 0
    for n, truth in TRUTH.items():
        _, boxes = detect_labels(imgs[n], **kw)
        e = abs(len(boxes) - truth)
        tot += e
        if e == 0: exact += 1
    score = (tot, -exact)
    if best is None or score < best[0]:
        best = (score, kw, tot, exact)
        print(f"err={tot:3} exact={exact:2}  {kw}")
print("\nBEST:", best[1], "err", best[2], "exact", best[3])
