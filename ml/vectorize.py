"""Classical metal vectorization (no model): threshold → clean → decode.

The tuning-first alternative to the ML trace channel: pick a brightness or
colour channel of the source crop, band-pass it into a binary metal mask,
clean speckle/bridges morphologically, and decode the SAME skeleton traces
the ML path produces — plus the mask outlines, so the user sees exactly what
their threshold captured while tuning. Everything downstream (endpoint snap
to contacts, fragment stitching, traces→nets) is shared with the ML pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from heatmap import extract_trace_polylines, extract_trace_skeleton


@dataclass
class VectorParams:
    channel: str = "gray"          # gray | r | g | b
    invert: bool = False           # select DARK pixels instead of bright
    thresh_low: int = 120          # band-pass on the channel value (0..255)
    thresh_high: int = 255         # 255 = no upper cut
    adaptive: bool = False         # local gaussian threshold instead of band
    adaptive_block: int = 51       # odd neighbourhood size
    adaptive_c: int = 8            # subtracted from the local mean
    open_px: int = 1               # speckle-removal radius
    bridge_px: int = 2             # gap-bridging radius
    min_len: int = 14              # min skeleton branch length (px)
    width_min: float = 1.5         # keep branches with median width in range
    width_max: float = 0.0         # 0 = no upper bound
    max_outlines: int = 4000       # cap on the preview outline count


def _channel_image(rgb: np.ndarray, channel: str) -> np.ndarray:
    """uint8 single-channel view of the crop."""
    if channel == "r":
        return np.ascontiguousarray(rgb[:, :, 0])
    if channel == "g":
        return np.ascontiguousarray(rgb[:, :, 1])
    if channel == "b":
        return np.ascontiguousarray(rgb[:, :, 2])
    # Rec.601 luma — reads as "brightness" for SEM grayscale as well.
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)


def _empty(w: int, h: int) -> dict:
    return {"traces": [], "outlines": [], "width": int(w), "height": int(h)}


def vectorize_region(rgb: np.ndarray, p: VectorParams) -> dict:
    """Threshold → clean → decode. Returns traces + outline polylines in
    crop-local pixel coords (Node translates them to source coords)."""
    h, w = rgb.shape[:2]
    ch = _channel_image(rgb, p.channel)

    # ── Binary metal mask ────────────────────────────────────────────
    if p.adaptive:
        block = max(3, int(p.adaptive_block) | 1)  # force odd
        flag = cv2.THRESH_BINARY_INV if p.invert else cv2.THRESH_BINARY
        binary = cv2.adaptiveThreshold(
            ch, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, flag, block, max(0, int(p.adaptive_c))
        ) > 0
        strength = ch.astype(np.float32) / 255.0
    else:
        lo = max(0, min(255, int(p.thresh_low)))
        hi = max(lo, min(255, int(p.thresh_high)))
        band = (ch >= lo) & (ch <= hi)
        binary = (~band) if p.invert else band
        # Strength = depth inside the band — a cheap score proxy the client's
        # existing trace-confidence slider can filter on.
        lo_f, hi_f = lo / 255.0, max(hi, lo + 1) / 255.0
        norm = (ch.astype(np.float32) / 255.0 - lo_f) / (hi_f - lo_f)
        strength = np.clip((1.0 - norm) if p.invert else norm, 0.0, 1.0)

    if not binary.any():
        return _empty(w, h)

    # ── Morphological cleanup ────────────────────────────────────────
    bin_u8 = binary.astype(np.uint8)
    if p.open_px > 0:
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * p.open_px + 1,) * 2)
        bin_u8 = cv2.morphologyEx(bin_u8, cv2.MORPH_OPEN, k)
    if p.bridge_px > 0:
        # RECT (not ellipse): must match the bridging behaviour of the
        # skeleton decoder in heatmap.py — elliptical kernels under-bridge.
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * p.bridge_px + 1,) * 2)
        bin_u8 = cv2.morphologyEx(bin_u8, cv2.MORPH_CLOSE, k)
    if not bin_u8.any():
        return _empty(w, h)
    binary = bin_u8.astype(bool)

    # ── Decode ───────────────────────────────────────────────────────
    # Width map: distance transform of the mask ×2 — every pixel's value is
    # then the local wire width (distance-to-edge ≈ half width). The skeleton
    # decoder takes the per-branch median and optionally filters on it: wires
    # have a narrow, known width, so this kills fat blobs (pads, text,
    # charging halos) and the wide bridges where parallel wires bleed.
    dist = cv2.distanceTransform(bin_u8, cv2.DIST_L2, 3) * 2.0
    width_range: tuple[float, float] | None = None
    if p.width_min > 0 or p.width_max > 0:
        width_range = (p.width_min, p.width_max)

    traces = extract_trace_skeleton(
        binary.astype(np.float32),
        threshold=0.5,
        bridge_px=0,  # bridging already applied above (same op, once)
        min_len=max(2, int(p.min_len)),
        score_map=strength,
        width_map=dist,
        width_range=width_range,
    )

    # Outlines: v1 contour polylines of the cleaned mask — the "what did my
    # threshold capture" preview the user tunes against.
    outlines = extract_trace_polylines(
        binary.astype(np.float32),
        threshold=0.5,
        epsilon=1.5,
        min_len=max(6, int(p.min_len) // 2),
        max_polylines=max(1, int(p.max_outlines)),
    )
    return {
        "traces": traces,
        "outlines": [o["points"] for o in outlines],
        "width": int(w),
        "height": int(h),
    }
