"""Offline tests for the classical vectorize decoder (no model needed).

Run directly:
    python test_vectorize.py
or via pytest later — plain asserts + a main() that exits nonzero.
"""
from __future__ import annotations

import sys

import cv2
import numpy as np

from vectorize import VectorParams, vectorize_region


def _blank(h: int = 120, w: int = 200) -> np.ndarray:
    return np.zeros((h, w, 3), dtype=np.uint8)


def test_empty_image_decodes_to_empty() -> None:
    r = vectorize_region(_blank(), VectorParams(thresh_low=150))
    assert r["traces"] == [] and r["outlines"] == []


def test_band_threshold_selects_bright_metal() -> None:
    img = _blank()
    img[30:34, 10:180] = 200  # bright wire
    img[70:74, 10:180] = 60   # dim wire — outside the band
    p = VectorParams(thresh_low=150, min_len=14, width_min=1.5, width_max=12)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"expected 1 trace, got {len(r['traces'])}"
    ys = {pt[1] for pt in r["traces"][0]["points"]}
    assert all(30 <= y <= 33 for y in ys), f"wrong wire: {sorted(ys)}"


def test_invert_selects_dark_metal() -> None:
    img = np.full((120, 200, 3), 220, dtype=np.uint8)
    img[30:34, 10:180] = 40  # dark wire on bright field
    p = VectorParams(invert=True, thresh_low=100, min_len=14, width_min=1.5, width_max=12)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"expected 1 trace, got {len(r['traces'])}"


def test_width_filter_drops_fat_blobs() -> None:
    img = _blank()
    img[30:34, 10:180] = 200                       # 4 px wire
    cv2.rectangle(img, (40, 80), (55, 95), 210, -1)  # 16×16 pad blob
    p = VectorParams(thresh_low=150, min_len=8, width_min=1.5, width_max=12)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"pad survived: {[(len(t['points']), t.get('width')) for t in r['traces']]}"
    assert r["traces"][0]["width"] <= 12


def test_min_len_drops_specks() -> None:
    # NB: min_len measures the degree-2 corridor BETWEEN node pixels — the
    # node pixels at a wire's free ends don't count, so a straight bar's
    # usable length is ~4 px shorter than its mask length.
    img = _blank()
    img[30:34, 10:180] = 200    # long wire (~170 px)
    img[90:94, 40:60] = 200     # 20 px speck (corridor ~15 px)
    p_long = VectorParams(thresh_low=150, min_len=40, width_min=0)
    r = vectorize_region(img, p_long)
    assert len(r["traces"]) == 1, f"speck survived min_len=40: {len(r['traces'])} traces"
    p_short = VectorParams(thresh_low=150, min_len=10, width_min=0)
    r2 = vectorize_region(img, p_short)
    assert len(r2["traces"]) == 2, f"expected wire + speck: {len(r2['traces'])}"


def test_bridging_connects_gapped_wire() -> None:
    img = _blank()
    img[30:34, 10:100] = 200
    img[30:34, 105:190] = 200  # 5 px gap — wider than the default 2 bridge
    p = VectorParams(thresh_low=150, min_len=20, width_min=0, bridge_px=3)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1, f"gap not bridged: {len(r['traces'])} traces"
    p0 = VectorParams(thresh_low=150, min_len=20, width_min=0, bridge_px=0)
    r0 = vectorize_region(img, p0)
    assert len(r0["traces"]) == 2, "bridge_px=0 should still split at the gap"


def test_colour_channel_selection() -> None:
    img = _blank()
    img[30:34, 10:180, 1] = 220  # green-only wire
    img[60:64, 10:180, 0] = 220  # red-only wire
    p = VectorParams(channel="g", thresh_low=150, min_len=14, width_min=0)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1
    ys = {pt[1] for pt in r["traces"][0]["points"]}
    assert all(30 <= y <= 33 for y in ys), "picked the red wire with channel=g"


def test_adaptive_mode_runs_on_gradient_lighting() -> None:
    # Uneven illumination: a global band can't fit both sides at once.
    x = np.linspace(40, 200, 200, dtype=np.float32)
    grad = np.tile(x, (120, 1))
    img = np.stack([grad] * 3, axis=-1).astype(np.uint8)
    img[30:34, :] = 255  # wire brighter than its local background everywhere
    p = VectorParams(adaptive=True, adaptive_block=51, adaptive_c=8,
                     min_len=14, width_min=0)
    r = vectorize_region(img, p)
    assert len(r["traces"]) >= 1, "adaptive threshold lost the wire"


def test_reports_per_trace_width_and_score() -> None:
    img = _blank()
    img[30:36, 10:180] = 230  # 6 px wire
    p = VectorParams(thresh_low=150, min_len=14, width_min=0)
    r = vectorize_region(img, p)
    assert len(r["traces"]) == 1
    t = r["traces"][0]
    assert 4 <= t["width"] <= 8, f"width estimate off: {t['width']}"
    assert 0.0 < t["score"] <= 1.0


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"ok   {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
