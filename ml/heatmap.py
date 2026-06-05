"""Render Gaussian targets; per-class decoders for the 3 model channels.

Decoders:
  ch0 point_via    -> extract_peaks            -> points
  ch1 irregular_via-> extract_components       -> {bbox, centroid, area}
  ch2 trace        -> extract_trace_polylines  -> contour polylines
(True skeleton->graph for trace is the later assisted-tracing phase; contour
polylines are the dependency-free v1 decode.)
"""
from __future__ import annotations

from typing import Iterable

import cv2
import numpy as np
from scipy.ndimage import maximum_filter
from scipy.ndimage import mean as ndi_mean


def render_heatmap(points: Iterable[tuple[float, float]],
                   shape: tuple[int, int],
                   sigma: float) -> np.ndarray:
    h, w = shape
    heatmap = np.zeros((h, w), dtype=np.float32)
    radius = max(1, int(np.ceil(3 * sigma)))
    two_sigma_sq = 2.0 * sigma * sigma
    for x, y in points:
        cx, cy = float(x), float(y)
        x0 = max(0, int(np.floor(cx - radius)))
        x1 = min(w, int(np.ceil(cx + radius + 1)))
        y0 = max(0, int(np.floor(cy - radius)))
        y1 = min(h, int(np.ceil(cy + radius + 1)))
        if x0 >= x1 or y0 >= y1:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1]
        g = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / two_sigma_sq)
        view = heatmap[y0:y1, x0:x1]
        np.maximum(view, g, out=view)
    return heatmap


def extract_peaks(heatmap: np.ndarray,
                  threshold: float = 0.3,
                  min_distance: int = 3) -> list[tuple[int, int, float]]:
    size = 2 * min_distance + 1
    local_max = maximum_filter(heatmap, size=size, mode="constant", cval=0.0) == heatmap
    above = heatmap > threshold
    coords = np.argwhere(local_max & above)
    if coords.size == 0:
        return []
    scores = heatmap[coords[:, 0], coords[:, 1]]
    order = np.argsort(-scores)
    coords = coords[order]
    scores = scores[order]
    return [(int(c[1]), int(c[0]), float(s)) for c, s in zip(coords, scores)]


def extract_components(mask_prob: np.ndarray,
                       threshold: float = 0.5,
                       min_area: int = 4) -> list[dict]:
    """irregular_via decode: connected components → bbox/centroid/area/score.

    Per-label mean score is computed in a SINGLE vectorized pass. (Previously
    `mask_prob[labels == i].mean()` ran inside the loop — O(n_components·H·W),
    which on a gigapixel near-noise mask hangs effectively forever.)
    """
    binary = (mask_prob > threshold).astype(np.uint8)
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, 8)
    if n <= 1:
        return []
    idx = np.arange(1, n)
    means = np.atleast_1d(ndi_mean(mask_prob, labels=labels, index=idx))
    out: list[dict] = []
    for k, i in enumerate(idx):  # 0 = background
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        out.append({
            "bbox": [int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                     int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])],
            "centroid": [float(centroids[i][0]), float(centroids[i][1])],
            "area": area,
            "score": float(means[k]),
        })
    return out


def extract_trace_polylines(mask_prob: np.ndarray,
                            threshold: float = 0.5,
                            epsilon: float = 1.5,
                            min_len: int = 8,
                            max_polylines: int = 100_000) -> list[list[list[int]]]:
    """trace decode (v1): contour polylines of the thresholded mask.

    Returns a list of polylines, each a list of [x, y]. A true skeleton→graph
    is the later assisted-tracing phase; contours are enough for the UI to
    overlay proposed conductor paths.

    Guarded against an under-trained / low-threshold mask exploding into
    millions of speckle contours: contours are sorted by length and only the
    longest `max_polylines` kept (a runaway count means raise the threshold or
    decode per-tile instead of whole-die).
    """
    binary = (mask_prob > threshold).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    kept = [c for c in contours if cv2.arcLength(c, closed=False) >= min_len]
    if len(kept) > max_polylines:
        print(f"[warn] trace decode: {len(kept)} contours > cap {max_polylines} "
              f"— mask is noisy (raise --threshold or decode per-tile); "
              f"keeping the {max_polylines} longest")
        kept.sort(key=lambda c: cv2.arcLength(c, closed=False), reverse=True)
        kept = kept[:max_polylines]
    polylines: list[list[list[int]]] = []
    for c in kept:
        approx = cv2.approxPolyDP(c, epsilon, closed=False)
        polylines.append([[int(p[0][0]), int(p[0][1])] for p in approx])
    return polylines
