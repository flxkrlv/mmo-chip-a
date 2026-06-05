"""Debug viz: for each training ROI, dump [image | RGB target | overlay].

Reuses the EXACT training target path (dataset._parse + heatmap.render_heatmap
+ the same sigma formula as AnnotationDataset.__getitem__), with NO
augmentation — so what you see is precisely what the model is trained on.
RGB target channels: R = point_via, G = irregular_via, B = trace.

Run:
    python visualize_targets.py --data ../data/ml_exports --out vis/targets
    python visualize_targets.py --data ../data/ml_exports --filter nikpa40x-66p --limit 12
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from pathlib import Path

import cv2
import numpy as np

from dataset import _parse
from heatmap import render_heatmap

IMG_EXTS = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp")


def _find_image(json_path: str) -> str | None:
    base = os.path.splitext(json_path)[0]
    for ext in IMG_EXTS:
        if os.path.exists(base + ext):
            return base + ext
    return None


def _label_bar(width: int, lines: list[str], height: int = 64) -> np.ndarray:
    bar = np.full((height, width, 3), 30, np.uint8)
    for i, ln in enumerate(lines):
        cv2.putText(bar, ln, (8, 20 + i * 20), cv2.FONT_HERSHEY_SIMPLEX,
                    0.45, (230, 230, 230), 1, cv2.LINE_AA)
    return bar


def build_panel(image_bgr: np.ndarray, meta: dict) -> np.ndarray:
    h, w = image_bgr.shape[:2]
    pv_points, region, trace, _ignore = _parse(meta, (h, w))

    # EXACT training sigma (mirrors AnnotationDataset.__getitem__).
    sigma = max(1.0, float(meta.get("ml_config", {}).get("point_via_size", 6)) * 0.5)
    ch0 = render_heatmap(pv_points, (h, w), sigma=sigma)  # float 0..1

    rgb = np.stack([
        np.clip(ch0 * 255.0, 0, 255),
        region.astype(np.float32) * 255.0,
        trace.astype(np.float32) * 255.0,
    ], axis=-1).astype(np.uint8)               # RGB (R=pv, G=iv, B=trace)
    mask_bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    overlay = cv2.addWeighted(image_bgr, 0.55, mask_bgr, 0.65, 0)

    sep = np.full((h, 3, 3), 60, np.uint8)
    body = np.hstack([image_bgr, sep, mask_bgr, sep, overlay])

    mc = meta.get("ml_config", {})
    n_pv = len(pv_points)
    n_iv = sum(1 for a in meta.get("annotations", []) if a.get("class") == "irregular_via")
    n_tr = sum(1 for a in meta.get("annotations", []) if a.get("class") == "trace")
    bar = _label_bar(body.shape[1], [
        f"point_via_size={mc.get('point_via_size'):.2f}  -> sigma={sigma:.2f}px"
        f"   trace_width={mc.get('trace_width', '?')}",
        f"roi_classes={meta.get('roi_classes')}   "
        f"counts: point_via={n_pv} irregular_via={n_iv} trace_seg={n_tr}  "
        f"[ image | RGB target R=pv G=iv B=trace | overlay ]",
    ])
    return np.vstack([bar, body])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="dir with roi_*.json (recursive)")
    ap.add_argument("--out", default="vis/targets")
    ap.add_argument("--filter", default=None, help="only folders whose name contains this")
    ap.add_argument("--limit", type=int, default=0, help="max images per folder (0=all)")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.data, "**", "roi_*.json"), recursive=True))
    Path(args.out).mkdir(parents=True, exist_ok=True)
    per_folder: dict[str, int] = {}
    written = 0
    for jp in files:
        folder = os.path.basename(os.path.dirname(jp))
        if args.filter and args.filter not in folder:
            continue
        if args.limit and per_folder.get(folder, 0) >= args.limit:
            continue
        img_path = _find_image(jp)
        if img_path is None:
            continue
        meta = json.loads(Path(jp).read_text())
        if "annotations" not in meta:
            print(f"[skip] {jp} is not a v2 manifest")
            continue
        image = cv2.imread(img_path, cv2.IMREAD_COLOR)
        if image is None:
            continue
        panel = build_panel(image, meta)
        name = f"{folder}__{os.path.splitext(os.path.basename(jp))[0]}.png"
        cv2.imwrite(os.path.join(args.out, name), panel)
        per_folder[folder] = per_folder.get(folder, 0) + 1
        written += 1
    print(f"wrote {written} panels to {args.out}")
    for k in sorted(per_folder):
        print(f"  {per_folder[k]:>4}  {k}")


if __name__ == "__main__":
    main()
