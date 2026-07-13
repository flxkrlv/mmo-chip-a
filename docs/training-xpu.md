# Training on Linux + Intel Arc (XPU)

## Setup

```bash
bash scripts/setup_ml.sh
```

Auto-detects Intel Arc GPU, installs drivers (if missing), and sets up the venv with XPU PyTorch.

## Train

```bash
ml/.venv/bin/python ml/train.py \
  --data data/ml_exports/<export_dir> \
  --epochs 200 \
  --batch-size 8 \
  --lr 1e-3 \
  --crop-size 256 \
  --steps-per-epoch 100 \
  --encoder resnet18 \
  --encoder-weights none \
  --num-workers 2 \
  --device xpu \
  --output checkpoints/model.pt
```

Or use the convenience script:

```bash
bash train_last_export.sh
```

## Key parameters

| Param | Default | Note |
|-------|---------|------|
| `--encoder-weights` | `imagenet` | Use `none` for PCB/via domains — ImageNet features don't transfer |
| `--device` | auto | Intel Arc → `xpu`, NVIDIA → `cuda`, fallback → `cpu` |
| `--num-workers` | 0 | Set to 2–4 on Linux (safe with multiprocessing) |

## Model symlink

`ml/checkpoints/model.pt` → `checkpoints/model.pt` — sidecar resolves via `ML_DIR`, so both locations stay in sync.

## Transfer model to another PC

The `model.pt` file is self-contained (state_dict + metadata). Copy it and place at `checkpoints/model.pt`:

```bash
scp user@source-pc:~/mmo-chip-a/checkpoints/model.pt checkpoints/
```

On the target machine, start the sidecar pointing to the checkpoint, or just `npm run sidecar` (default path).
