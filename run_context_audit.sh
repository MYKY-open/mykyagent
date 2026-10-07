#!/usr/bin/env bash
# Full per-turn context audit: system prompt sections + tool schema sizes.
#   ./run_context_audit.sh
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
OUT="$DIR/_context_audit.generated.mjs"
"$ESBUILD" "$DIR/context_audit.ts" \
    --bundle --platform=node --format=esm \
    --alias:@sinclair/typebox="$DIR/typebox_stub.ts" \
    --external:@earendil-works/pi-tui \
    --external:@earendil-works/pi-coding-agent \
    --outfile="$OUT" >/dev/null
trap 'rm -f "$OUT"' EXIT
node "$OUT"
