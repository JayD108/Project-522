#!/usr/bin/env bash
# Pair the laptop's Chrome as an owner: asks the server (from inside Linux, which is trusted) for a
# one-time code and opens http://localhost:8080/app/?pair=<code> in ChromeOS Chrome. Safe to run again.
set -euo pipefail
PORT="${PORT:-8080}"
url=$(curl -sf -XPOST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:${PORT}/api/pair/new" \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).url)') \
  || { echo "!! server not reachable on :${PORT} (systemctl --user status jharokha)"; exit 1; }
if command -v garcon-url-handler >/dev/null; then garcon-url-handler "$url"; echo "Opened Jharokha in Chrome: it pairs itself (code valid 10 min)."
else echo "Open this in Chrome on the laptop within 10 min: $url"; fi
