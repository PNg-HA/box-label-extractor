"""
Detect the dark, roughly-round viewing holes on the box fronts (OpenCV), and derive COLUMN
CUT positions from where the holes cluster horizontally — so we split a pallet at the real
gaps between columns instead of a blind 1/N slice (which slices a box in two and over-counts).

Ported from the Node worker (holes.mjs) but using OpenCV connected components + contour
circularity instead of hand-rolled blob labelling.

detect_hole_xs(img) -> sorted list of hole X-centroids as fractions of width (0..1)
column_cuts_from_holes(xs, k) -> k-1 cut fractions, or None if the signal is too weak
"""
from __future__ import annotations
import cv2
import numpy as np

PROC_W = 1000          # downscale width for fast, stable hole detection
PCT = 0.16             # brightness percentile for the dark threshold
CLOSE_FRAC = 0.006     # morphological close radius (bridge flowers/plastic inside a hole)
CIRC_MIN = 0.55        # min circularity (4*pi*area / perimeter^2)
SIZE_LO, SIZE_HI = 0.35, 2.8   # blob area band relative to the median hole


def detect_hole_xs(img_bgr: np.ndarray) -> list[float]:
    h0, w0 = img_bgr.shape[:2]
    scale = PROC_W / float(w0)
    img = cv2.resize(img_bgr, (PROC_W, int(h0 * scale)), interpolation=cv2.INTER_AREA)
    H, W = img.shape[:2]
    gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (3, 3), 0)

    # adaptive global threshold from a dark percentile (handles bright & dark photos)
    th = int(np.clip(np.percentile(gray, PCT * 100), 30, 120))
    dark = (gray < th).astype(np.uint8) * 255

    r = max(1, int(W * CLOSE_FRAC))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, k)

    n, labels, stats, cents = cv2.connectedComponentsWithStats(dark, connectivity=8)
    img_area = float(W * H)
    cand = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < img_area * 0.0005 or area > img_area * 0.04:
            continue
        bw, bh = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        aspect = bw / float(bh)
        if aspect < 0.55 or aspect > 1.8:
            continue
        cand.append((i, area, cents[i][0]))
    if not cand:
        return []

    med = float(np.median([c[1] for c in cand]))
    xs = []
    for i, area, cx in cand:
        if area < med * SIZE_LO or area > med * SIZE_HI:
            continue
        # circularity from the component mask
        mask = (labels == i).astype(np.uint8)
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        per = cv2.arcLength(c, True)
        if per <= 0:
            continue
        circ = 4 * np.pi * cv2.contourArea(c) / (per * per)
        if circ < CIRC_MIN:
            continue
        xs.append(cx / W)
    xs.sort()
    return xs


def column_cuts_from_holes(xs: list[float], k: int) -> list[float] | None:
    """1D k-means on hole X-fractions -> k-1 cut boundaries. None if signal too weak."""
    if not xs or len(xs) < k * 3:
        return None
    xs_a = np.array(xs, dtype=np.float64)
    centers = np.array([xs_a[int((i + 0.5) / k * len(xs_a))] for i in range(k)], dtype=np.float64)
    for _ in range(40):
        d = np.abs(xs_a[:, None] - centers[None, :])
        assign = d.argmin(axis=1)
        new = centers.copy()
        for i in range(k):
            grp = xs_a[assign == i]
            if len(grp) == 0:
                return None           # degenerate
            new[i] = grp.mean()
        if np.all(np.abs(new - centers) < 1e-4):
            centers = new
            break
        centers = new
    centers.sort()
    # reject if two centers collapsed together (not a real multi-column layout)
    for i in range(1, k):
        if centers[i] - centers[i - 1] < 0.08:
            return None
    return [(centers[i - 1] + centers[i]) / 2 for i in range(1, k)]
