"""Sliding-window inference for big die shots. Stitches per-tile heatmaps with cosine blending."""
from __future__ import annotations

from typing import Callable

import numpy as np
import torch


def _cosine_window(size: int) -> np.ndarray:
    x = np.arange(size, dtype=np.float32)
    w1d = np.sin(np.pi * (x + 0.5) / size) ** 2
    w = np.outer(w1d, w1d).astype(np.float32)
    return w + 1e-3  # avoid zero divide at corners


def tile_predict(model: torch.nn.Module,
                 image_rgb: np.ndarray,
                 tile_size: int = 512,
                 overlap: int = 64,
                 device: str = "cpu",
                 batch_size: int = 4,
                 normalize: Callable[[np.ndarray], torch.Tensor] | None = None) -> np.ndarray:
    """Returns a sigmoid-activated heatmap with the same HxW as ``image_rgb``.

    image_rgb: HxWx3 uint8 (RGB).
    normalize: callable mapping a HxWx3 uint8 tile -> CHW float tensor (matched to training).
    """
    assert normalize is not None, "must pass a normalize() callable"
    assert image_rgb.ndim == 3 and image_rgb.shape[2] == 3
    assert overlap < tile_size

    model.eval()
    h, w = image_rgb.shape[:2]
    stride = tile_size - overlap

    pad_h = max(tile_size - h, 0)
    pad_w = max(tile_size - w, 0)
    if h > tile_size:
        pad_h = (stride - (h - tile_size) % stride) % stride
    if w > tile_size:
        pad_w = (stride - (w - tile_size) % stride) % stride

    padded = np.pad(image_rgb, ((0, pad_h), (0, pad_w), (0, 0)), mode="reflect")
    H, W = padded.shape[:2]

    win = _cosine_window(tile_size)
    weight = np.zeros((H, W), dtype=np.float32)
    out: np.ndarray | None = None  # (C,H,W), lazily sized from the model

    coords: list[tuple[int, int]] = []
    for y in range(0, H - tile_size + 1, stride):
        for x in range(0, W - tile_size + 1, stride):
            coords.append((x, y))

    with torch.no_grad():
        for i in range(0, len(coords), batch_size):
            chunk = coords[i:i + batch_size]
            tiles = [padded[y:y + tile_size, x:x + tile_size] for (x, y) in chunk]
            batch = torch.stack([normalize(t) for t in tiles]).to(device)
            preds = torch.sigmoid(model(batch)).cpu().numpy()  # (B, C, H, W)
            if out is None:
                out = np.zeros((preds.shape[1], H, W), dtype=np.float32)
            for (x, y), pred in zip(chunk, preds):  # pred: (C,H,W)
                out[:, y:y + tile_size, x:x + tile_size] += pred * win
                weight[y:y + tile_size, x:x + tile_size] += win

    assert out is not None, "no tiles produced"
    stitched = out / np.maximum(weight, 1e-6)  # (C,H,W)
    return stitched[:, :h, :w]
