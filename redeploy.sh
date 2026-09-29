#!/usr/bin/env bash
# Pull latest main, rebuild backend + frontend, restart the service.
set -euo pipefail
APP=/opt/orm-dashboard
DOMAIN=orm.adaptsmedia.info

git -C "$APP" fetch --all --prune
git -C "$APP" reset --hard origin/main

cd "$APP/backend"
# --ignore-scripts: postinstall pip-installs Playwright, which lives in /opt/pyenv here.
npm install --ignore-scripts --include=dev
npx prisma generate --schema=prisma/schema.prisma
npm run build

cd "$APP/frontend"
printf 'VITE_API_BASE_URL=https://%s/api\n' "$DOMAIN" > .env.production
npm install --include=dev
npm run build
chmod -R o+rX "$APP/frontend/dist"

pm2 restart orm-backend --update-env
pm2 save
echo "Redeploy complete."
