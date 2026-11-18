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
