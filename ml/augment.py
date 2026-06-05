"""Albumentations pipelines. Vias are D4-invariant and roughly rotation-invariant; augment heavily."""
from __future__ import annotations

import albumentations as A
import cv2
from albumentations.pytorch import ToTensorV2

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def train_augmentations(crop_size: int = 256) -> A.Compose:
    return A.Compose(
        [
            A.RandomScale(scale_limit=0.5, p=0.5),
            A.PadIfNeeded(min_height=crop_size, min_width=crop_size,
                          border_mode=cv2.BORDER_REFLECT_101),
            A.RandomCrop(height=crop_size, width=crop_size),
            A.HorizontalFlip(p=0.5),
            A.VerticalFlip(p=0.5),
            A.RandomRotate90(p=0.5),
            A.RandomBrightnessContrast(brightness_limit=0.2, contrast_limit=0.2, p=0.5),
            A.HueSaturationValue(hue_shift_limit=10, sat_shift_limit=20, val_shift_limit=10, p=0.3),
            A.GaussNoise(p=0.3),
            A.GaussianBlur(blur_limit=(3, 5), p=0.2),
            A.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
            ToTensorV2(),
        ],
        keypoint_params=A.KeypointParams(format="xy", remove_invisible=True),
    )


def normalize_only() -> A.Compose:
    """For inference tiles."""
    return A.Compose([
        A.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
        ToTensorV2(),
    ])
