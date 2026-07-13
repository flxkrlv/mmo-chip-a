#!/usr/bin/env bash
set -e
cd ~/mmo-chip-a
export SYCL_CACHE_PERSISTENT=1
ml/.venv/bin/python ml/train.py \
  --data data/ml_exports/lv2-16-2026-07-12T17-15-58-164Z \
  --epochs 100 \
  --batch-size 8 \
  --steps-per-epoch 100 \
  --output checkpoints/model.pt \
  --device xpu
