#!/usr/bin/env bash
# End-to-end tests: drives the real registered agent tools against a real model.
#
#   MYKYAGENT_BASE_URL     OpenAI-compatible endpoint (required)
#   MYKYAGENT_API_KEY      optional bearer token
#   MYKYAGENT_E2E_SEARCH=1 also run the live web_search check (slow, network)
#
# Example:
#   MYKYAGENT_BASE_URL=http://192.168.0.147:8080/v1 MYKYAGENT_API_KEY=cannotguess \
#       ./run_e2e.sh
set -euo pipefail

DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_DIR:-$HOME/mykysw/pi}"
PORT="${MYKYAGENT_E2E_PORT:-8749}"

if [ -z "${MYKYAGENT_BASE_URL:-}" ]; then
    echo "SKIP: MYKYAGENT_BASE_URL is not set"
    exit 0
fi

# --- locate esbuild ---------------------------------------------------------
ESBUILD=""
for c in \
    "$PI_DIR/node_modules/@esbuild/linux-x64/bin/esbuild" \
    "$DIR/node_modules/.bin/esbuild" \
    "$(command -v esbuild 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && ESBUILD="$c" && break
done

if [ -z "$ESBUILD" ]; then
    echo "SKIP: esbuild not found (set PI_DIR)"
    exit 0
fi

# --- is the model endpoint actually up? -------------------------------------
if ! curl -sS -m 5 -H "Authorization: Bearer ${MYKYAGENT_API_KEY:-none}" \
        "${MYKYAGENT_BASE_URL}/models" >/dev/null 2>&1; then
    echo "SKIP: model endpoint ${MYKYAGENT_BASE_URL} is not reachable"
    exit 0
fi

# --- fixture server: deterministic pages, no network flakiness --------------
FIXTURE_PID=""
cleanup() { [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true; }
trap cleanup EXIT

python3 - "$PORT" <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1])
BODY = "".join(
    f"<p>Paragraph {i} containing Caf\u00e9, \u65e5\u672c\u8a9e and \u2014 an em dash, filler filler filler.</p>"
    for i in range(120)
)
PAGE = (
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>E2E Fixture Page</title></head>"
    f"<body><article><h1>E2E Fixture Page</h1>{BODY}</article></body></html>"
).encode("utf-8")

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        # Anything but /missing* serves the page. The test uses a fresh random
        # path each run so its "cold fetch" assertion is genuinely cold rather
        # than hitting the previous run's cache entry.
        if self.path.startswith("/missing"):
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        # Deliberately no charset in the header: the exact case that used to mojibake.
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)
    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY
FIXTURE_PID=$!
sleep 1

# --- build + run ------------------------------------------------------------
OUT="$(mktemp -d)/e2e.mjs"
# Bundled into the repo dir so HELPER_SCRIPT resolves next to index.ts.
OUT="$DIR/_e2e.generated.mjs"
"$ESBUILD" "$DIR/e2e.ts" \
    --bundle --platform=node --format=esm \
    --alias:@sinclair/typebox="$DIR/typebox_stub.ts" \
    --external:@earendil-works/pi-tui \
    --external:@earendil-works/pi-coding-agent \
    --outfile="$OUT" >/dev/null

echo "=== e2e (model: ${MYKYAGENT_BASE_URL}) ==="
set +e
MYKYAGENT_E2E_FIXTURE="http://127.0.0.1:${PORT}" node "$OUT"
rc=$?
set -e
rm -f "$OUT"
exit "$rc"
