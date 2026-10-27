#!/bin/bash
# Shares Loom with invited testers from this Mac: the production build (in .next-share) on port
# 3100, invite-only, behind a Cloudflare quick tunnel (a public https address, new each time this
# starts). Keeps the Mac awake while it runs. Ctrl+C stops all of it. The dev server (port 3000)
# is untouched.
#   npm run share          start (builds first if there's no shared build yet)
#   npm run share:update   after code changes: rebuild and restart the server; the address stays
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=3100
mkdir -p data
[ -d .next-share ] || npm run share:build
# The server restarts by itself when stopped, so share:update can swap in a new build without
# touching the tunnel (and its address).
( while true; do LOOM_DIST=.next-share LOOM_INVITES=on npx next start -p $PORT >> data/share-server.log 2>&1 || true; sleep 1; done ) &
LOOP=$!
caffeinate -dims -w $$ &
cloudflared tunnel --no-autoupdate --url http://localhost:$PORT > data/share-tunnel.log 2>&1 &
TUNNEL=$!
trap 'kill $LOOP $TUNNEL 2>/dev/null; pkill -f "next start -p $PORT" 2>/dev/null; rm -f data/public-url.txt' EXIT
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/share-tunnel.log | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -z "${URL:-}" ] && { echo "The tunnel didn't start; see data/share-tunnel.log"; exit 1; }
echo "$URL" > data/public-url.txt
echo "Loom is shared at $URL (invite-only)."
echo "Links: npm run loom -- invite list"
wait $TUNNEL
