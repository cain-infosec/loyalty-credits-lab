#!/bin/sh
set -e

# Runtime dirs
mkdir -p /run/nginx /data

echo "[entrypoint] starting Node backend..."
node --experimental-sqlite /app/backend/server.js &

echo "[entrypoint] starting nginx (foreground)..."
exec nginx -g 'daemon off;'
