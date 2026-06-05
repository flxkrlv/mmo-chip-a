"""
Each exported ROI JSON:
    {
      "source_image": "...",
      "roi_bbox": [x0,y0,x1,y1],
      "roi_classes": ["point_via","irregular_via","trace"],
      "ml_config": {"point_via_size": <px>, "trace_width": <px>},   # already resized
      "annotations": [
        {"class":"point_via",     "geometry":{"kind":"point","x":..,"y":..}},
        {"class":"irregular_via", "geometry":{"kind":"rectangle"|"polygon",...}},
        {"class":"trace",         "geometry":{"kind":"polyline","points":[..]}}
      ],
      "ignore": [{"kind":"rectangle","x":..,"y":..,"width":..,"height":..}]   # optional
    }

Produces, per crop: image, target (3,H,W), valid (3,H,W) — channel order
0=point_via (peak), 1=irregular_via (region), 2=trace (mask). Independent
sigmoids; `valid[c]` is the per-class loss mask (ROI scope minus ignore).
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

from heatmap import render_heatmap

CLASS_ORDER = ("point_via", "irregular_via", "trace")
CH = {name: i for i, name in enumerate(CLASS_ORDER)}


def _pts(points) -> np.ndarray:
    return np.array(
        [[p["x"], p["y"]] if isinstance(p, dict) else [p[0], p[1]] for p in points],
        dtype=np.int32,
    ).reshape(-1, 1, 2)


def _parse(meta: dict, shape: tuple[int, int]):
    """Return (point_via_points, region_mask, trace_mask, ignore_mask)."""
    h, w = shape
    region = np.zeros((h, w), dtype=np.uint8)
    trace = np.zeros((h, w), dtype=np.uint8)
    ignore = np.zeros((h, w), dtype=np.uint8)
    pv_points: list[tuple[float, float]] = []

    tw = max(1, int(round(meta.get("ml_config", {}).get("trace_width", 4))))

    for a in meta.get("annotations", []):
        cls = a.get("class")
        g = a.get("geometry", {})
        kind = g.get("kind")
        if cls == "point_via" and kind == "point":
            pv_points.append((float(g["x"]), float(g["y"])))
        elif cls == "irregular_via" and kind == "rectangle":
            x, y = int(round(g["x"])), int(round(g["y"]))
            cv2.rectangle(region, (x, y),
                          (x + int(round(g["width"])), y + int(round(g["height"]))),
                          1, thickness=-1)
        elif cls == "irregular_via" and kind == "polygon":
            if len(g.get("points", [])) >= 3:
                cv2.fillPoly(region, [_pts(g["points"])], 1)
        elif cls == "trace" and kind == "polyline":
            pts = g.get("points", [])
            if len(pts) >= 2:
                poly = _pts(pts)
                cv2.polylines(trace, [poly], isClosed=False, color=1, thickness=tw)
                # round caps/joins
                r = max(1, tw // 2)
                for p in poly.reshape(-1, 2):
                    cv2.circle(trace, (int(p[0]), int(p[1])), r, 1, thickness=-1)

    for r in meta.get("ignore", []) or []:
        if r.get("kind", "rectangle") in ("rectangle", "rect"):
            x, y = int(round(r["x"])), int(round(r["y"]))
            cv2.rectangle(ignore, (x, y),
                          (x + int(round(r["width"])), y + int(round(r["height"]))),
                          1, thickness=-1)
    return pv_points, region, trace, ignore


class AnnotationDataset(Dataset):
    def __init__(self,
                 data_dir: str | Path,
                 transform,
                 exclude_chips: list[str] | None = None,
                 include_only_chips: list[str] | None = None):
        self.data_dir = Path(data_dir)
        self.transform = transform
        self.samples: list[dict] = []
        if not self.data_dir.exists():
            raise FileNotFoundError(f"Data directory not found: {self.data_dir}")

        exclude = set(exclude_chips or [])
        include = set(include_only_chips) if include_only_chips else None
        skipped_no_image = 0
        chip_counts: dict[str, int] = {}

        for json_path in sorted(self.data_dir.rglob("*.json")):
            image_path = self._find_image(json_path)
            if image_path is None:
                skipped_no_image += 1
                continue
            try:
                meta = json.loads(json_path.read_text())
            except Exception as e:  # noqa: BLE001
                print(f"[warn] bad json {json_path}: {e}")
                continue
            if "annotations" not in meta and "vias" in meta:
                raise RuntimeError(
                    f"{json_path} is an old (v1) export. Re-run ML export "
                    f"with the v2 exporter before training."
                )
            chip = json_path.parent.name if json_path.parent != self.data_dir else "_root"
            if chip in exclude or (include is not None and chip not in include):
                continue
            self.samples.append({"image": image_path, "meta": meta, "chip": chip})
            chip_counts[chip] = chip_counts.get(chip, 0) + 1

        if skipped_no_image:
            print(f"[warn] skipped {skipped_no_image} json with no matching image")
        print(f"[info] {len(self.samples)} ROIs across {len(chip_counts)} chips")
        if not self.samples:
            raise RuntimeError(f"No ROI samples under {self.data_dir}")

    @staticmethod
    def _find_image(json_path: Path) -> Path | None:
        for ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"):
            p = json_path.with_suffix(ext)
            if p.exists():
                return p
        return None

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        s = self.samples[idx]
        meta = s["meta"]
        image = cv2.imread(str(s["image"]), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"Failed to read {s['image']}")
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        h0, w0 = image.shape[:2]

        pv_points, region, trace, ignore = _parse(meta, (h0, w0))

        out = self.transform(
            image=image,
            keypoints=pv_points,
            masks=[region, trace, ignore],
        )
        image_t = out["image"]                       # (3,H,W) float
        kps = out["keypoints"]
        region_t, trace_t, ignore_t = out["masks"]   # each (H,W)

        _, h, w = image_t.shape
        sigma = max(1.0, float(meta.get("ml_config", {}).get("point_via_size", 6)) * 0.5)
        ch0 = render_heatmap(kps, (h, w), sigma=sigma)               # (H,W) float

        region_np = np.asarray(region_t, dtype=np.float32)
        trace_np = np.asarray(trace_t, dtype=np.float32)
        ignore_np = np.asarray(ignore_t, dtype=np.float32)
        target = torch.from_numpy(np.stack([ch0, region_np, trace_np])).float()

        roi_classes = set(meta.get("roi_classes", list(CLASS_ORDER)))
        keep = 1.0 - ignore_np
        valid = np.zeros((3, h, w), dtype=np.float32)
        for name, ci in CH.items():
            if name in roi_classes:
                valid[ci] = keep
        valid_t = torch.from_numpy(valid).float()

        return image_t, target, valid_t
