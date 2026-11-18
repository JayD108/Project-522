# Jharokha DEVLOG

## 2026-11-18 · Week 0 probe kit
**Built**
- `probe/index.html` + `probe.js` + `loop.js`: the same page runs as W-A and W-B. It covers screen detection, fullscreen on screen A plus a companion popup on B, the RAM-Blob ping-pong loop, SWAP over BroadcastChannel, auto-swap ×50, server ping, the decoder table and Copy report.
- `probe/lan.html`: phone page for reachability, ping and a speed test.
- `server/probe-server.mjs`: zero-dep Node server with `/health /ping /speed /clips`, static files, `node:sqlite` in WAL mode.
- `tools/encode.sh`, `scripts/setup-crostini.sh`, `scripts/jharokha-probe.service` (systemd --user).
- `docs/DEVICE-CHECKS.md`: the evening checklist for the Flex laptop.

**Tested here (Windows, headless Chrome via CDP, generated 720p VP9 clip)**
- Server: all endpoints OK, path traversal blocked (404), SQLite `journal_mode=wal`.
- Single-screen loop: 3 loops in 30 s, seam ~54 ms, first frame 88 ms after start. Hitch counts in headless software rendering aren't meaningful.
- Two windows: the Blob passes through BroadcastChannel fine. 8 swaps: min 74 / median 147 / max 276 ms, 0 failures.
- Not testable here: real dual fullscreen, HW decode, ChromeOS occlusion (auto-yield), hostel Wi-Fi. All of these are in DEVICE-CHECKS.

**Decisions**
- Own git repo in `livewallpaper/` (it was inside the home-directory repo).
- Node 22 LTS + `node:sqlite` instead of Node 20 + better-sqlite3. Node 20 is EOL, and this needs no native build.
- The loop flips instantly after the standby's first frame instead of a 0.5 s crossfade, to keep the overlay path.
- Each window keeps at most one reference to the clip Blob. Blob data isn't copied across windows.

**Next:** run DEVICE-CHECKS on the laptop (needs you). Meanwhile, start Week 1: Vite + Preact + TS shell, with the engine moved over from the probe.
