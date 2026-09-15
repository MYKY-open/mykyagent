#!/usr/bin/env bash
# Offline audit of the REAL system prompt built by before_agent_start:
# per-persona size + full dump of one persona.
#   ./run_prompt_audit.sh
set -euo pipefail
DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ESBUILD="${ESBUILD:-$(find "$HOME/mykysw/pi/node_modules/@esbuild" -name esbuild -type f -perm -u+x 2>/dev/null | head -1)}"
if [ -z "$ESBUILD" ]; then
    echo "esbuild not found (set PI_DIR or install esbuild)" >&2
    exit 1
fi
OUT="$DIR/_prompt_audit.generated.mjs"
"$ESBUILD" "$DIR/prompt_audit.ts" \
    --bundle --platform=node --format=esm \
    --alias:@sinclair/typebox="$DIR/typebox_stub.ts" \
    --external:@earendil-works/pi-tui \
    --external:@earendil-works/pi-coding-agent \
    --outfile="$OUT" >/dev/null
trap 'rm -f "$OUT"' EXIT
node "$OUT"
