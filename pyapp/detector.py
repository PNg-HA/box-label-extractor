"""
OpenCV white-label detector.

Finds each white, ~rectangular/parallelogram label on the cardboard boxes and returns a tight
bounding box per label. Works per vertical column (boxes are stacked in 3 columns) and uses a
MULTI-THRESHOLD brightness sweep so labels survive varying glare/exposure: at several
brightness cutoffs we find bright near-rectangular contours of label size, then pool the
detections across thresholds and de-duplicate by overlap.

Detection only — NO OCR here.
"""
from __future__ import annotations
import cv2
import numpy as np


def auto_orient(img: np.ndarray) -> np.ndarray:
    """Phone photos are stored landscape with EXIF=6. cv2 ignores EXIF, so rotate to portrait."""
    h, w = img.shape[:2]
    if w > h:
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    return img


def _iou(a, b) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0:
        return 0.0
    ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / ua if ua > 0 else 0.0


def _overlap_min(a, b) -> float:
    """Intersection over the SMALLER box area — catches containment (fragment inside a label)."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0:
        return 0.0
    sm = min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0))
    return inter / sm if sm > 0 else 0.0


def _cluster_vote(cands, iou_dedup, min_votes):
    """
    Group candidate boxes that recur across thresholds into clusters (same physical label),
    require each cluster to appear at >= min_votes thresholds (noise/fragments show up once),
    and return one merged box per surviving cluster (median extents).
    """
    clusters = []  # each: list of boxes
    for b in cands:
        placed = False
        for cl in clusters:
            if _iou(b, cl[0]) >= iou_dedup or _overlap_min(b, cl[0]) >= 0.7:
                cl.append(b); placed = True; break
        if not placed:
            clusters.append([b])
    kept = []
    for cl in clusters:
        if len(cl) < min_votes:
            continue
        xs0 = sorted(c[0] for c in cl); ys0 = sorted(c[1] for c in cl)
        xs1 = sorted(c[2] for c in cl); ys1 = sorted(c[3] for c in cl)
        mid = len(cl) // 2
        kept.append((xs0[mid], ys0[mid], xs1[mid], ys1[mid]))
    kept.sort(key=lambda b: b[1])
    return kept


def detect_in_column(col_bgr: np.ndarray,
                     left_frac: float = 0.72,
                     t_lo: int = 150, t_hi: int = 230, t_step: int = 12,
                     min_area_frac: float = 0.004, max_area_frac: float = 0.06,
                     aspect_lo: float = 1.0, aspect_hi: float = 5.0,
                     rect_fill_min: float = 0.40,
                     iou_dedup: float = 0.3, min_votes: int = 1) -> list[tuple[int, int, int, int]]:
    """Return list of (x0,y0,x1,y1) label boxes within this column (pixel coords)."""
    H, W = col_bgr.shape[:2]
    gray = cv2.bilateralFilter(cv2.cvtColor(col_bgr, cv2.COLOR_BGR2GRAY), 9, 60, 60)
    cands = []
    kx = max(3, int(W * 0.05))
    ky = max(3, int(W * 0.012))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kx, ky))
    for T in range(t_lo, t_hi + 1, t_step):
        _, bw = cv2.threshold(gray, T, 255, cv2.THRESH_BINARY)
        bw[:, int(W * left_frac):] = 0          # labels live on the left; hole on the right
        m = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kernel)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            area = cv2.contourArea(c)
            if area < W * H * min_area_frac or area > W * H * max_area_frac:
                continue
            x, y, bw2, bh2 = cv2.boundingRect(c)
            ar = bw2 / float(bh2)
            if ar < aspect_lo or ar > aspect_hi:
                continue
            if area / (bw2 * bh2) < rect_fill_min:   # near-rectangular fill
                continue
            cands.append((x, y, x + bw2, y + bh2))
    # cluster recurring detections across thresholds; require multi-threshold support
    return _cluster_vote(cands, iou_dedup, min_votes)


def detect_labels(img_bgr: np.ndarray, columns: int = 3, **kw):
    """
    Detect labels across the whole (oriented) image, split into `columns` vertical strips.
    Returns a list of dicts: {col, x0,y0,x1,y1} in FULL-image pixel coords, top-to-bottom.
    """
    img = auto_orient(img_bgr)
    H, W = img.shape[:2]
    tile_w = W // columns
    out = []
    for c in range(columns):
        left = c * tile_w
        w = (W - left) if c == columns - 1 else tile_w
        col = img[:, left:left + w]
        for (x0, y0, x1, y1) in detect_in_column(col, **kw):
            out.append({"col": c, "x0": left + x0, "y0": y0, "x1": left + x1, "y1": y1})
    return img, out
