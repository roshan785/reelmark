#!/usr/bin/env bash
# start.sh — run Reelmark locally on a fixed port with a stable data dir.
#
# Usage:
#   ./start.sh                 # port 4177
#   PORT=5000 ./start.sh       # custom port
#
# ADMIN_TOKEN: if ./.admin-token exists it is used, so the admin API survives
# restarts without exporting a secret into your shell history.
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4177}"
HOST="${HOST:-127.0.0.1}"
DATA_DIR="${DATA_DIR:-./data}"

if [[ -z "${ADMIN_TOKEN:-}" && -f .admin-token ]]; then
  ADMIN_TOKEN="$(cat .admin-token)"
fi

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  echo "[start] admin API disabled (no .admin-token and no ADMIN_TOKEN)" >&2
  ADMIN_TOKEN=""
fi

# Refuse to start on a busy port instead of crash-looping with EADDRINUSE.
if ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
  echo "[start] port ${PORT} is already in use — set PORT=something-else" >&2
  exit 1
fi

export PORT HOST DATA_DIR ADMIN_TOKEN TRUST_PROXY="${TRUST_PROXY:-1}"
exec node server.js
