#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
NGINX_CONF_TARGET="${NGINX_CONF_TARGET:-/etc/nginx/conf.d/mao-kanban.conf}"
PM2_APP_NAME="${PM2_APP_NAME:-mao-kanban-api}"

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "APP_DIR must point to the project root: $APP_DIR" >&2
  exit 1
fi

if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  $SUDO dnf install -y nodejs npm
fi

if ! command -v nginx >/dev/null 2>&1; then
  $SUDO dnf install -y nginx
fi

if ! command -v pm2 >/dev/null 2>&1; then
  $SUDO npm install -g pm2
fi

corepack enable || true
if ! command -v pnpm >/dev/null 2>&1; then
  corepack prepare pnpm@10.33.0 --activate || $SUDO npm install -g pnpm@10.33.0
fi
pnpm install --frozen-lockfile

if [[ ! -f .env ]]; then
  cp deploy/env.production.example .env
  echo "Created .env from deploy/env.production.example. Fill FEISHU_APP_ID/SECRET and sheet URLs, then rerun." >&2
  exit 1
fi

pnpm run kanban:build
pnpm run kanban:auth-check

PM2_APP_NAME="$PM2_APP_NAME" pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

$SUDO cp deploy/nginx/mao-kanban.conf "$NGINX_CONF_TARGET"
$SUDO nginx -t
$SUDO systemctl enable --now nginx
$SUDO systemctl reload nginx

echo "Deploy complete."
echo "Kanban: http://<server>/kanban.html"
echo "Health: http://127.0.0.1:${PORT:-4173}/api/health"
