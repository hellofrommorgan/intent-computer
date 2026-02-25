#!/bin/bash
#
# install-heartbeat.sh — Install or uninstall the heartbeat launchd schedule
#
# Usage:
#   ./scripts/install-heartbeat.sh [vault-path]       Install (default vault: ~/Mind)
#   ./scripts/install-heartbeat.sh --uninstall        Uninstall
#   ./scripts/install-heartbeat.sh --status            Check status
#
# The heartbeat runs on two schedules:
#   Morning (6:00 AM): Full profile — phases 5a,5b,5c,6,7
#   Evening (9:00 PM): Full profile — phases 5a,5b,5c,6,7

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HEARTBEAT_BIN="$PROJECT_ROOT/packages/heartbeat/dist/index.js"

# Check that the heartbeat has been built
if [ ! -f "$HEARTBEAT_BIN" ]; then
  echo "error: heartbeat not built. Run 'pnpm run build' first."
  echo "  expected: $HEARTBEAT_BIN"
  exit 1
fi

case "${1:-}" in
  --uninstall)
    exec node "$HEARTBEAT_BIN" --uninstall-schedule
    ;;
  --status)
    exec node "$HEARTBEAT_BIN" --schedule-status
    ;;
  *)
    VAULT="${1:-$HOME/Mind}"
    exec node "$HEARTBEAT_BIN" --install-schedule --vault "$VAULT"
    ;;
esac
