#!/usr/bin/env bash
set -e
# setup_ml.sh — Create Python venv + install ML dependencies for mmo-chip-a sidecar.
# Run from repo root after `git clone` and `npm install`.
# Usage: bash scripts/setup_ml.sh

cd "$(dirname "$0")/.."

echo "=== ML sidecar setup ==="

# Check Python
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done
if [ -z "$PYTHON" ]; then
    echo "ERROR: Python not found. Install Python 3.10+ first."
    exit 1
fi
echo "Python: $($PYTHON --version)"

# Create venv
if [ -d "ml/.venv" ]; then
    echo "venv already exists at ml/.venv — skipping creation"
else
    echo "Creating venv..."
    $PYTHON -m venv ml/.venv
fi

# Install dependencies
echo "Installing dependencies (this may take a while)..."
ml/.venv/bin/pip install -r ml/requirements.txt

echo ""
echo "=== Done ==="
echo "Run 'npm run sidecar' to start the ML sidecar."
echo ""
echo "For Intel Arc GPU acceleration on Linux:"
echo "  Install Intel GPU drivers: https://dgpu-docs.intel.com/"
echo "  Then: ml/.venv/bin/pip install intel-extension-for-pytorch"
echo "  Or use PyTorch XPU: the sidecar will detect xpu device automatically."
