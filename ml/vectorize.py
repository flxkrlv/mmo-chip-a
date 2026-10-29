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

from heatmap import extract_trace_polylines
from polygon_axis import extract_polygon_axis
from wire_runs import extract_wire_runs

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
    decoder: str = "runs"          # "runs" (skeleton, default) | "octilinear"
    oct_delta_px: float = 0.0      # 0 = auto (max(0.75, width_min/2))
    oct_strict: bool = False       # reserved: hard octilinear mode (L3), not implemented yet


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


def mask_pad_px(p: VectorParams) -> int:
    """Crop padding that makes the mask EXACT inside the core: every op that
    reaches beyond a pixel (morphology kernels, adaptive gaussian block) is
    covered, so block-assembled masks are pixel-identical to a whole-image
    decode — no tile seams by construction."""
    import math
    return max(int(p.open_px), int(p.bridge_px), math.ceil(int(p.adaptive_block) / 2)) + 2


def build_mask(rgb: np.ndarray, p: VectorParams) -> np.ndarray:
    """Threshold → clean: the binary metal mask (uint8 0/1) of the crop."""
    ch = _channel_image(rgb, p.channel)

    # ── Binary metal mask ────────────────────────────────────────────
    if p.adaptive:
        block = max(3, int(p.adaptive_block) | 1)  # force odd
        flag = cv2.THRESH_BINARY_INV if p.invert else cv2.THRESH_BINARY
        binary = cv2.adaptiveThreshold(
            ch, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, flag, block, max(0, int(p.adaptive_c))
        ) > 0
    else:
        lo = max(0, min(255, int(p.thresh_low)))
        hi = max(lo, min(255, int(p.thresh_high)))
        band = (ch >= lo) & (ch <= hi)
        binary = (~band) if p.invert else band

    if not binary.any():
        return np.zeros(binary.shape, dtype=np.uint8)

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
    return bin_u8


def decode_mask(mask_u8: np.ndarray, p: VectorParams) -> dict:
    """Runs decode of a binary mask: traces (grouped) + outlines + stats."""
    h, w = mask_u8.shape[:2]
    if not mask_u8.any():
        return _empty(w, h)
    binary = mask_u8.astype(bool)

    # Width map: distance transform of the mask ×2 — every pixel's value is
    # then the local wire width (distance-to-edge ≈ half width).
    dist = cv2.distanceTransform(mask_u8, cv2.DIST_L2, 3) * 2.0

    # Strength = depth inside the band — a cheap score proxy the client's
    # existing trace-confidence slider can filter on.
    lo = max(0, min(255, int(p.thresh_low)))
    hi = max(lo, min(255, int(p.thresh_high)))
    lo_f, hi_f = lo / 255.0, max(hi, lo + 1) / 255.0
    # NB: mask-only decode has no channel values; score = 1 inside the mask
    # unless the caller provides strength (live path passes it separately).
    strength = None

    if p.decoder == "octilinear":
        runs = extract_polygon_axis(
            binary.astype(np.float32),
            threshold=0.5,
            min_len=max(2, int(p.min_len)),
            delta_px=float(p.oct_delta_px),
            width_map=dist,
            width_min=p.width_min,
            width_max=p.width_max,
            score_map=strength,
        )
    else:
        runs = extract_wire_runs(
            binary.astype(np.float32),
            threshold=0.5,
            min_len=max(2, int(p.min_len)),
            width_map=dist,
            width_min=p.width_min,
            width_max=p.width_max,
            score_map=strength,
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
        "traces": runs["traces"],
        "outlines": [o["points"] for o in outlines],
        "stats": {
            "kept": runs["stats"]["kept"],
            "dropped_width": runs["stats"]["dropped_width"],
            "dropped_short": runs["stats"]["dropped_short"],
            "merged": runs["stats"]["merged"],
            "irregular": runs["stats"].get("irregular", 0),
        },
        "width": int(w),
        "height": int(h),
    }


def vectorize_region(rgb: np.ndarray, p: VectorParams) -> dict:
    """Threshold → clean → decode. Returns traces + outline polylines in
    crop-local pixel coords (Node translates them to source coords)."""
    h, w = rgb.shape[:2]
    ch = _channel_image(rgb, p.channel)
    mask_u8 = build_mask(rgb, p)
    result = decode_mask(mask_u8, p)
    if result["traces"] or result["outlines"]:
        # Score: depth inside the band — brightness margin per trace.
        if p.adaptive:
            strength_full = ch.astype(np.float32) / 255.0
        else:
            lo = max(0, min(255, int(p.thresh_low)))
            hi = max(lo, min(255, int(p.thresh_high)))
            lo_f, hi_f = lo / 255.0, max(hi, lo + 1) / 255.0
            norm = (ch.astype(np.float32) / 255.0 - lo_f) / (hi_f - lo_f)
            strength_full = np.clip((1.0 - norm) if p.invert else norm, 0.0, 1.0)
        for t in result["traces"]:
            pts = t["points"]
            xs = np.array([pt[0] for pt in pts])
            ys = np.array([pt[1] for pt in pts])
            sel = strength_full[ys, xs]
            t["score"] = round(float(sel.mean()) if sel.size else 0.0, 4)
    result["width"] = int(w)
    result["height"] = int(h)
    return result
