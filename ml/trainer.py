"""Reusable training loop. Shared by the CLI (train.py) and the sidecar /train.

Single source of truth for the loss, dataset wiring and checkpoint format.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import torch
from torch.optim import AdamW
from torch.utils.data import DataLoader, Dataset
from tqdm import tqdm

from augment import train_augmentations
from dataset import AnnotationDataset
from model import build_model


def auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    try:
        import torch_directml
        return str(torch_directml.device())
    except ImportError:
        return "cpu"


# Channel order matches dataset.CLASS_ORDER / shared CLASS_REGISTRY:
#   0 point_via (peak)  1 irregular_via (region)  2 trace (mask)
CH_PEAK = 0
MASK_CHANNELS = (1, 2)
CHANNEL_WEIGHTS = (1.0, 1.0, 1.0)


def _weighted_mse(pred: torch.Tensor, tgt: torch.Tensor, valid: torch.Tensor,
                  pos_weight: float = 10.0) -> torch.Tensor:
    w = (1.0 + pos_weight * tgt) * valid
    sq = (pred - tgt).pow(2) * w
    return sq.sum() / valid.sum().clamp(min=1.0)


def _dice_bce(pred: torch.Tensor, tgt: torch.Tensor, valid: torch.Tensor,
              eps: float = 1e-6) -> torch.Tensor:
    p, t = pred * valid, tgt * valid
    bce = torch.nn.functional.binary_cross_entropy(p.clamp(eps, 1 - eps),
                                                   t, reduction="none")
    bce = (bce * valid).sum() / valid.sum().clamp(min=1.0)
    inter = (p * t).sum()
    dice = pred.new_ones(()) - (2 * inter + eps) / (p.sum() + t.sum() + eps)
    return bce + dice


def multiclass_loss(pred_logits: torch.Tensor, target: torch.Tensor,
                    valid: torch.Tensor) -> torch.Tensor:
    """Per-channel loss with per-channel valid mask.

    pred_logits/target/valid: (B,3,H,W). ch0 = weighted-MSE peak;
    ch1,ch2 = Dice+BCE region/mask. Each masked by its own valid[c].
    """
    pred = torch.sigmoid(pred_logits)
    total = pred.new_zeros(())
    total = total + CHANNEL_WEIGHTS[CH_PEAK] * _weighted_mse(
        pred[:, CH_PEAK], target[:, CH_PEAK], valid[:, CH_PEAK])
    for c in MASK_CHANNELS:
        total = total + CHANNEL_WEIGHTS[c] * _dice_bce(
            pred[:, c], target[:, c], valid[:, c])
    return total


class _Repeat(Dataset):
    """Wrap a small dataset and serve random crops indefinitely (per-epoch budget)."""
    def __init__(self, base: Dataset, length: int):
        self.base = base
        self.length = length

    def __len__(self) -> int:
        return self.length

    def __getitem__(self, idx: int):
        return self.base[idx % len(self.base)]


@dataclass
class TrainParams:
    data_dir: str
    epochs: int = 200
    batch_size: int = 8
    lr: float = 1e-3
    crop_size: int = 256
    steps_per_epoch: int = 100
    encoder: str = "resnet18"
    encoder_weights: str = "imagenet"  # "imagenet" or "none"
    num_workers: int = 0
    output: str = "checkpoints/model.pt"
    device: str | None = None
    seed: int = 42


# Called after each epoch: (epoch_completed, total_epochs, mean_loss).
EpochCallback = Callable[[int, int, float], None]
# Polled between epochs; return True to stop early (cooperative cancel).
StopCallback = Callable[[], bool]


def run_training(params: TrainParams,
                 on_epoch: EpochCallback | None = None,
                 should_stop: StopCallback | None = None,
                 use_tqdm: bool = True) -> Path:
    """Run training to completion (or until should_stop). Returns the checkpoint path.

    Saves the checkpoint every epoch so an interrupted run still leaves the
    latest completed epoch on disk.
    """
    torch.manual_seed(params.seed)
    device = params.device or auto_device()
    print(f"[trainer] device={device} data={params.data_dir}")

    transform = train_augmentations(params.crop_size)
    base = AnnotationDataset(params.data_dir, transform=transform)
    print(f"[trainer] loaded {len(base)} ROIs")

    n = max(1, params.steps_per_epoch * params.batch_size)
    loader = DataLoader(
        _Repeat(base, n),
        batch_size=params.batch_size,
        shuffle=True,
        num_workers=params.num_workers,
        pin_memory=(device == "cuda"),
        drop_last=True,
    )

    encoder_weights = None if params.encoder_weights.lower() == "none" else params.encoder_weights
    model = build_model(encoder_name=params.encoder, encoder_weights=encoder_weights).to(device)
    opt = AdamW(model.parameters(), lr=params.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=params.epochs)

    out_path = Path(params.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    for epoch in range(params.epochs):
        if should_stop is not None and should_stop():
            print(f"[trainer] stop requested at epoch {epoch}")
            break
        model.train()
        running = 0.0
        seen = 0
        iterator = tqdm(loader, desc=f"epoch {epoch + 1}/{params.epochs}") if use_tqdm else loader
        for image, target, valid in iterator:
            image = image.to(device, non_blocking=True)
            target = target.to(device, non_blocking=True)
            valid = valid.to(device, non_blocking=True)
            pred = model(image)
            loss = multiclass_loss(pred, target, valid)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            running += loss.item() * image.size(0)
            seen += image.size(0)
            if use_tqdm:
                iterator.set_postfix(loss=f"{running / max(seen, 1):.4f}",
                                     lr=f"{sched.get_last_lr()[0]:.2e}")
        sched.step()

        mean_loss = running / max(seen, 1)
        torch.save({
            "model_state": model.state_dict(),
            "encoder": params.encoder,
            "crop_size": params.crop_size,
            "epoch": epoch + 1,
        }, out_path)
        if on_epoch is not None:
            on_epoch(epoch + 1, params.epochs, mean_loss)

    return out_path
