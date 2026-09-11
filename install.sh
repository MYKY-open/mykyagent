#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_BIN="${INSTALL_BIN:-$HOME/.local/bin}"
PI_DIR="${PI_DIR:-$HOME/mykysw/pi}"

echo "=== Checking MykyAgent Prerequisites ==="
MISSING_DEPS=0

# 1. Check Node.js
if command -v node &>/dev/null; then
    NODE_VER="$(node -v)"
    echo "  [OK] Node.js is installed ($NODE_VER)"
else
    echo "  [MISSING] Node.js (v18+) is required but not found."
    echo "            Install via your package manager (e.g., sudo apt install nodejs / sudo pacman -S nodejs)"
    MISSING_DEPS=$((MISSING_DEPS + 1))
fi

# 2. Check Pi coding agent
if command -v pi &>/dev/null; then
    echo "  [OK] pi is installed in PATH ($(command -v pi))"
elif [ -x "$PI_DIR/node_modules/.bin/pi" ]; then
    echo "  [OK] pi found in $PI_DIR/node_modules/.bin/pi"
elif [ -x "$SCRIPT_DIR/node_modules/.bin/pi" ]; then
    echo "  [OK] pi found in local node_modules"
else
    echo "  [MISSING] @earendil-works/pi-coding-agent is not found."
    echo "            Install with: npm install -g @earendil-works/pi-coding-agent"
    MISSING_DEPS=$((MISSING_DEPS + 1))
fi

# 3. Check uv (optional / recommended for web search helper)
if command -v uv &>/dev/null; then
    UV_VER="$(uv --version 2>/dev/null | head -n1)"
    echo "  [OK] uv is installed ($UV_VER)"
else
    echo "  [OPTIONAL] uv is recommended for web search distillation & GGUF probing."
    echo "             Install via: https://docs.astral.sh/uv/getting-started/installation/"
fi

# 4. Pre-install Playwright Chromium browser (for JS-rendered page support in web_search/web_fetch)
if command -v uv &>/dev/null; then
    echo ""
    echo "=== Pre-installing Playwright Chromium Browser ==="
    if uv run --with "playwright>=1.47.0" python3 -m playwright install chromium 2>/dev/null; then
        echo "  [OK] Playwright Chromium ready"
    else
        echo "  [WARN] Could not pre-install Playwright Chromium."
        echo "         It will auto-install silently on first web_search/web_fetch use."
    fi
fi

echo ""
echo "=== Setting Up Launchers ==="
mkdir -p "$INSTALL_BIN"

chmod +x "$SCRIPT_DIR/bin/mykyagent"
ln -sf "$SCRIPT_DIR/bin/mykyagent" "$INSTALL_BIN/mykyagent"
echo "  [LINK] $INSTALL_BIN/mykyagent -> $SCRIPT_DIR/bin/mykyagent"

echo ""
if [[ ":$PATH:" != *":$INSTALL_BIN:"* ]]; then
    echo "Warning: $INSTALL_BIN is not in your PATH."
    echo "Add it to your shell config (~/.bashrc or ~/.zshrc):"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
fi

if [ "$MISSING_DEPS" -gt 0 ]; then
    echo "=== Status: Incomplete Prerequisites ==="
    echo "Please install the missing dependencies listed above, then start MykyAgent."
    exit 1
else
    echo "=== Status: Ready ==="
    echo "Start MykyAgent with: mykyagent"
    echo "Or launch via the 'llm' orchestrator menu (Mode 12: MykyAgent)."
fi
