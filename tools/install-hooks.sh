#!/usr/bin/env bash
# Installs the pre-commit safety check into this clone (.git/hooks is not versioned; run once per clone).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"
cat > "$HOOK" <<'H'
#!/usr/bin/env bash
# Life HQ: refuse to commit private data or secrets.
ROOT="$(git rev-parse --show-toplevel)"
exec node "$ROOT/tools/safety-check.js" "$ROOT"
H
chmod +x "$HOOK"
echo "installed $HOOK"
