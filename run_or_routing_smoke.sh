#!/usr/bin/env bash
# Offline smoke test for /or-routing: command handler, orrouting.json state,
# and that the routing reaches the OpenRouter distillation payload.
#   ./run_model_web_smoke.sh
#
# Note: bundle keeps @earendil-works/* external; node resolves them through the
# repo's node_modules symlink into ~/mykysw/pi/node_modules. Bundle must be
# written INTO the repo dir because HELPER_SCRIPT resolves via import.meta.url.
set -euo pipefail
DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ESBUILD="${ESBUILD:-$(find "$HOME/mykysw/pi/node_modules/@esbuild" -name esbuild -type f -perm -u+x 2>/dev/null | head -1)}"
if [ -z "$ESBUILD" ]; then
    echo "esbuild not found (set PI_DIR or install esbuild)" >&2
    exit 1
fi
OUT="$DIR/_smoke.generated.mjs"
"$ESBUILD" "$DIR/or_routing_smoke.ts" \
    --bundle --platform=node --format=esm \
    --alias:@sinclair/typebox="$DIR/typebox_stub.ts" \
    --external:@earendil-works/pi-tui \
    --external:@earendil-works/pi-coding-agent \
    --outfile="$OUT" >/dev/null
trap 'rm -f "$OUT"' EXIT
node "$OUT"
