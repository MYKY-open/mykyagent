#!/usr/bin/env bash
# Runs the test suites:
#   1. every *.test.ts next to this script (bundled with esbuild, run on node)
#   2. search_helper intent/field/nav/conflict unit tests (Python, offline)
#
# The network-backed `search_helper.py selftest` is NOT run here; invoke it
# explicitly when you want to exercise the live pipeline:
#     uv run search_helper.py selftest x
set -euo pipefail

DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_DIR:-$HOME/mykysw/pi}"
rc=0

# --- locate esbuild ---------------------------------------------------------
ESBUILD=""
for c in \
    "$PI_DIR/node_modules/@esbuild/linux-x64/bin/esbuild" \
    "$DIR/node_modules/.bin/esbuild" \
    "$(command -v esbuild 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && ESBUILD="$c" && break
done
if [ -z "$ESBUILD" ]; then
    ESBUILD="$(find "$PI_DIR/node_modules/@esbuild" -name esbuild -type f -perm -u+x 2>/dev/null | head -1 || true)"
fi

# --- TypeScript suites ------------------------------------------------------
shopt -s nullglob
TS_TESTS=("$DIR"/*.test.ts)
shopt -u nullglob

if [ ${#TS_TESTS[@]} -eq 0 ]; then
    echo "no *.test.ts found"
elif [ -z "$ESBUILD" ]; then
    echo "SKIP: esbuild not found (set PI_DIR or install esbuild)"
else
    TMPOUT="$(mktemp -d)"
    for f in "${TS_TESTS[@]}"; do
        name="$(basename "$f" .ts)"
        echo "=== $name ==="
        out="$TMPOUT/$name.mjs"
        if ! "$ESBUILD" "$f" --bundle --platform=node --format=esm --outfile="$out" >/dev/null; then
            echo "  BUILD FAILED"
            rc=1
            continue
        fi
        node "$out" || rc=1
        echo
    done
    rm -rf "$TMPOUT"
fi

# --- Python unit tests ------------------------------------------------------
echo "=== search_helper (offline unit tests) ==="
python3 -m py_compile "$DIR/search_helper.py"
uv run -q "$DIR/search_helper.py" unit x | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("  %d/%d passed" % (d["passed"], d["checks"]))
for f in d["failed"]:
    print("  FAIL  %s  %s" % (f["name"], f["extra"][:140]))
sys.exit(1 if d["failed"] else 0)
' || rc=1

echo
[ "$rc" -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit "$rc"
