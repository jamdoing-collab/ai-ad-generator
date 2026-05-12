#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/root/web"
BRANCH="main"
PM2_NAME="ai-ad-generator"
GH_PROXY="https://gh-proxy.com"

cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "ERROR: $APP_DIR is not a git repository. Convert the server codebase to a git clone first." >&2
  exit 1
fi

if ! git config --get remote.origin.proxyUrl >/dev/null 2>&1; then
  CURRENT_URL=$(git remote get-url origin)
  if [[ "$CURRENT_URL" != *"$GH_PROXY"* ]]; then
    git remote set-url origin "${GH_PROXY}/${CURRENT_URL}"
  fi
fi

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

npm install --omit=dev
pm2 restart "$PM2_NAME" --update-env
pm2 save

if command -v nginx >/dev/null 2>&1; then
  nginx -t
  systemctl reload nginx
fi

curl -fsS http://127.0.0.1:3003 >/dev/null
