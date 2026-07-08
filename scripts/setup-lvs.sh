#!/usr/bin/env bash
set -e
# setup-lvs.sh — Install vyges-lvs on Linux/macOS
# Run from repo root after `git clone` and `npm install`.

echo "=== vyges-lvs setup ==="

if command -v vyges-lvs &>/dev/null; then
    echo "vyges-lvs already installed at: $(which vyges-lvs)"
    exit 0
fi

# Try downloading prebuilt binary (Linux x86_64, macOS aarch64)
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

case "$OS-$ARCH" in
    linux-x86_64|linux-amd64)
        BIN="vyges-lvs-x86_64-unknown-linux-gnu.tar.gz" ;;
    darwin-arm64|darwin-aarch64)
        BIN="vyges-lvs-aarch64-apple-darwin.tar.gz" ;;
    darwin-x86_64)
        BIN="vyges-lvs-x86_64-apple-darwin.tar.gz" ;;
    linux-aarch64|linux-arm64)
        BIN="vyges-lvs-aarch64-unknown-linux-gnu.tar.gz" ;;
    *)
        echo "No prebuilt binary for $OS-$ARCH. Building from source..." ;;
esac

if [ -n "$BIN" ]; then
    echo "Downloading prebuilt binary: $BIN"
    URL="https://github.com/vyges-tools/lvs/releases/download/v0.1.11/$BIN"
    curl -sL "$URL" -o /tmp/vyges-lvs.tar.gz
    tar xzf /tmp/vyges-lvs.tar.gz -C /tmp/
    mkdir -p "$HOME/.local/bin"
    cp /tmp/vyges-lvs "$HOME/.local/bin/"
    echo "Installed to $HOME/.local/bin/vyges-lvs"
    echo 'Add to PATH: export PATH="$HOME/.local/bin:$PATH"'
    exit 0
fi

# Build from source
if ! command -v cargo &>/dev/null; then
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
    . "$HOME/.cargo/env"
fi

echo "Building vyges-lvs from source (3-10 minutes)..."
cargo install --git https://github.com/vyges-tools/lvs

echo "=== Setup complete ==="
echo "vyges-lvs is ready. Start the backend with: cd backend && npm run dev"
