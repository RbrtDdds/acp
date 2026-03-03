#!/usr/bin/env bash
set -euo pipefail

# Auto-generate a changeset from git log since last tag (or last 10 commits).
# Usage: ./scripts/auto-changeset.sh [patch|minor|major]

BUMP="${1:-patch}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CS_DIR="$ROOT/.changeset"

mkdir -p "$CS_DIR"

# Get last tag, fall back to first commit
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)

# Build summary from git log
SUMMARY=$(git log "$LAST_TAG"..HEAD --pretty=format:"- %s" --no-merges 2>/dev/null | head -20)

if [ -z "$SUMMARY" ]; then
  SUMMARY="- Various improvements and fixes"
fi

# Generate unique filename
ID=$(date +%s | shasum | head -c 8)

cat > "$CS_DIR/auto-${ID}.md" << EOF
---
"@rbrtdds/acp-core": ${BUMP}
"@rbrtdds/acp-cli": ${BUMP}
"@rbrtdds/acp-embeddings": ${BUMP}
---

${SUMMARY}
EOF

echo "Created changeset: .changeset/auto-${ID}.md (${BUMP})"
