"""Inference on a full die shot. Produces heatmap, overlay, and points JSON.

Example:
    python predict.py --image ../data/dies/some_die.png \
        --checkpoint checkpoints/model.pt \
        --out-overlay vis/overlay.png \
        --out-points vis/points.json
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

# Big die shots can exceed OpenCV's default 2^30 pixel ceiling. Must be set before `import cv2`.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(2**40))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

from augment import normalize_only
from heatmap import extract_components, extract_peaks, extract_trace_polylines
from model import build_model, infer_num_classes
from tiling import tile_predict


def auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def make_normalize():
    tf = normalize_only()

    def _norm(tile_uint8_rgb: np.ndarray) -> torch.Tensor:
        out = tf(image=tile_uint8_rgb)
        return out["image"]

    return _norm


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--checkpoint", default="checkpoints/model.pt")
    parser.add_argument("--out-heatmap", default=None, help="grayscale PNG of stitched heatmap")
    parser.add_argument("--out-overlay", default=None, help="image with detected via markers")
    parser.add_argument("--out-points", default=None, help="JSON with detected points + scores")
    parser.add_argument("--tile-size", type=int, default=512)
    parser.add_argument("--overlap", type=int, default=64)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--min-distance", type=int, default=3,
                        help="min pixel distance between detected peaks")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    device = args.device or auto_device()
    print(f"device: {device}")

    ckpt = torch.load(args.checkpoint, map_location=device, weights_only=True)
    n_classes = infer_num_classes(ckpt["model_state"])
    model = build_model(encoder_name=ckpt.get("encoder", "resnet18"),
                        encoder_weights=None, classes=n_classes).to(device)
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    print(f"checkpoint: {n_classes} class(es)")

    image_bgr = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if image_bgr is None:
        raise FileNotFoundError(args.image)
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    print(f"image: {image_rgb.shape[1]}x{image_rgb.shape[0]}")

    maps = tile_predict(
        model,
        image_rgb,
        tile_size=args.tile_size,
        overlap=args.overlap,
        device=device,
        batch_size=args.batch_size,
        normalize=make_normalize(),
    )  # (C, H, W): C=1 (vias-only model) or C=3 (point_via, irregular_via, trace)

    print("prediction done")

    n_ch = maps.shape[0]
    ch0 = maps[0]
    ch1 = maps[1] if n_ch >= 2 else None
    ch2 = maps[2] if n_ch >= 3 else None

    peaks = extract_peaks(ch0, threshold=args.threshold, min_distance=args.min_distance)
    print(f"detected {len(peaks)} point_via (threshold={args.threshold})")
    regions = extract_components(ch1, threshold=args.threshold) if ch1 is not None else []
    traces = extract_trace_polylines(ch2, threshold=args.threshold) if ch2 is not None else []
    if n_ch >= 3:
        print(f"detected {len(regions)} irregular_via, {len(traces)} trace polylines "
              f"(threshold={args.threshold})")
    else:
        print(f"(1-class checkpoint — point_via only)")

    if args.out_heatmap:
        Path(args.out_heatmap).parent.mkdir(parents=True, exist_ok=True)
        zeros = np.zeros_like(ch0)
        rgb = np.stack([
            np.clip(ch0 * 255, 0, 255),
            np.clip((ch1 if ch1 is not None else zeros) * 255, 0, 255),
            np.clip((ch2 if ch2 is not None else zeros) * 255, 0, 255),
        ], axis=-1).astype(np.uint8)
        cv2.imwrite(args.out_heatmap, cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))

    if args.out_overlay:
        Path(args.out_overlay).parent.mkdir(parents=True, exist_ok=True)
        overlay = image_bgr.copy()
        for x, y, _ in peaks:
            cv2.circle(overlay, (x, y), 4, (0, 0, 255), cv2.FILLED)
        for r in regions:
            x, y, w_, h_ = r["bbox"]
            cv2.rectangle(overlay, (x, y), (x + w_, y + h_), (0, 255, 0), 1)
        for t in traces:
            pts = np.array(t, dtype=np.int32).reshape(-1, 1, 2)
            cv2.polylines(overlay, [pts], False, (255, 0, 0), 1)
        cv2.imwrite(args.out_overlay, overlay)

    if args.out_points:
        Path(args.out_points).parent.mkdir(parents=True, exist_ok=True)
        with open(args.out_points, "w") as f:
            json.dump({
                "image": args.image,
                "point_vias": [{"x": x, "y": y, "score": s} for x, y, s in peaks],
                "irregular_vias": regions,
                "traces": traces,
                "threshold": args.threshold,
            }, f, indent=2)


if __name__ == "__main__":
    main()
