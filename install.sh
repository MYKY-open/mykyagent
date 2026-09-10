#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Installing MykyAgent ==="

# 1. Check Node.js
if ! command -v node &>/dev/null; then
    echo "Error: Node.js is required. Please install Node.js (v18+) first." >&2
    exit 1
fi

# 2. Check/install uv
if ! command -v uv &>/dev/null; then
    echo "Installing uv (fast python runner)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

# 3. Check/install pi
if ! command -v pi &>/dev/null; then
    echo "Installing @earendil-works/pi-coding-agent..."
    npm install -g @earendil-works/pi-coding-agent
fi

# 4. Setup models.json if missing
PI_CONFIG_DIR="$HOME/.pi/agent"
mkdir -p "$PI_CONFIG_DIR"
MODELS_FILE="$PI_CONFIG_DIR/models.json"

if [ ! -f "$MODELS_FILE" ]; then
    echo "Creating default ~/.pi/agent/models.json with llama-local provider..."
    cat > "$MODELS_FILE" <<'JSON'
{
  "providers": {
    "llama-local": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "cannotguess",
      "models": [
        {
          "id": "ling-3.0-tiny-Q4_K_M",
          "name": "Local: ling-3.0-tiny-Q4_K_M",
          "contextWindow": 131072,
          "maxTokens": 65536
        }
      ]
    }
  }
}
JSON
else
    echo "Found existing ~/.pi/agent/models.json."
fi

# 5. Symlink launcher into ~/.local/bin
INSTALL_BIN="$HOME/.local/bin"
mkdir -p "$INSTALL_BIN"
chmod +x "$SCRIPT_DIR/bin/mykyagent"
ln -sf "$SCRIPT_DIR/bin/mykyagent" "$INSTALL_BIN/mykyagent"

echo "=== MykyAgent Installed Successfully ==="
echo "Launcher symlinked to: $INSTALL_BIN/mykyagent"
echo "Make sure $INSTALL_BIN is in your PATH."
echo ""
echo "Test with: mykyagent --help"
