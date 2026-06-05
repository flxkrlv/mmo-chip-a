"""Multi-class U-Net.

3 sigmoid channels (independent, NOT softmax — overlap is legal):
  0 = point_via   (peak)
  1 = irregular_via (region)
  2 = trace        (skeleton-decoded mask)
"""
from __future__ import annotations

import segmentation_models_pytorch as smp
import torch.nn as nn

NUM_CLASSES = 3  # keep in sync with shared CLASS_REGISTRY


def build_model(encoder_name: str = "resnet18",
                encoder_weights: str | None = "imagenet",
                classes: int = NUM_CLASSES) -> nn.Module:
    return smp.Unet(
        encoder_name=encoder_name,
        encoder_weights=encoder_weights,
        in_channels=3,
        classes=classes,
        activation=None,
    )


def infer_num_classes(state_dict: dict) -> int:
    """Read the output channel count straight off a checkpoint's state_dict.

    Lets inference run any checkpoint (old 1-class vias model OR a 3-class
    model) without a flag — build a model with the matching head. smp.Unet's
    final conv is `segmentation_head.0.{weight,bias}` with out-channels =
    number of classes.
    """
    for key in ("segmentation_head.0.bias", "segmentation_head.0.weight"):
        if key in state_dict:
            return int(state_dict[key].shape[0])
    # Fallback: last named weight tensor's out-channel dim.
    for k in reversed(list(state_dict.keys())):
        t = state_dict[k]
        if "weight" in k and hasattr(t, "ndim") and t.ndim >= 1:
            return int(t.shape[0])
    raise ValueError("could not infer num classes from checkpoint state_dict")
