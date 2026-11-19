#!/usr/bin/env bash
# Stop sharing over the internet (the QR goes back to the Wi-Fi address).
curl -sf -XPOST -H 'content-type: application/json' -d '{"on":false}' "http://127.0.0.1:${PORT:-8080}/api/tunnel" >/dev/null && echo "Internet sharing is off."
