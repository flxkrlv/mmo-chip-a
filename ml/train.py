"""Train the via heatmap U-Net (CLI).

Thin wrapper over trainer.run_training so the CLI and the sidecar /train
endpoint share one training implementation.

Example:
    python train.py --data ../data/ml_exports --epochs 200
"""
from __future__ import annotations

import argparse

from trainer import TrainParams, run_training


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="dir containing rois/ (recursively)")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--crop-size", type=int, default=256)
    parser.add_argument("--steps-per-epoch", type=int, default=100)
    parser.add_argument("--encoder", default="resnet18")
    parser.add_argument("--encoder-weights", default="imagenet", help="'imagenet' or 'none'")
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--output", default="checkpoints/model.pt")
    parser.add_argument("--device", default=None)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    run_training(TrainParams(
        data_dir=args.data,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        crop_size=args.crop_size,
        steps_per_epoch=args.steps_per_epoch,
        encoder=args.encoder,
        encoder_weights=args.encoder_weights,
        num_workers=args.num_workers,
        output=args.output,
        device=args.device,
        seed=args.seed,
    ))


if __name__ == "__main__":
    main()
