#!/usr/bin/env bash
# One-time setup inside Crostini (Debian) on the ChromeOS Flex laptop.
# Installs Node 22 LTS (if missing/too old) and the Jharokha server as a systemd --user service.
# Usage (from the repo root, inside the Linux terminal):  bash scripts/setup-crostini.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEED_MAJOR=22

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt "$NEED_MAJOR" ]; then
  echo "==> Installing Node ${NEED_MAJOR}.x from NodeSource (needs sudo)"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NEED_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "==> node $(node -v)"
node -e 'require("node:sqlite")' 2>/dev/null && echo "==> node:sqlite OK" || echo "!! node:sqlite missing: need Node >= 22.13"

echo "==> Building the app (app/dist, served at /app/)"
sudo apt-get install -y ffmpeg >/dev/null 2>&1 || echo "   (ffmpeg not installed: tools/encode.sh will not work)"
( cd "$REPO/app" && npm ci --no-audit --no-fund && npm run build )
( cd "$REPO/server" && npm ci --no-audit --no-fund )
[ -f "$REPO/probe/clips/test_1080p30.mp4" ] || bash "$REPO/tools/make-test-clips.sh" || true

echo "==> Installing systemd --user unit"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/share/jharokha"
# Week 0-2 unit name: replace it with the Week 3 one.
if [ -f "$HOME/.config/systemd/user/jharokha-probe.service" ]; then
  systemctl --user disable --now jharokha-probe.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/jharokha-probe.service"
fi
sed -e "s#@REPO@#${REPO}#g" -e "s#@NODE@#$(command -v node)#g" \
  "$REPO/scripts/jharokha.service" > "$HOME/.config/systemd/user/jharokha.service"
systemctl --user daemon-reload
systemctl --user enable jharokha.service
systemctl --user restart jharokha.service
sleep 1
systemctl --user --no-pager status jharokha.service | head -n 5 || true

cat <<EOF

Done. Next (manual, in ChromeOS):
  1. Chrome on the laptop: open http://localhost:8080/app/  (Week 0 probe: http://localhost:8080/)
     Install it: Chrome menu > Cast, save and share > Install page as app
  2. Settings > About ChromeOS > Linux development environment > Port forwarding
     > Add: port 8080, TCP. Toggle it ON.
  3. Find the laptop's Wi-Fi IP: Settings > Network > (your Wi-Fi) > IP address
  4. Friend's phone on the same Wi-Fi: http://<that-ip>:8080/lan.html
Logs: journalctl --user -u jharokha -f
Update later: git pull && npm run setup && npm run build && systemctl --user restart jharokha
EOF
