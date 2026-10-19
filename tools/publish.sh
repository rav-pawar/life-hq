#!/usr/bin/env bash
# Encrypt the private data for every enrolled device (v2, public-key), run the safety check,
# commit data.enc.json + app changes, push if a remote exists. No password needed.
#   tools/publish.sh [-m "message"] [--no-push] [--dry-run]
# Refuses to publish when <secrets>/devices.json has no devices (enroll with tools/enroll.js first).
# --dry-run: encrypt and check only; shows what would be committed, commits nothing.
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"
REPO="${LIFE_HQ_REPO:-$(cd "$TOOLS/.." && pwd)}"
MSG="Publish $(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M IST')"
PUSH=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -m) MSG="$2"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
N_DEV="$(node -e 'try { console.log(require(process.argv[1]).loadDevices().length) } catch (e) { console.error(e.message); console.log(-1) }' "$TOOLS/devices-lib.js")"
if [ "$N_DEV" -lt 1 ]; then
  echo "REFUSING TO PUBLISH: no enrolled devices (devices.json empty, missing or unreadable)." >&2
  echo "Enroll a device first: node tools/enroll.js '<code from the app>'" >&2
  exit 3
fi
echo "encrypting for $N_DEV enrolled device(s)"

[ -x "$REPO/.git/hooks/pre-commit" ] || bash "$TOOLS/install-hooks.sh"
node "$TOOLS/encrypt.js"
cd "$REPO"
git add -A            # .gitignore keeps data.json, vapid*, subscriptions*, *.pem, .env out
node "$TOOLS/safety-check.js" "$REPO"   # explicit run (the pre-commit hook runs it again)
echo "--- staged changes ---"
git status --short
if [ "$DRY" = 1 ]; then git reset -q; echo "DRY RUN: nothing committed (index reset)."; exit 0; fi
if git diff --cached --quiet; then echo "nothing to commit"; else git commit -q -m "$MSG"; echo "committed: $MSG"; fi
if [ "$PUSH" = 1 ] && [ -n "$(git remote)" ]; then
  git push
else
  echo "push skipped ($( [ "$PUSH" = 1 ] && echo 'no remote configured' || echo '--no-push'))"
fi
