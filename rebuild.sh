#!/usr/bin/env bash
set -euo pipefail

# === ACP: rebuild, reinstall globally, wipe DB, init + import ===

ROOT="$(cd "$(dirname "$0")" && pwd)"
ACP_DIR="$HOME/.acp"

echo "=== 1. Clean + Build ==="
cd "$ROOT"
pnpm run clean
pnpm install
pnpm run build

echo ""
echo "=== 2. Global install (link) ==="
cd "$ROOT/packages/cli"
npm link

echo ""
echo "=== 3. Wipe old DB ==="
if [ -f "$ACP_DIR/acp.db" ]; then
  rm "$ACP_DIR/acp.db"
  echo "Deleted $ACP_DIR/acp.db"
else
  echo "No DB found at $ACP_DIR/acp.db — skipping"
fi

# Also remove WAL/SHM if native was used before
rm -f "$ACP_DIR/acp.db-wal" "$ACP_DIR/acp.db-shm"

# Remove old config so init starts fresh
if [ -f "$ACP_DIR/config.json" ]; then
  rm "$ACP_DIR/config.json"
  echo "Deleted $ACP_DIR/config.json"
fi

echo ""
echo "=== 4. Run acp init ==="
acp init

echo ""
echo "=== 5. Import + Embed ==="
acp import claude-code
