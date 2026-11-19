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
- [x] Repo cloned on the Flex laptop, `systemd --user` service installed and running (18 Nov)
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

### Week 2 · Coexist (v2 W2 + v1 W3) ← built, waiting on the device run
- [x] Auto-yield: covered (hidden) → pause at once; still covered after 2 min → drop the player AND the Blob in both windows (RAM really freed). Coming back costs one disk read on W-A, and W-B gets the clip from W-A
- [x] 🎬 Cinema (button or **C**): Layer 1 paused, Layer 2 shrinks to a slim dim strip, toasts off, mirrored on both windows; after 2 min it also releases the clip
- [x] 🌙 Night Watch (button or **N**): both screens near-black with a faint red clock; ☀ wake, double-click or Esc exits
- [x] Scene scheduler (Dawn / Deep Work / Ambient / Night, editable times, a wallpaper per scene, Auto on/off). The next scene's clip is prefetched into RAM 3 min early, within the 300 MB budget, so the switch reads nothing from disk
- [x] Settings (scenes, place, last weather) in the batched IndexedDB settings (5 min / hide / pagehide)
- [x] Weather from Open-Meteo (city lookup, every 30 min, cached for offline, forwarded to W-B) in the header and next to the wall clock; compact/wall layouts by screen size (from Week 1)
- [x] Tests: 8 unit tests (scheduler, weather) + 2 new browser sections (19 checks). `npm test` → 90/90 PASS on the Flex laptop (Crostini, Chromium 150 headless)
- [ ] **On the device:** Netflix CPU with Jharokha running vs without (DEVICE-CHECKS §G). Does ChromeOS report `hidden` when Netflix covers W-B (§D)? If not, Cinema is the manual switch
- Done when: Netflix uses no more CPU with Jharokha running than without it (device only)

### Week 3 · Server core ← built, waiting on the device run
- [x] Fastify 5 + @fastify/websocket + `node:sqlite` WAL (checkpoint TRUNCATE every 5 min and on stop) serving the PWA, samples and probe. `server/index.mjs` replaces the Week 0 zero-dependency server; every old route still works
- [x] `systemd --user` unit `jharokha.service` (the old `jharokha-probe` is removed by setup-crostini.sh). Enabled at boot, Restart=on-failure (kill -9 → back in < 3 s, checked on the laptop)
- [x] `/ws` pushes vitals every 2 s (uptime, req/s, devices, live links, DB size, disk free, RAM, load, errors). The app reconnects with backoff
- [x] Layer 2: Vitals Ring (Power · CPU · Network · Server, each with a reason; CPU falls back to Linux load when Compute Pressure is missing), Server panel, red "Server offline" badge (after 4 s), live QR
- [x] QR address: manual Wi-Fi IP (settable only via http://localhost) > learned from a phone's Host header > container IP (flagged amber: phones can't use it)
- [x] Tests: 5 unit + 4 server + 6 browser checks (including stopping and restarting the server: badge on, then off by itself) + 2 screenshots (`test-shot-week3-*.png`). `npm test` → 111/111 PASS on the laptop
- [ ] **On the device:** port forwarding 8080 on, phone scans the QR → `/lan.html` loads; reboot ChromeOS → server back with no taps (DEVICE-CHECKS §H)
- Done when: survives a reboot; Layer 2 shows server vitals ✅ (vitals; reboot needs you)

### Week 4 · Access ← built, waiting on the device run
- [x] QR → `/join` phone page → name → request pops up on every Layer 2 (approval tray; a "🔔 join request" pill over the wallpaper) → owner picks Collaborator / Viewer / Owner or ✕ → phone flips to "You're in" by itself
- [x] Device token: random 256-bit, stored hashed (SHA-256) in SQLite, sent as an `HttpOnly; SameSite=Strict` cookie, 30 days (owners slide while in use), revocable. Removing a device closes its live link at once
- [x] Owners = requests from inside Linux (127.0.0.1) or owner devices. The laptop's Chrome pairs once: `npm run pair` (and `npm run show`) opens `/app/?pair=<one-time 10-min code>`. Replaces the Week 3 "Host: localhost" rule, which a phone could fake
- [x] Kill switch (owner-only mode: guests get a 403 page, their sockets are closed; owners unaffected; the ChromeOS port-forward toggle itself stays manual), quiet hours (friends read-only, wraps midnight), audit log (last 2000 kept), rate limits (240 req/min per device, 6 join/pair tries per min per IP), max 20 devices
- [x] The QR quiet zone is fixed (1 → 4 modules; checked with `zbarimg`). The QR address is learned only from approved phones. New devices are logged to journalctl for diagnosing "the phone can't reach it"
- [x] Tests: 13 server checks (acting as a phone from the container's own address) + 7 browser checks (unpaired → pair → tray → approve → phone screen → kill → remove) + 4 screenshots. `npm test` → 133/133 PASS
- [ ] **On the device:** a friend's phone on the same Wi-Fi joins and gets approved (DEVICE-CHECKS §I). Blocked until a phone can reach the laptop at all (§E: port forwarding / client isolation)

### Week 5 · Collaborate + Layer 2 redesign ← built, waiting on the device run
- [x] Room Board: one Yjs doc on the server (`server/room.mjs`), synced over the existing `/ws` (state-vector handshake, offline edits resent on reconnect), saved to SQLite every 30 s and on stop. Viewers / quiet hours → edits refused (`room-readonly`). Max 60 notes
- [x] Door Sign (owner sets: Come in / Knock first / Busy / Studying / Sleeping / Away + note) → live on every screen and phone
- [x] Drop Zone: `PUT /api/drops` streamed to `DATA_DIR/drops` (one sequential write), 500 MB per device enforced while streaming, 7-day auto-delete + orphan sweep, uploader/owner delete, `attachment` + `nosniff` downloads
- [x] Owner remote: phone → server → dashboard window (W-A): Swap / Cinema / Night / wallpaper / scene; W-A reports the screen state back. Collaborators can't send commands
- [x] Phone room page `/app/room.html` (2nd Vite page): Board · Files · Remote tabs, door sign; `/join` → "Open the room"
- [x] **Layer 2 redesign:** laptop = control centre (header + Home · Wallpapers · Room · System tabs, balanced Home); monitor ≥ 1700 px = wall display (one-line huge clock, big door sign, sticky-note board, mini vitals ring, people, "Scan to join" QR; fits 1920×1080 and 2560×1440 without scrolling). SVG icons (no missing glyphs)
- [x] Connect-a-phone helper: big QR + live 4-step checklist (Wi-Fi IP · port forwarding · same Wi-Fi · "a phone reached this laptop" from server-side evidence) + the hotspot fallback
- [x] Tests: 8 server checks (real Yjs clients as phones) + 11 browser checks (laptop, phone, wall at two sizes) + 6 screenshots. Bundle budget now = dashboard initial JS (87 KB; Yjs 92 KB is lazy). `npm test` → 155/155 PASS
- [ ] **On the device:** a phone reaching the laptop at all (DEVICE-CHECKS §E/§I). No phone request has ever reached Linux so far → port forwarding or Wi-Fi isolation

### Week 6 · Fun layer ← built
- [x] Internet sharing (plan B for the Wi-Fi): Cloudflare quick tunnel, off by default, owner switch with a confirm step, persists, audited; strangers reach only the join flow. Installed (user-local, SHA-256 checked); public link verified from the internet
- [x] Watch-Party queue: links (YouTube → embeddable, images, DRM sites → link only), votes reorder it, real YouTube titles via oEmbed, adder/owner remove
- [x] Cast-to-Wall: collaborators ask → owner approves in the tray (or casts directly / from the queue) → YouTube embed / picture / link card on the wall window; the wallpaper pauses (decoder free) and comes back on Stop
- [x] Study Room Pomodoro: one shared timer (server owns phase changes; clock-skew corrected), focus/break lengths, a soft chime on the wall (never in quiet hours / Night / Cinema), big ring on the wall
- [x] Game Night scoreboard: players, ±, leader highlight, new round; owner clears; shown beside the sticky notes on the wall
- [x] Ink theme (paper + brush ink, Fraunces headings, uneven hand-drawn borders), mirrored to both screens; Night Watch redesign
- [x] Tests: 7 fun-server + 7 on-screen checks + screenshots (YouTube actually playing on the wall). `npm test` → 178/178 PASS
- [x] Audio-reactive canvas (needs the mic + Showcase mode): moved to Week 7, built there
- [ ] **On the device:** friends on their phones via the public link; a YouTube cast on the real monitor

### Week 7 · Utilities
- [x] Polls, laundry timers, Split & Settle (UPI deep links), sunrise alarm (`server/tools.mjs`, `ui/Tools.tsx`, `ui/ToolsCards.tsx`)
- [x] Showcase: audio-reactive canvas from the laptop mic (`ui/Showcase.tsx`, key V)
- [x] Phone remote for Netflix / YouTube tabs: "Jharokha Remote" Chrome extension (`extension/`), D-pad, touchpad, typing, player
- [x] Layer 1 Swap button
- [x] Calendar: room events with a date / time, reminder chime on every screen and phone (`addEvent` in tools.mjs, `CalendarCard`), the next 3 on the wall
- [ ] **On the device:** load the extension once (chrome://extensions → Load unpacked → Linux files/jharokha/extension); try Netflix from the phone; a real UPI payment link on Android + iPhone

### Week 8 · Harden ← built (19 Nov), the 72 h soak itself runs on the laptop
- [x] Nightly SQLite snapshot: `VACUUM INTO data/backups/` at 03:30 laptop time (W-A reports its time zone; Crostini runs UTC), newest 7 kept, files 0600, "Snapshot now" for owners (`server/harden.mjs`)
- [x] Ring-buffer logs: every console line → RAM ring (last 1000, System tab, filter warnings) + `data/logs/jharokha.log` rotating at 1 MB × 3 old files
- [x] Thermal guard: Compute Pressure serious/critical for 20 s → the wallpaper pauses on both screens (and frees its RAM after the usual 2 min); nominal/fair for 60 s → plays again. Reported to the server and the phone remote
- [x] `npm run soak` (`scripts/soak.mjs`): own server + headless dual-screen Chrome, swaps + room traffic, samples RSS / heap / videos every minute → CSV + JSON verdict (< 50 MB growth). A 12-minute run passed on the laptop (see DEVLOG)
- [x] Server no longer exits on an unhandled promise rejection (counted as an error + logged)
- [ ] **On the device:** the full 72 h soak; real CPU pressure triggers the guard (DEVICE-CHECKS · Week 8)
- [ ] HTTPS via a domain + DNS-01 **only if you approve the purchase**

### Extras (19 Nov): asked for directly
- [x] **Change the wallpaper from Layer 2**: poster strip (thumbnails made from RAM at import; old clips get one the next time they play) with ◀ ▶ on the laptop Home tab and the wall display footer; works from either screen; keys [ / ]; rotation (next every 5 / 15 / 30 / 60 / 120 min, prefetched 3 min early); phone remote ◀ ▶
- [x] **Stacked layers when swaps slow down**: one swap ≥ 2 s, two in a row ≥ 1 s, or a 3 s timeout → the wallpaper stays on its screen, Layer 2 is drawn over it (see-through cards, no blur), Swap shows / hides it, a banner on the other screen explains it with "Back to swapping". Auto on by default; "Stack now" by hand; phones can toggle it
- [x] Bug fixes: shortcuts no longer fire while typing in a select / textarea or with Ctrl/Alt (Ctrl+S swapped screens); quick wallpaper picks no longer get lost or overwritten by a slower earlier read; the monitor window now knows which wallpaper is playing
- Planned next (not built): restore a snapshot from the System tab (now a documented 1-line command in SETUP §6); per-scene rotation lists; a stable phone address for the Android app (ANDROID.md)

## Every week, when it's done
- Update `probe/updates.html` (newest week on top), then `npm run show`: it restarts the server and opens What's new + the app in ChromeOS Chrome on the laptop.

## Needs your decision later (not blocking)
1. A domain for LAN HTTPS. 2. A travel router, if the hostel uses client isolation. 3. Any hosting/deploy. Nothing gets deployed without a yes.
