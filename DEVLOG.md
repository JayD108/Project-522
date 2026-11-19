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

## 2026-11-18 · Consolidation: one runnable pipeline + one test log
Week 2 was paused (it hadn't started) to make Weeks 0–1 runnable from end to end.

**Audit (built vs stubbed)**
- Stub removed: the 🎬 Cinema button (it was disabled with "Week 2"). Cinema comes back in Week 2 as a working feature.
- Gap fixed: a fresh clone had no video to play. Added `samples/` (2 synthetic clips, 1.7 MB, H.264 + VP9) and a **Load sample wallpapers** button, served from `/api/samples` and `/samples/`.
- Gap fixed: no single command. `npm start` (`scripts/start.mjs`) checks Node, installs app deps if missing, builds, then starts the server. `start.sh` wraps it on Linux. `npm run dev` adds Vite hot reload, proxied to the server.
- Gap fixed: deleting the playing wallpaper was unguarded. It is now refused while playing, and deleting the current choice picks the next one.
- Gap fixed: the server now loads an optional `.env`, gives a clear message when the port is in use, answers 503 "App not built yet" if `app/dist` is missing, and only prints LAN URLs when HOST=0.0.0.0.
- Not stubs, by design: "Temp / fan: n/a" (ChromeOS doesn't expose these, per v2 §2).

**Tests**: `npm test` → `tests/run-all.mjs` → ONE log, `test-run-<local timestamp>.log`, with 7 sections: environment and deps, build, unit tests, server (including `npm start` itself), real playback in the video engine, single-screen fallback, dual-screen swap. Replaces `app/e2e/smoke.mjs`. A broken check is recorded as FAIL with a one-line reason, and the run continues.
- Found: headless Chrome's `getVideoPlaybackQuality().droppedVideoFrames` reads ~95 % in every window type while rVFC sees 30 fps. It's a headless artefact, reported but not gated; fps, hitches and seam are the gates.
- Result: 63/63 PASS in ~56 s on Windows / Chrome 157.

**Repo hygiene**: `.gitignore` extended (`.env*`, build output, DB/WAL files, logs and test logs, OS/editor junk). `.env.example` added (PORT, HOST, JHK_DATA; no secrets exist). The secret scan found nothing. `SETUP.md` covers Windows dev and ChromeOS/Crostini.

## 2026-11-18 · On the Flex laptop + Week 2 coexist, scenes and weather
**On the device (Crostini, Debian 13, Node 22.23.5)**
- `npm run test:quick` passed. `bash scripts/setup-crostini.sh` installed and started the `systemd --user` service (`jharokha-probe`, enabled at boot). `/health` OK, SQLite WAL, `/app/` 200.
- Installed `chromium` in Crostini so `npm test` runs the browser sections here too (software decode only; the numbers aren't real HW performance).

**Built** (`app/src/scenes.ts`, `app/src/weather.ts`, `app/src/ui/Week2.tsx`, Week 2 block in `host.ts`)
- One "dormant" rule: hidden, Cinema or Night Watch → pause now; after `YIELD_MS` (2 min, `?yield=` in debug) → dispose the player and drop the Blob. W-A also drops its fallback ref once W-B reports `released`, so the RAM is really freed. Wake: W-A re-reads once; W-B sends `need-clip` and W-A answers with `play` at the same position. A wallpaper picked while released is applied on wake, with no disk read while Netflix runs.
- 🎬 Cinema / 🌙 Night Watch are mirrored over the channel (`fx`) and sent to W-B on hello. Swap is ignored while either is on. Toasts are muted in Cinema.
- Scheduler ticks every 15 s on W-A. A scene change picks its wallpaper (a manual pick holds until the next boundary). The next clip is prefetched 3 min early if current + next ≤ 300 MB. Boot with Auto on picks the scene's wallpaper directly (still one read).
- Weather: Open-Meteo geocoding + forecast, no key, every 30 min plus on `online`. The last reading is kept in the batched settings for offline boots, and forwarded to W-B.
- Engine: `pause()`/`resume()` push stats immediately (the UI showed "playing" for up to 1 s after Cinema).

**Tests**: `npm test` → 90/90 PASS, three clean runs on the laptop. New: 8 unit tests and sections [8] and [9] (yield/release/re-read, Cinema, Night Watch, exclusivity, scheduler switch + prefetch with 0 reads at the boundary, reload, dual-screen release in both windows and recovery, swap after a yield). One earlier run had a VP9 software-decode hitch in [5] under CPU load (Crostini, no GPU). It didn't come back in reruns, so it isn't gated differently.

**Not testable here**: real occlusion → `hidden` under Netflix, CPU with/without, HW decode. All of these are in DEVICE-CHECKS §D and §G.

**Next**: you run DEVICE-CHECKS (§A–G) on this laptop with the monitor. Then Week 3: Fastify + ws server core, vitals ring, QR.

## 2026-11-18 · Week 3 server core
**Built**
- `server/index.mjs` (Fastify 5.12.8, @fastify/websocket 11.3.7, @fastify/static 10.1.9, qrcode 1.5.4; all versions ≥ 2 weeks old) with its own `server/package.json`. `npm run setup` / `npm start` / `setup-crostini.sh` install it. SQLite WAL with `wal_checkpoint(TRUNCATE)` every 5 min and on SIGTERM, plus a `kv` table. Cache policy is set in `onSend`: API no-store, files no-cache, sw.js no-store.
- `/api/vitals`, `/ws` (vitals + join info every 2 s, ping/pong), `/api/join`, `/api/qr.svg`, `POST /api/lan-host`.
- Phone address problem: Crostini can't see the ChromeOS Wi-Fi IP. Resolution order: manual IP (from the panel, accepted only when the request's Host is localhost; proper auth comes in Week 4) > the Host a phone actually used (stored in SQLite) > container IP, shown amber.
- App: `serverLink.ts` (one socket per window, backoff up to 15 s, 8 s watchdog, offline after 4 s), `ui/ring.ts` (pure rules, unit-tested), `ui/Week3.tsx` (Vitals Ring replacing the vitals strip, Server panel with QR + Set Wi-Fi IP, offline badge). Fullscreen button is now an SVG (⛶ had no glyph). The scene dropdown label is shortened.
- systemd: the unit is renamed `jharokha.service` and runs `--disable-warning=ExperimentalWarning`. setup-crostini.sh disables and removes `jharokha-probe`. Deployed on the laptop. `kill -9` → systemd restarted it in < 3 s.

**Checked myself**: two headless screenshots of the dashboard at 1366×768 (ring, panel, QR legible). I fixed what they showed: the missing ⛶ glyph, a cramped dropdown, and the link latency empty for 10 s. Installed `fonts-noto-color-emoji` in Crostini so screenshots match ChromeOS.

**Tests**: 111/111 PASS. The [5] VP9 software-decode check now gets one retry only for stutter, and the log keeps the first attempt ("RETRIED once (…)"). It showed 3–5 hitches in 2 of ~7 runs in Crostini (no GPU).

**Needs you**: the phone QR scan with port forwarding, and a reboot (DEVICE-CHECKS §H).
**Next**: Week 4 access: QR join → name → approval → roles → device token.

## 2026-11-18 · Phone scan didn't work + Week 4 access
**The scan**: the QR pointed at `http://192.168.10.69:8080/lan.html` (the IP you set), but the server got **no request** from any device except the laptop. Causes:
1. My QR had a 1-module quiet zone, below the 4-module minimum, and many phone cameras won't lock on. Now 4. Decoded with `zbarimg` from a rendered screenshot → `http://192.168.10.69:8080/…`.
2. The network path (not testable from inside Linux): ChromeOS port forwarding for 8080, the phone being on the same Wi-Fi (not mobile data), and hostel client isolation. The server now logs every new non-laptop device to journalctl, so the next try shows whether the phone got through.

**Built (Week 4)**: `server/access.mjs` (devices + audit tables, hashed tokens, pairing, kill, quiet, limits) wired into `server/index.mjs`. `/join` page (`probe/join.html`). App: `ui/Week4.tsx` (approval tray, request pill, Access card, Pair notice) and `serverLink.ts` (pairing from `?pair=`, `hello`/`access`/`denied` messages; 4401/4403 closes don't count as "offline"). `npm run pair`, and `npm run show` now pairs too.
- Security fix: Week 3 trusted `Host: localhost`, which anyone on the Wi-Fi can send. Now only 127.0.0.1 (inside Linux) or a paired/approved owner device is trusted. Owner POSTs need JSON + SameSite=Strict cookies (no cross-site form posts), and authenticated APIs carry no `Access-Control-Allow-Origin: *`.
- Found by testing: a LAN-IP origin is not a secure context, so OPFS and window management are off there. The laptop must use `http://localhost:8080` (it does). The test Chrome treats its LAN test origin as secure.
- Found by screenshots: the ⏻ glyph was missing, the owner could remove their own screen (now "this screen"), and the audit showed raw device ids.

**Tests**: 133/133 PASS.
**Next**: Week 5: Room Board (Yjs), Door Sign, Drop Zone, phone remote for owners.

## 2026-11-18 · "QR does nothing" (round 2) + Week 5 room + Layer 2 redesign
**The phone**: the server has **never** received a request from any device other than the laptop (journal + `ss`). Linux listens on 0.0.0.0:8080, so the traffic stops before Linux: ChromeOS port forwarding, the phone not on the same Wi-Fi, or hostel client isolation. None of these can be changed from Linux. Built instead:
- a **Connect-a-phone** helper (Home → People → "Connect a phone", and System tab): big QR, the URL to type, and a live checklist. Step 4 turns green from server-side evidence (`lastOutside`, persisted) when any phone actually gets through, with the phone-hotspot fallback spelled out.
- Option not taken without your OK: an internet tunnel (e.g. a Cloudflare quick tunnel) works even with isolation but exposes the room to the internet (v2: deploys need a yes).

**Week 5**: `server/room.mjs` (Yjs board, door, drops), the remote relay in `/ws`, `app/src/room/roomClient.ts` (lazy Yjs), `ui/Room.tsx` (shared components), the phone page `room.html` + `room/RoomApp.tsx`, `ui/Layer2.tsx` (control centre + wall display), `ui/Icon.tsx`.
**Found by screenshots and fixed**: Home had an empty third column (now two balanced columns), the 1080p wall clock wrapped to two lines (now one line with the door sign beside it), and the modal close ✕ overlapped step 1.
**Found by tests and fixed**: TDZ of a test constant; old tests needed to switch tabs; the bundle budget now counts only the dashboard's initial JS.
**Tests**: 155/155 PASS (one earlier run failed the known VP9 software-decode stutter after its retry; clean on rerun).
**Next**: Week 6 fun layer: Watch-Party queue, Cast-to-Wall, Study Room Pomodoro, Game Night, ink theme.

## 2026-11-18 · Night Watch redesign + "site can't be reached" plan B
**Night Watch**: Fraunces 200/300 (OFL, bundled in `app/src/fonts`, precached, so it works offline), deep red #7a1d17 at min(26vw, 46vh), blinking colon, minute bar, date, ±2 % drift per minute against burn-in. Wake: any tap/click or any key (handled once in host.ts). The cursor is hidden only while idle; a pointer move shows it plus a hint. Before, it was `cursor: none` with a tiny button or a double-click.
**Phones**: from inside Linux even `curl http://192.168.10.69:8080` and `ping` get no answer, so phone traffic doesn't come through ChromeOS on that address (port forwarding off, a wrong IP, or the Wi-Fi). Plan B built: `server/tunnel.mjs`, a Cloudflare quick tunnel that is **off by default** and that an owner switches on in Connect a phone (with a confirm step). It persists across restarts and is audited. Internet requests (127.0.0.1 + `*.trycloudflare.com` Host) are never treated as the laptop; non-members reach only `/join`, `/api/me|join|leave`, and the phone page's files; HTML pages redirect (302) to /join. The rate limit and the device IP use CF-Connecting-IP.
- Installing cloudflared system-wide needs you: `npm run tunnel:install` (pinned 2026.10.7 .deb from Cloudflare's GitHub). My own attempt was blocked by the permission system.
- Found by tests: a redirect sent with status 403 (browsers ignore Location on it), and an unhandled spawn error that would crash the server if the binary path is missing.
**Tests**: 163/163 PASS (new: 3 Night Watch, 6 tunnel checks with a stand-in cloudflared).

## 2026-11-18 · Public link working + Week 6 fun layer
**Phones**: you ran `npm run tunnel:install` (user-local cloudflared 2026.10.7, SHA-256 matched). Checked from the internet through Cloudflare: /join, /api/me, /app/room.html → 200 (< 1 s); /api/vitals, /health → 403 for strangers. The QR now shows the public link. Note: quick-tunnel links change whenever the server restarts; the QR follows automatically.
**Week 6**: `server/fun.mjs` (queue, casts, pomodoro, game; JSON in kv, saved ≤ 10 s), routes in index.mjs (`needWriter` = collaborator/owner, not in quiet hours; casting and stopping are owner-only). App: `ui/Fun.tsx`, a Fun tab on the laptop and the phone, wall additions (timer ring replaces the vitals ring while a session runs, scoreboard beside the notes, "Up next" in the footer), cast requests in the approval tray, a cast overlay on the wall window (`castHere` makes the wallpaper dormant), ink theme (`data-theme="ink"`, mirrored through the channel).
**Found by screenshots**: the cast screen stayed black while YouTube loaded (now a title card + the bar shows for 5 s), ink buttons styled the tabs, swatches and links (scoped), and the queue showed "YouTube" as the title (oEmbed now).
**Found by tests**: the runner kept every section's Chrome open until the end and ran out of room (now freed per section); a test helper sent a JSON content-type on DELETE.
**Tests**: 178/178 PASS.
**Next**: Week 7 utilities: polls, laundry timers, Split & Settle (UPI), sunrise alarm, and the audio-reactive canvas.

## 2026-11-18 · Refinements: open files, play links, "same Wi-Fi only"
- Files: click a name → `FileViewer` (image / video / audio / PDF / text; others download). `/api/drops/:id?inline=1`: inline only for png/jpeg/gif/webp/avif, mp4/webm/ogg/mov, audio, pdf and text; HTML/SVG always download; `CSP: sandbox` on inline (not PDF, which Chrome won't render sandboxed); Range support (206) so videos seek. Owners: "Wall" for pictures and videos (`/api/fun/cast/drop/:id`, new cast kind `video`).
- Links: a queued YouTube title / "Play here" → `PlayerModal` on this screen; other links → "Open" in a new tab; "Wall" unchanged.
- Same Wi-Fi only (`server/netguard.mjs`, default ON): over the internet link, the phone's public address (CF-Connecting-IP) must share the laptop's public network (IPv4 /24, IPv6 /48; the laptop's address comes from Cloudflare's trace endpoint every 10 min; currently 139.5.199.0/24). Everything else gets "use the room's Wi-Fi", including approved members; owners see "Refused recently" with "Trust this network". Mode "Anywhere" lets approved people in from any network. Switching back closes outside live links.
- Room code: the QR link carries `?k=` (6 chars, rotates every 10 min, the previous code is still accepted for one period); joining without it → 403 "scan the QR". Inside Linux (127.0.0.1) needs no code.
- Tests: 192/192 (new: rotation/prefix unit checks, 5 network-guard checks, 7 open-on-laptop checks).

## 2026-11-18 · Phone remote, cast-from-phone, roles, secure file chain, phone UI
- Media remote: the wall window (`CastOverlay`) owns one controller (`<video>`/`<audio>` directly; YouTube via the iframe API over postMessage: `enablejsapi=1`, `listening` → `infoDelivery`). Phones send `{t:'media'}` (toggle/seek/seekTo/volume/mute); the server relays only from owners or whoever cast it (`casting.byDev`), and the wall reports `media-state` every 1 s.
- Cast from phone: `castFile` = upload to the drop zone → `/api/fun/cast/drop/:id` (owners show it at once; others → request in the tray). New `audio` cast (equaliser card). Whoever cast it can also stop it.
- Apps: Netflix / Prime Video / YouTube / Google tiles (our own simple SVG marks). Laptop: open in a new tab. Phone: "Open on PC" → `open-request` (https only) → one-tap banner on W-A (browsers only open tabs on a user tap).
- People: `POST /api/devices/:id/role` (owner; live link reconnected with 4000), `POST /api/me/role` (step down only), leave; kick = revoke. Dashboard: role select + "Kick out"; phone People tab.
- File chain (`server/vault.mjs`): AES-256-CTR at rest with a per-file IV and the key in DATA_DIR/keys/drops.key (0600; dirs 0700; files 0600). Range decrypt keeps video seeking. The MIME type comes from magic bytes (a claimed type is ignored; unknown types → octet-stream, download-only). JPEG APP1/APP13 removed while streaming (GPS, model, time). Files uploaded before this stay readable (no IV → plaintext path) and expire within 7 days.
- Cookies over the https tunnel are `Secure`.
- Phone UI redesign (`room/RoomApp.tsx`): header with avatar and role, hero cast card / media remote, 5-tab bar, 44 px touch targets.
- Tests: 208/208 PASS (new: 8 secure-chain/roles/media server checks, 7 phone browser checks incl. a real file picked on the phone → playing on the PC → paused / volume / seek / mute from the phone).

## 2026-11-18 · "Netflix buttons don't work" + reels
**Why it failed**: the audit log shows every tap arrived (Netflix ×4, Prime, YouTube, Google, from the iPhone) and was relayed to the laptop. But (1) the laptop window still ran the pre-19:46 build, which had no "open on PC" handler (open windows keep old code until they reload), and (2) even the new build needed a second tap on the laptop (browsers only open windows on a user tap).
**Fixes**: an **apps window**: the first tap (on the prompt, or on any laptop tile) opens a named window on the wall screen and we keep its handle; later requests set `appWin.location.href` (navigating a window you opened needs no tap). **Update notices**: the server sends its build (hashed main script) in `hello`; phones reload automatically, the laptop gets a "Reload" pill (an auto-reload would drop dual-screen), and the start screen reloads by itself.
**Reels**: `classify` → kind `reel` for Instagram (/reel, /reels, /p, /tv → /embed, tracking params dropped), TikTok (/video/ID → embed/v2), Facebook (/reel, /watch, /…/videos → plugins/video.php). Short links (vm.tiktok.com, fb.watch, instagr.am, facebook.com/share/…) are expanded server-side (≤ 3 redirects, 4 s). Wall: upright 9:16 frame with a side note. These embeds allow no remote control (YouTube Shorts → full remote). Phone: Paste button (clipboard on https), "How to cast a reel" help; Android share_target in the manifest (installed PWA) prefills the link.
**Tests**: 210/210 PASS (new: apps window, first tap then no tap, verified through the browser's targets; reel cast; paste/help/build).

## 2026-11-19 · "Tapping Netflix on the phone shows nothing on the screen"
**Why**: the laptop could only open a phone's request after someone tapped "Open" on the laptop (browsers block pop-ups without a tap there), and the prompt was easy to miss.
**Fix**: the server now opens known apps (Netflix, Prime Video, YouTube, Google, Hotstar, JioCinema, SonyLIV, ZEE5, Disney+, Spotify; https, exact host match) straight into ChromeOS Chrome with `garcon-url-handler` (no tap, no pop-up rule). Other https links still need the one tap on the laptop. The laptop shows "Dev opened Netflix on this PC"; the phone shows the real result (opened / tap on the laptop / no laptop screen). `JHK_OPENER` sets the opener ("none" = off); the test runner sets "none" so tests never open tabs on this laptop.
**Tests**: 210/210 PASS (the open-on-PC check now uses a stand-in opener: Netflix opened directly, example.com and a look-alike host get the prompt, javascript: dropped).

## 2026-11-19 · Week 7 utilities + full phone remote for streaming tabs + Layer 1 Swap button
**Layer 1 Swap button**: bottom-centre on the wallpaper (`.l1-swap`), swaps directly (one screen: opens the dashboard). Toasts move up above it.
**Phone remote for Netflix / YouTube / Prime…**: a web page can't control another site's tab, so `extension/` is a small MV3 Chrome extension ("Jharokha Remote", loaded once with Load unpacked). Its service worker keeps a WebSocket to `ws://localhost:8080/ws` (role `X`, accepted only from inside this machine, never over the tunnel). Phones send `{t:'app', cmd, arg}`; the server checks the command list and argument shapes (`appArg`), allows owners + collaborators, and relays. The content script (only on the streaming hosts) draws a pointer and a highlight ring, sends real-looking pointer/mouse events, does TV-style arrow navigation, types with `insertText`, and drives the player through the site's own API (`page.js`, MAIN world: Netflix's player session, YouTube's `movie_player`) with a `<video>` fallback. It reports title / time / volume / "Skip intro|ad" back every second. "Open on PC" now goes to the extension first (one reusable full-screen window on the wall screen), then garcon-url-handler.
- Limits: synthetic events aren't "user gestures", so if Chrome holds a video's sound for autoplay, one touch on the laptop is needed (the phone says so). Site buttons that need a real gesture (e.g. YouTube's own full-screen) are covered by window full screen + a fill style.
**Week 7** (`server/tools.mjs`, `/api/tools/*`, `tools` + `tools-ding` over /ws): polls (one vote each, auto-close), laundry timers (ding to every screen/phone), Split & Settle (paise integers, equal split that adds up exactly, fewest transfers, UPI deep links `upi://pay?pa=…&am=…&cu=INR`, UPI ID format checked, only payer/payee/owner record a settlement), sunrise alarm (owner sets time/days/ramp; the wall computes local time since Crostini runs UTC; "I'm up" / Snooze 9 min from any screen or phone; "Test now" = 20-second sunrise). Showcase (`ui/Showcase.tsx`): mic → AnalyserNode → 96 log-spaced bars, ~30 fps, no output node; falls back to a generated rhythm without a mic. The Tools cards and Showcase are lazy chunks (dashboard initial JS budget).
**Found by screenshots and fixed**: phone Tools tab overflowed the screen (rows didn't wrap), the "done" banner was squashed on phones, the toast covered the new Swap button, the Start button stuck out of its card.
**Found by tests and fixed**: poll choices typed quickly overwrote each other (stale state; now functional updates), a newly approved person didn't appear in Split until something else changed (tools now re-broadcast on access changes), dashboard initial JS went 1 KB over budget (lazy chunks).
**Tests**: 237/237 PASS (new: 11 extension checks in a real Chromium with a fake https "YouTube", 7 Week 7 server checks incl. restart persistence, 7 Week 7 screen checks incl. sunrise and mic showcase, 1 Layer 1 Swap button check).

## 2026-11-19 · Week 8 harden + Layer 2 wallpaper switcher + stacked layers + calendar
**Asked for**: change the wallpaper straight from Layer 2; when swaps slow down, put both layers on one screen; finish what was left; plan and build extra features and fixes.
**Wallpaper switcher** (`ui/Week8.tsx`): a poster strip with ◀ ▶ in Home → Now playing (laptop) and in the wall display's footer (monitor). Posters are 192 px JPEGs made at import from the file already in memory (`makeThumb`); older clips get one the next time they are read. The monitor asks W-A (which owns the library); W-A now mirrors `currentId` to W-B (`{t:'current'}`) so the monitor highlights what's playing. Keys `[` / `]`. Rotation: off / 5 / 15 / 30 / 60 / 120 min, next clip prefetched 3 min early, skipped while covered. Phone Screens card: ◀ name ▶ + Stack.
**Stacked layers** (`setStacked` in host.ts, rule in `stacking.ts`): one swap ≥ 2 s, two in a row ≥ 1 s, or the 3 s handover timeout (also from W-B via `swap-timeout`) → `stacked` on both windows. The Layer-1 window keeps the video and opens Layer 2 over it (`.panel.stacked`: see-through cards, no backdrop blur, which would re-composite the video every frame). Swap/S/the phone only show or hide that panel (`stackOverlay`, mirrored). The other screen shows a banner with "Back to swapping". Auto is on by default (System → Keep it running), "Stack now" by hand, and phone `stack` remote command. A monitor drop clears it.
**Week 8** (`server/harden.mjs`): console → RAM ring (1000 lines) + `data/logs/jharokha.log` (1 MB × 3 old; Node's ExperimentalWarning counts as a warning). `VACUUM INTO data/backups/jharokha-<utc>.sqlite` nightly at 03:30 laptop time (W-A reports its offset in screen-state; Crostini is UTC), 7 kept, 0600, owner "Snapshot now". Owner APIs `/api/system/logs|backups`, `/api/system/thermal`. The thermal guard (W-A): Compute Pressure serious/critical 20 s → `thermalHold` → dormant on both screens (pause, then release after the usual 2 min); 60 s of nominal/fair → back. The server is told and logs it. Server: `unhandledRejection` is counted and logged instead of exiting.
**Calendar** (the optional Week 7 item): `addEvent`/`deleteEvent` in tools.mjs. The client sends epoch ms from its local date and time, so the server never needs the time zone. A reminder `tools-ding` (kind `event`) goes to every screen and phone; past events drop off after a day. Laptop Tools tab, phone Tools tab, and the next 3 (7 days) on the wall.
**Soak** (`npm run soak`, `scripts/soak.mjs`): its own server + headless dual-screen Chromium; a swap every cycle, a wallpaper change every 10, poll/calendar traffic, a snapshot every 5; samples RSS (server; Chrome process tree), both JS heaps and the `<video>` count every minute → CSV + JSON. 9-minute run on the laptop: server 82 MB flat, heaps 3 MB flat, 2 videos, Chrome a single +130 MB step at the first wallpaper change (a second codec loaded) and then flat at ~1.18 GB → PASS. The 72 h run is for you (DEVICE-CHECKS · Week 8).
**Bugs found and fixed**: shortcuts fired inside selects/textareas and with Ctrl/Alt (Ctrl+S swapped screens); picking wallpapers quickly lost the second pick, and an earlier, slower read could overwrite a newer one (`selectSeq`); the monitor never knew the current wallpaper. Found by tests: the dashboard initial JS hit 152 KB (the System card is now a lazy chunk; main = 59.7 KB); the soak counted `<video>`s mid-fade.
**Not done (needs you or a decision)**: the 72 h soak and real CPU pressure on the device; HTTPS/domain (needs approval). Also: running the soak and `npm test` together makes the software-decode "hitches" check fail (CPU contention), so run them one at a time.
**Tests**: 262/262 PASS (new: 4 unit tests for the slow-swap rule, 8 Week 8 server checks, 13 browser checks across the two emulated screens, plus screenshots `test-shot-stack-*.png` and `week8-*.png`).
**Next**: the 72 h soak on the laptop, then the Android app (ANDROID.md).

## 2026-11-19 · Android owner controller (Phase 0 + 1 of ANDROID.md)
**Asked for**: an Android version of the controller that only the owner uses. Decided with the user: native Kotlin + Compose, in `android/` of this repo.
**Server**: `POST /api/pair/phone` (owners) → one-time 32-hex code (10 min, kv `pairPhone`) + an SVG QR of `jharokha://pair?u=<tunnel or Wi-Fi base>&c=<code>`. `/api/pair` is added to the internet link's open list (the same-Wi-Fi guard and the 6/min limit still apply). `GET /api/version` → `{api: 1, build, server}`. The dashboard Access card gets a "Pair my phone (Android app)" button with the QR in a modal. The pair error text now mentions the phone path.
**App** (`android/`, see its README): OkHttp + org.json, no other networking or JSON libraries. The token is in the `jhk_dev` cookie header (no server auth change), encrypted at rest with a Keystore AES-GCM key, backups off. One `/ws` link with backoff; 4401 → `/api/me` → signed out if removed; 4000 → reconnect at once. Five tabs: Home, Wall, Remote, People, Tools. Volume keys drive the laptop on Wall/Remote. The QR comes from Google's code scanner (no CAMERA permission).
**Checked on the emulator** (headless, local server on :8091 with a temp data dir, a stand-in W-A + extension socket): paired from the real `/api/pair/phone` payload via deep link; approve a join; door sign; cinema + wallpaper next reached W-A and the state came back; OK, ▲, touchpad moves; volume keys 50→55→60→55; 45-minute timer; revoke → back to the pair screen; server stop → "Connecting…" → back by itself.
**Bugs found and fixed**: the pair screen's subtitle was black on black (no Surface around it); the People tab icon rendered as a colour emoji; Android replays the launching `jharokha://pair` link after a reinstall, so the app retried a spent code ("expired") → the app now remembers the last code the laptop answered and skips it; an XML comment had `--`; my own edit put a raw NUL byte into a regex in access.mjs (rewritten as `\u0000-\u001f`); the root `.gitignore` rule `data/` also hid `android/.../owner/data/*.kt` → now `/data/`.
**Tests**: on this Windows PC, `npm test` = 243 PASS, 20 FAIL; the untouched code gives 243 PASS, 19 FAIL here (Windows-only: fake cloudflared can't spawn, SIGTERM restarts, file modes, extension tabs). The one extra is the new pairing test, whose only failing check needs the tunnel. It must pass on the laptop (Crostini). Android: 6/6 unit tests, debug APK builds.
**Not done**: a real phone on the real laptop (you); Phase 2 (foreground service + notifications, share sheet, media notification); a release signing key (yours to make); a stable address (domain, needs approval).
