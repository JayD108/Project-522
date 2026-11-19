#!/usr/bin/env bash
# Installs cloudflared for YOUR user only (no sudo) into ~/.local/bin, pinned to 2026.10.7 from
# Cloudflare's official GitHub release, and checks its SHA-256 against the release notes.
# Then restarts Jharokha and turns on "Share over the internet" (because you ran this to get a public link).
# Undo: npm run tunnel:off   (or the switch in Home → People → Connect a phone)
set -euo pipefail
VER=2026.10.7
ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=amd64;; aarch64) ARCH=arm64;; esac
NAME="cloudflared-linux-${ARCH}"
BIN="$HOME/.local/bin/cloudflared"
PORT="${PORT:-8080}"
mkdir -p "$HOME/.local/bin"
if [ -x "$BIN" ] && "$BIN" --version 2>/dev/null | grep -q "$VER"; then
  echo "cloudflared $VER already installed at $BIN"
else
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  echo "==> Downloading $NAME $VER"
  curl -fSL --proto '=https' -o "$TMP/$NAME" "https://github.com/cloudflare/cloudflared/releases/download/${VER}/${NAME}"
  want=$(curl -fsSL "https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${VER}" \
    | node -e "const b=JSON.parse(require('fs').readFileSync(0)).body||'';const m=b.match(new RegExp('${NAME}:\\\\s*([a-f0-9]{64})'));process.stdout.write(m?m[1]:'')")
  have=$(sha256sum "$TMP/$NAME" | cut -d' ' -f1)
  echo "    release SHA-256: ${want:-<not found>}"
  echo "    file    SHA-256: $have"
  if [ -z "$want" ] || [ "$want" != "$have" ]; then echo "!! checksum mismatch: not installing"; exit 1; fi
  install -m 755 "$TMP/$NAME" "$BIN"
fi
"$BIN" --version
echo "==> Restarting Jharokha"
systemctl --user restart jharokha 2>/dev/null || true
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:${PORT}/ping" >/dev/null && break; sleep 0.25; done
echo "==> Turning on Share over the internet"
curl -sf -XPOST -H 'content-type: application/json' -d '{"on":true}' "http://127.0.0.1:${PORT}/api/tunnel" >/dev/null
for _ in $(seq 1 60); do
  url=$(curl -sf "http://127.0.0.1:${PORT}/api/tunnel" | node -e "const t=JSON.parse(require('fs').readFileSync(0));process.stdout.write(t.url||'')")
  [ -n "$url" ] && break; sleep 0.5
done
if [ -n "${url:-}" ]; then
  echo
  echo "  Public link for phones (any network):  ${url}/join"
  echo "  It's also the QR on the dashboard now. Approve people from the laptop."
else
  echo "!! The tunnel didn't come up yet. Check: journalctl --user -u jharokha -n 30"
fi
