# Jharokha

A live video wallpaper and room host for a ChromeOS Flex laptop with an external monitor.
Specs: `v1.md` (engine) and `v2.md` (dual screen + hostel server; v2 wins on conflicts). Build plan: `TASKS.md`. History: `DEVLOG.md`.

## Week 0 probe
```bash
node server/probe-server.mjs          # Node >= 22.13, no npm install needed
# open http://localhost:8080/          (laptop)
# open http://<laptop-ip>:8080/lan.html (phone on the same Wi-Fi)
```
On the Flex laptop, inside Crostini: `bash scripts/setup-crostini.sh`, then follow `docs/DEVICE-CHECKS.md`.

## App (Week 1+)
```bash
cd app && npm install
npm run dev            # http://localhost:5173 (hot reload)
npm run build          # app/dist, served by the server at http://localhost:8080/app/
npm test               # unit tests (vitest)
node e2e/smoke.mjs http://localhost:8080   # headless dual-screen e2e (server must be running)
```
Test clips: `tools/make-test-clips.sh` (needs ffmpeg) puts clips encoded with the house settings into `probe/clips/`.
Debug HUD and the auto-swap test: add `?debug` to the URL.
