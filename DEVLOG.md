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

## 2026-11-18 · Week 1 app shell + dual screen
**Built** (`app/`, Vite 8 + Preact 11 + TS 7 + vite-plugin-pwa 2, 17 KB gzip JS)
- `engine/loop.ts` (port of the probe engine, with a startup timing breakdown) and `engine/sniff.ts` (codec sniff and verdicts)
- `store/library.ts`: OPFS import (streamed copy), metadata in IndexedDB, `readToRam()` as the single disk-read path with a counter. `store/db.ts`: settings batched every 5 min, plus hide and pagehide
- `host.ts` coordinator: W-A is the brain (library, settings, opens W-B). The swap protocol hands the Blob plus the current time over BroadcastChannel. Late ready messages still complete the handover, so both windows never stay on Layer 1. Hotplug or a dead W-B falls back to single-screen from W-A's own Blob ref. There is also a monitor-reconnect banner, the wake lock, and auto-pause when hidden
- UI: Start screen, Layer 2 (compact on the laptop, wall layout at ≥ 1700 px), vitals strip (battery, Compute Pressure, network, link; temperature/fan show as n/a per v2 §2), library, engine card, W-B tap-to-fill
- Server: `/app/` serves `app/dist`, and `sw.js` is sent as no-store
- `app/e2e/smoke.mjs`: raw-CDP headless test using `--screen-info={1536x864}{2560x1440}`

**Found and fixed**
- `requestFullscreen()` used up the Start click, so the W-B popup was blocked (headless). Now the wallpaper plays on the laptop and a banner asks for one more tap. On the real device, Chrome's companion-window rule may make one click enough (to check in DEVICE-CHECKS §F)
- After a swap timeout, a late `l1-ready` left both windows on Layer 1 (4 videos). The handover now completes even when it arrives late
- ~20 % of swaps took ~2.8 s. I traced it to the in-browser MediaRecorder test clip: its WebM has no seek index, so a start at 0.4–2.5 s waited until ~3.3 s. Real encodes (H.264 1080p with 2 s GOP, and VP9) start in 56–113 ms at any position. The e2e now uses real clips (`tools/make-test-clips.sh`)

**Results (headless Chrome 157, Windows, software path)**: 19/19 checks pass, twice. 50/50 swaps, median 124–132 ms, max 186–191 ms. 0 disk reads during swaps, JS heap +0.2 MB, 2 video elements at the end. Loop seam 33 ms (one frame).

**Notes**: npm audit reports high advisories in picomatch/minimatch. These are build-time globbing only, nothing ships to the app, and no fix exists yet.

**Next**: Week 2: auto-yield (release the Blob after 2 min hidden), 🎬 Cinema, Night Watch, scene scheduler, prefetch, clock and weather.
