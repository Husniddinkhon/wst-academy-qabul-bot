#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/opt/wst-academy-qabul-bot
SERVICE=wst-academy-qabul-bot
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8300/health/ready}
cd "$ROOT"
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || { echo DEPLOY_GUARD_GIT_DIRTY; exit 78; }
npm ci
npm run build
test -r dist/index.js
node scripts/preflight-startup.mjs --check-only
backup_dir="$(mktemp -d /tmp/wst-academy-deploy.XXXXXX)"
trap 'rm -rf "$backup_dir"' EXIT
cp -a dist "$backup_dir/dist"
rollback(){ rm -rf dist; cp -a "$backup_dir/dist" dist; pm2 reload ecosystem.config.cjs --only "$SERVICE" --update-env || true; }
pm2 reload ecosystem.config.cjs --only "$SERVICE" --update-env || { rollback; exit 1; }
for _ in {1..12}; do
  if pm2 describe "$SERVICE" | grep -q online && curl -fsS "$HEALTH_URL" >/dev/null; then echo DEPLOY_GUARD_OK; exit 0; fi
  sleep 2
done
rollback
echo DEPLOY_GUARD_HEALTH_FAILED >&2
exit 1
