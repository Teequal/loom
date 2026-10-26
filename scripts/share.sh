#!/bin/bash
# Shares Loom with invited testers from this Mac: the production build on port 3100, invite-only,
# behind a Cloudflare quick tunnel (a public https address, new each time). Keeps the Mac awake
# while it runs. Ctrl+C stops all of it. Your dev server (port 3000) is untouched.
#   npm run build      (after code changes)
#   npm run share
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=3100
mkdir -p data
LOOM_INVITES=on npx next start -p $PORT > data/share-server.log 2>&1 &
SERVER=$!
caffeinate -dims -w $SERVER &
cloudflared tunnel --no-autoupdate --url http://localhost:$PORT > data/share-tunnel.log 2>&1 &
TUNNEL=$!
trap 'kill $SERVER $TUNNEL 2>/dev/null; rm -f data/public-url.txt' EXIT
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/share-tunnel.log | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -z "${URL:-}" ] && { echo "The tunnel didn't start; see data/share-tunnel.log"; exit 1; }
echo "$URL" > data/public-url.txt
echo "Loom is shared at $URL (invite-only)."
echo "Links: npm run loom -- invite list"
wait $SERVER
