#!/bin/bash
# Mixing Station Copilot launcher (Linux/macOS)
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

# Prefer the Node runtime shipped in this zip; fall back to a system Node.
if [ -x "$ROOT/runtime/node" ]; then
  NODE="$ROOT/runtime/node"
  [ -n "$COPILOT_QUIET" ] || echo "Using bundled Node runtime."
elif [ -x "$ROOT/runtime/bin/node" ]; then
  NODE="$ROOT/runtime/bin/node"
  [ -n "$COPILOT_QUIET" ] || echo "Using bundled Node runtime."
elif command -v node >/dev/null 2>&1; then
  NODE="node"
  echo "Bundled runtime not found; using the system Node ($(node -v))."
else
  echo "No Node runtime found in this folder and no system Node installed."
  echo "Download the Mixing Station Copilot zip again from the release page; it includes its own runtime."
  exit 1
fi

# The release zip ships node_modules. A git checkout may not, so fall back once.
if [ ! -d node_modules ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "Installing dependencies (first run)..."
    npm install --no-audit --no-fund
  else
    echo "This copy is missing its dependencies and npm is not available."
    echo "Download the release zip again; it includes everything."
    exit 1
  fi
fi

echo "Starting Mixing Station Copilot..."
"$NODE" server/index.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

BROWSER_CMD=""
for c in xdg-open open; do
  if command -v "$c" >/dev/null 2>&1; then BROWSER_CMD=$c; break; fi
done
if [ -n "$BROWSER_CMD" ]; then
  (sleep 2 && "$BROWSER_CMD" http://localhost:8085) >/dev/null 2>&1 &
else
  echo "Open http://localhost:8085 in your browser."
fi

wait $SERVER_PID
