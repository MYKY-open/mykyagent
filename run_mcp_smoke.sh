#!/usr/bin/env bash
# Live smoke test for the MCP adapter (see mcp_smoke.ts).
# Requires: the chrome-devtools-mcp browser bridge target on 127.0.0.1:9222
# (i.e. a Chromium with --remote-debugging-port=9222 running locally).
set -euo pipefail
DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_DIR:-$HOME/mykysw/pi}"

ESBUILD=""
for c in \
    "$PI_DIR/node_modules/@esbuild/linux-x64/bin/esbuild" \
    "$DIR/node_modules/.bin/esbuild" \
    "$(command -v esbuild 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && ESBUILD="$c" && break
done
[ -n "$ESBUILD" ] || { echo "esbuild not found (set PI_DIR)"; exit 1; }

OUT="$DIR/_mcp_smoke.generated.mjs"
"$ESBUILD" "$DIR/mcp_smoke.ts" --bundle --platform=node --format=esm --outfile="$OUT" >/dev/null
trap 'rm -f "$OUT"' EXIT
node "$OUT"
