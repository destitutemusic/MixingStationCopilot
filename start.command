#!/bin/bash
# Double-click me on macOS. Finder runs .command files in Terminal.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if xattr -p com.apple.quarantine "$0" >/dev/null 2>&1; then
  echo "macOS quarantined this download (it came from the internet)."
  echo "If double-clicking does nothing, run this once in Terminal:"
  echo "  xattr -dr com.apple.quarantine \"$SCRIPT_DIR\""
  echo "Then double-click start.command again."
  echo
fi

exec "$SCRIPT_DIR/start.sh"
