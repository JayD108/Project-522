#!/usr/bin/env bash
# Show the latest Jharokha on this ChromeOS laptop: make sure the server runs the fresh build,
# then open "What's new" and the app in ChromeOS Chrome (from inside Crostini).
# Usage: npm run show
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORT="${PORT:-8080}"

[ -f app/dist/index.html ] || npm run build
if systemctl --user is-enabled jharokha >/dev/null 2>&1; then
  systemctl --user restart jharokha
else
  echo "!! auto-start service not installed: run  bash scripts/setup-crostini.sh"; exit 1
fi
for _ in $(seq 1 40); do curl -sf "http://localhost:${PORT}/health" >/dev/null && break; sleep 0.25; done

open_url() {
  if command -v garcon-url-handler >/dev/null; then garcon-url-handler "$1"   # Crostini → ChromeOS Chrome
  else xdg-open "$1" >/dev/null 2>&1 || echo "Open: $1"; fi
}
open_url "http://localhost:${PORT}/updates.html"
sleep 1
# Open the app with a one-time pairing code: it becomes an owner if it isn't one already.
pair_url=$(curl -sf -XPOST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:${PORT}/api/pair/new" \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).url)' 2>/dev/null || true)
open_url "${pair_url:-http://localhost:${PORT}/app/}"
echo "Opened What's new + Jharokha in Chrome (http://localhost:${PORT}/updates.html)"
