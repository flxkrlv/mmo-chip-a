#!/usr/bin/env bash
set -e
# setup_ml.sh — Create Python venv + install ML dependencies for mmo-chip-a sidecar.
# Usage: bash scripts/setup_ml.sh

cd "$(dirname "$0")/.."
ROOT="$PWD"

echo "=== ML sidecar setup ==="

# --- Find Python ---
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

# --- Ensure venv module is available ---
if ! $PYTHON -c "import venv" 2>/dev/null; then
    echo "python3-venv not found — attempting to install..."
    if command -v apt &>/dev/null; then
        sudo apt install -y python3-venv
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y python3-virtualenv
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm python-virtualenv
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y python311-venv
    else
        echo "ERROR: Cannot install python3-venv automatically."
        echo "Install python3-venv manually, then re-run this script."
        exit 1
    fi
fi

# --- Create or repair venv ---
if [ -d "ml/.venv" ]; then
    if [ ! -f "ml/.venv/bin/pip" ] && [ ! -f "ml/.venv/Scripts/pip" ]; then
        echo "venv exists but is broken (no pip) — recreating..."
        rm -rf ml/.venv
    else
        echo "venv already exists at ml/.venv"
    fi
fi

if [ ! -d "ml/.venv" ]; then
    echo "Creating venv..."
    $PYTHON -m venv ml/.venv
fi

# --- Determine pip path ---
if [ -f "ml/.venv/bin/pip" ]; then
    PIP="ml/.venv/bin/pip"
elif [ -f "ml/.venv/Scripts/pip" ]; then
    PIP="ml/.venv/Scripts/pip"
else
    echo "ERROR: pip not found in venv"
    exit 1
fi

# --- Upgrade pip ---
echo "Upgrading pip..."
$PIP install --upgrade pip

# --- Detect GPU type ---
HAS_NVIDIA=0
if $PYTHON -c "import ctypes; ctypes.CDLL('libcuda.so.1')" 2>/dev/null && command -v nvidia-smi &>/dev/null; then
    HAS_NVIDIA=1
fi
HAS_INTEL_ARC=0
if lspci 2>/dev/null | grep -qiE "Intel.*(Arc|DG[2-9])"; then
    HAS_INTEL_ARC=1
fi

# --- Install Intel GPU drivers if Arc detected ---
if [ "$HAS_INTEL_ARC" -eq 1 ]; then
    echo "Intel Arc GPU detected — checking drivers..."
    if ! dpkg -l intel-level-zero-gpu &>/dev/null 2>&1; then
        echo "Installing Intel GPU compute drivers..."
        if command -v apt &>/dev/null; then
            sudo apt install -y ca-certificates wget
            wget -qO - https://repositories.intel.com/gpu/intel-graphics.key | \
                sudo gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg 2>/dev/null
            echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble client" | \
                sudo tee /etc/apt/sources.list.d/intel-gpu.list >/dev/null
            sudo apt update
            sudo apt install -y intel-opencl-icd intel-level-zero-gpu level-zero
        else
            echo "WARNING: cannot install Intel GPU drivers automatically."
            echo "See: https://dgpu-docs.intel.com/"
        fi
    fi
fi

# --- Install dependencies ---
echo "Installing ML dependencies (this may take a while)..."
# Non-torch packages first
$PIP install opencv-contrib-python-headless numpy scipy pillow tqdm fastapi uvicorn python-multipart

if [ "$HAS_NVIDIA" -eq 1 ]; then
    echo "NVIDIA CUDA GPU detected — installing CUDA PyTorch"
    $PIP install -r ml/requirements.txt
elif [ "$HAS_INTEL_ARC" -eq 1 ]; then
    echo "Intel Arc GPU detected — installing XPU PyTorch 2.6 + IPEX"
    $PIP install torch==2.6.0+xpu torchvision==0.21.0+xpu \
        --index-url https://download.pytorch.org/whl/xpu
    $PIP install intel-extension-for-pytorch==2.6.0
    $PIP install segmentation-models-pytorch albumentations
else
    echo "No supported GPU detected — installing CPU-only PyTorch"
    $PIP install torch torchvision --index-url https://download.pytorch.org/whl/cpu
    $PIP install segmentation-models-pytorch albumentations
fi

echo ""
echo "=== Done ==="
echo "Run 'npm run dev' or 'npm run sidecar' to start the ML sidecar."
