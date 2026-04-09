#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="$ROOT/data/surreal.db"
mkdir -p "$ROOT/data"
BIN="${SURREAL_BIN:-$HOME/.local/bin/surreal}"
if ! command -v "$BIN" >/dev/null 2>&1 && [ ! -x "$BIN" ]; then
  if command -v surreal >/dev/null 2>&1; then BIN="surreal"; else
    echo "Surreal binary not found. Set SURREAL_BIN or install surreal." >&2
    exit 1
  fi
fi
exec "$BIN" start --user "${SURREAL_USER:-root}" --pass "${SURREAL_PASS:-root}" --bind "${SURREAL_BIND:-127.0.0.1:8000}" "file:$DB_PATH"
