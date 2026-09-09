#!/usr/bin/env sh
set -e

# The full identity keeps /v2/mcp-search on its in-process companion (:3001).
# A dedicated primary search pod owns the same public path on the main app
# (:3000). Render only this fixed upstream token; do not interpolate arbitrary
# environment values into nginx configuration.
SEARCH_UPSTREAM=app_search
if [ "${FASTMCP_ENDPOINT:-/v2/mcp}" = "/v2/mcp-search" ]; then
  SEARCH_UPSTREAM=app
fi
sed "s/__MCP_SEARCH_UPSTREAM__/${SEARCH_UPSTREAM}/g" \
  /etc/nginx/nginx.conf > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/nginx.conf

# Start Node app in background
node dist/index.js &
APP_PID=$!

# Start NGINX in foreground
nginx -g 'daemon off;'

wait $APP_PID

