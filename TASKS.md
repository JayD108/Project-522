# Jharokha: reconciled build plan (v1 + v2)

## Understanding / constraints
- Target: ChromeOS Flex, i5-10210U (Intel UHD, Gen 9.5), 8 GB RAM, 1 TB HDD. Two screens: the HP laptop panel (W-A) and the Legion external monitor (W-B). The laptop is shared with Netflix/Prime/YouTube.
- Video: Chrome `<video>` with hardware decode, H.264/VP9 only, never AV1. Each scene's file is read **once** into a RAM Blob. No streaming from the HDD.
- No Kiosk. Crostini (Debian) runs **only** the Node server (Fastify + ws + SQLite WAL) on port 8080, with ChromeOS port forwarding. It never plays video.
- RAM (v2 §5): ChromeOS+Chrome 2.5 GB, Netflix 0.5–0.8 GB, 2 Jharokha windows ~0.5 GB (video Blobs ≤ 300 MB total), Crostini+server 0.4–0.6 GB. That leaves ~3.5 GB headroom.
- Dual screen: two fullscreen windows that run the same app. SWAP swaps **content, not windows**. A BroadcastChannel message carries the Blob in memory, with zero disk reads, and the swap takes < 1 s.
- Developed on Windows, runs in Crostini. Server and scripts are Linux-first (bash, `systemd --user`).
- v2 overrides v1 on: screens, server, users, the remote (WebSocket via the LAN server instead of WebRTC/PeerJS), and the roadmap.

## Judgment calls (cheap to redo)
- The project has its **own git repo** in `livewallpaper/`. It used to sit inside the home-directory repo.
- **Node 22 LTS, not Node 20.** Node 20 reached end of life in April 2026. SQLite comes from the built-in `node:sqlite` (Node ≥ 22.13) instead of `better-sqlite3`, so Crostini needs no native compile. If `node:sqlite` causes trouble, it can be swapped back.
- The Week 0 probe server has **zero dependencies** (Node's built-in `http` + `node:sqlite`). That gives a true one-line run with no `npm install`. The real Fastify + ws server starts in Week 3.
- On the laptop, the PWA is served by the Crostini server at `http://localhost:8080`. `localhost` counts as a secure context, so the Window Management API and wake lock work there. Nothing is deployed anywhere.
- The probe's seamless loop does an **instant flip** after the standby video has presented its first frame, instead of a 0.5 s opacity crossfade. This keeps overlay promotion and costs less. A crossfade stays as an option for the transitions between *different* wallpapers.

## Build order (v2 roadmap, with v1 phases folded in)

### Week 0 · Probe kit ← built, waiting on the device run (superseded by the app for swap tests)
- [x] `probe/index.html`: one page used as both W-A and W-B. It does screen detection (`getScreenDetails`), fullscreen on screen A plus a companion popup on screen B, a RAM-Blob ping-pong loop with FPS/dropped/hitch counters, SWAP via BroadcastChannel (Blob handed over, timed), an auto-swap ×50 leak test, a server ping, and a codec/AV1 check
- [x] `probe/lan.html`: phone page that checks LAN reachability, ping RTT and a download speed test
- [x] `server/probe-server.mjs`: zero-dep server on 0.0.0.0:8080 with `/health`, `/ping`, `/speed`, `/clips`, static files, and an SQLite WAL check
- [x] `tools/encode.sh` (house encode standard), `scripts/setup-crostini.sh`, systemd `--user` unit
- [x] `docs/DEVICE-CHECKS.md`: the Week 0 checklist (chrome://gpu, media-internals, port forwarding, friend's phone, Netflix + wallpaper)
- [ ] **Run DEVICE-CHECKS on the Flex laptop** (needs you; results go into DEVLOG)

### Week 1 · App shell + dual screen (v2 W1 + v1 W1–2) ← built, waiting on the device run
- [x] Vite + Preact + TS, PWA manifest + Workbox (generateSW, app shell only, videos never in SW cache)
- [x] Video engine module (`app/src/engine/loop.ts`), OPFS import with codec check (AV1 rejected, HEVC warned), `navigator.storage.persist()`
- [x] W-A/W-B window manager, Layer 1 / Layer 2 rendering (compact vs wall layout), ⇄ SWAP, hotplug `screenschange` → single-screen fallback from W-A's RAM Blob, "monitor connected" banner
- [x] Wake lock (re-requested on visibilitychange), Start screen, "Tap to fill this screen" on W-B, auto-pause when hidden
- [x] Settings in IndexedDB, batched (5 min + hide + pagehide)
- [x] Headless e2e (now `tests/run-all.mjs`, 2 emulated screens): 50/50 swaps, median ~130 ms, max ~190 ms, 0 disk reads, heap flat, no leaked videos. 19/19 checks pass
- [ ] **On the device:** does fullscreen + popup work in ONE click, or does it take the second-tap banner? (DEVICE-CHECKS §F)
- Done when: swap < 1 s with zero disk reads, and 50 swaps without a leak ✅ (headless; confirm on the device)

### Consolidation (18 Nov) ✅
- [x] One command (`npm start`), sample clips, `npm test` → single `test-run-*.log` (63 checks), SETUP.md, repo cleaned for GitHub

### Week 2 · Coexist (v2 W2 + v1 W3)
- [ ] Auto-yield (when hidden: pause; after 2 min: release the Blob), 🎬 Cinema, Night Watch
- [ ] Scene manager + scheduler (Dawn / Ambient / Deep Work / Night), prefetch of the next scene, IndexedDB writes batched every 5 min
- [ ] Clock + weather (Open-Meteo), compact and wall layouts chosen by screen size
- [ ] Done when: Netflix uses no more CPU with Jharokha running than without it

### Week 3 · Server core
- [ ] Fastify + ws + `node:sqlite` WAL (checkpoint every 5 min), serving the PWA's static files
- [ ] `systemd --user` service, port 8080 forwarded, survives a reboot
- [ ] Layer 2 vitals: Vitals Ring (battery, Compute Pressure, network, server), server panel, "Server offline" badge, live QR with the current address

### Week 4 · Access
- [ ] QR join → name → approval tray → role (owner/collaborator/viewer) → HttpOnly device token (30 days, revocable)
- [ ] Kill switch, quiet hours, audit log, per-device rate limits, max 20 users

### Week 5 · Collaborate
- [ ] Room Board (Yjs + y-websocket), Door Sign, Drop Zone (quota, 7-day auto-delete)
- [ ] Phone remote for owners (swap, cinema, scene, approvals)

### Week 6 · Fun layer
- [ ] Watch-Party queue, Cast-to-Wall (owner approves), Study Room shared Pomodoro, Game Night scoreboard
- [ ] Showcase FX: audio-reactive canvas (30 fps cap), ink theme

### Week 7 · Utilities
- [ ] Polls, laundry timers, Split & Settle (UPI deep links), sunrise alarm, calendar (optional)

### Week 8 · Harden
- [ ] Nightly SQLite snapshot, thermal guard (Compute Pressure), 72 h soak (< 50 MB growth), ring-buffer logs
- [ ] HTTPS via a domain + DNS-01 **only if you approve the purchase**

## Needs your decision later (not blocking)
1. A domain for LAN HTTPS. 2. A travel router, if the hostel uses client isolation. 3. Any hosting/deploy. Nothing gets deployed without a yes.
