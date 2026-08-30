#!/bin/bash
# Mixing Station Copilot launcher (Linux/macOS)
set -e
cd "$(dirname "$0")"

# Check Node >= 20
NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Need Node 20+ (found $(node -v)). Install from https://nodejs.org" >&2
  exit 1
fi

# Install deps if needed
[ ! -d node_modules ] && npm install --no-audit --no-fund

# Start server
node server/index.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# Open browser
BROWSER_CMD=""
for c in xdg-open open; do
  if command -v "$c" >/dev/null 2>&1; then BROWSER_CMD=$c; break; fi
done
if [ -n "$BROWSER_CMD" ]; then
  (sleep 2 && "$BROWSER_CMD" http://localhost:8085) >/dev/null 2>&1 &
fi

wait $SERVER_PID
