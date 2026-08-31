@echo off
cd /d "E:\mmo_workdir\mmo-chip-a"
ml\.venv\Scripts\python.exe ml/train.py ^
  --data data/ml_exports/06x19-2026-07-20T12-50-20-808Z ^
  --epochs 50 ^
  --batch-size 4 ^
  --steps-per-epoch 50 ^
  --crop-size 128 ^
  --output checkpoints/via12_model.pt ^
  --device cuda
pause
