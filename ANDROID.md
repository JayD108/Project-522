# Jharokha for Android: handoff and plan

Written 2026-11-19. This is the working document for the Android app. It records where the project stands, how the existing system works (the parts an Android app must talk to), the plan, and the open decisions. Update it as work moves on: tick boxes, add decisions to the log at the bottom.

---

## 1. Where things stand

**Built (Weeks 0–7, 237/237 tests passing, `npm test`):**
- **Laptop (ChromeOS Flex, server inside Crostini/Linux):** a Node server (`server/`) on port 8080, run as a systemd `--user` service named `jharokha`. A dashboard PWA (`app/index.html`) on two screens: Layer 1 = looping video wallpaper, Layer 2 = control centre. A wall layout appears at ≥1700 px.
- **Phones today:** a web page, `app/room.html` (`app/src/room/RoomApp.tsx`), with tabs Home · Share · Board · Fun · Tools · People. It is reached **only through a Cloudflare quick tunnel** (`*.trycloudflare.com`). Direct Wi-Fi never worked (hostel client isolation / ChromeOS port forwarding).
- **Jharokha Remote** (`extension/`): an MV3 Chrome extension on the laptop, so phones can control Netflix/YouTube tabs (D-pad, touchpad, typing, player, skip, full screen). It must be loaded once by hand (see `probe/updates.html`).
- **Week 7:** polls, laundry timers, Split & Settle (UPI links), sunrise alarm, Showcase (mic visualizer), Layer 1 Swap button.

**Not done yet:**
- [ ] **Git commit + push** (blocked for Claude; the user runs it):
  `git config user.name "Mrittunjay Dubey" && git config user.email "193692681+JayD108@users.noreply.github.com" && git commit -F .git/JHK_COMMIT_MSG && git push origin main`
  Repo: `github.com/JayD108/Project-522`.
- [ ] Load the extension on the real laptop and run the Week 7 items in `docs/DEVICE-CHECKS.md`.
- [ ] Week 8 hardening: nightly SQLite snapshot, thermal guard, 72 h soak, ring-buffer logs.
- [ ] Optional Week 7 calendar.

More detail: `DEVLOG.md` (newest at the bottom), `TASKS.md`, `README.md`, `SETUP.md`, `docs/DEVICE-CHECKS.md`.

---

## 2. What the Android app is for

The phone side of Jharokha, made into a real app. The web page works, but a native app can do things a browser page can't:

| Want | Why the web page can't (well) | Android gives us |
|---|---|---|
| Notifications when the laundry is done, the sunrise alarm rings, a cast/join request comes in | Web push needs HTTPS + a service worker on a stable origin; the tunnel URL changes on every restart | Local notifications from a foreground connection, or FCM |
| Remote that feels like a TV remote: hardware **volume keys** control the PC, haptics, lock-screen / notification media controls | Pages can't read volume keys or post media sessions for another device | `MediaSession` + notification controls, `KeyEvent` handling, `Vibrator` |
| Share **from** any app (Instagram reel, YouTube, photos) straight to the wall | `share_target` only works for an installed PWA, and only some browsers | Android share sheet (`ACTION_SEND`) |
| UPI payments in Split & Settle | `upi://` links behave differently per browser | `Intent(ACTION_VIEW, upi://…)` chooser, and a result callback |
| Find the laptop without retyping a changing link | Quick-tunnel URL changes on restart | Pair once with a QR code; then discover the URL (see §5) |
| Stay signed in | Cookies can get cleared | Store the device token in `EncryptedSharedPreferences` |

**The laptop side doesn't change.** The app is a new client of the same server API, so it adds no second backend.

---

## 3. How the existing system works (the contract the app must follow)

### 3.1 Identity and access (`server/access.mjs`)
- Each phone is a **device** with a random token. The token is stored **hashed** on the server and sent as cookie `jhk_dev` (HttpOnly, SameSite=Strict, Secure over the tunnel). It lasts 30 days; owners get a sliding 30 days.
- **Joining:** `GET /join?k=<room code>` → `POST /api/join {name, k}` → the device is `pending`. An owner approves it from the laptop tray or a phone: `POST /api/devices/:id/approve {role}`.
- **Roles:** `owner`, `collaborator`, `viewer`. In quiet hours friends count as viewers. `POST /api/me/role` can only step down; `POST /api/leave` leaves.
- **Room code** `k`: 6 characters, rotates every 10 min (the previous code still works for one period). It is carried in the QR. A join without it gets 403 "scan the QR".
- **Same Wi-Fi only** (`netguard.mjs`, on by default): over the tunnel the phone's public IP (`CF-Connecting-IP`) must share the laptop's public /24 (IPv6 /48). An owner can switch it to "Anywhere".
- **Trusted laptop:** a request is treated as the laptop only if it comes from 127.0.0.1 inside Linux **and** is addressed to `localhost`. Never over the tunnel.
- **Owner POSTs** need `content-type: application/json`. Authenticated APIs send no CORS `*`.

**For the app:** keep the same flow, but the app holds the token itself and sends `Cookie: jhk_dev=<token>` on every HTTP and WebSocket request. Capture the token from the `Set-Cookie` header of `POST /api/join`. Never log the token.

### 3.2 HTTP API (all JSON; errors are `{error}` with a 4xx)
- **Me / joining:** `GET /api/me`, `GET|POST /api/join`, `POST /api/leave`, `POST /api/me/role`, `POST /api/pair`, `POST /api/pair/new` (laptop only)
- **Access (owners):** `GET /api/access`, `POST /api/devices/:id/:action` (approve, deny, role, revoke), `POST /api/kill`, `POST /api/quiet`, `POST /api/netguard`, `GET|POST /api/tunnel`
- **Room:** `GET /api/room` → `{door, drops, canWrite, owner, you}`, `POST /api/door`, `PUT /api/drops?name=&type=` (raw body upload), `GET /api/drops/:id[?inline=1]` (supports Range), `DELETE /api/drops/:id`
- **Fun:** `GET /api/fun`; queue `POST /api/fun/queue`, `POST …/:id/vote`, `DELETE …/:id`; cast `POST /api/fun/cast`, `POST /api/fun/cast/queue/:id`, `POST /api/fun/cast/drop/:id`, `POST /api/fun/cast/stop`, `POST /api/fun/cast/:id/approve|deny`; `POST /api/fun/pomo/:action`, `POST /api/fun/game/:action`
- **Tools (Week 7):** `GET /api/tools`; `POST /api/tools/poll`, `POST …/poll/:id/vote {option}`, `POST …/poll/:id/close`, `DELETE …/poll/:id`; `POST /api/tools/timer {label, minutes}`, `DELETE …/timer/:id`; `POST /api/tools/expense {what, amount, paidBy?, split[]}`, `DELETE …/expense/:id`, `POST /api/tools/settle {to, from?, amount}`, `POST /api/tools/clear`, `POST /api/tools/upi {vpa}`; `POST /api/tools/alarm {on,time,days,rampMin,sound}` (owner), `POST /api/tools/alarm/dismiss|snooze|test`
- **Misc:** `GET /api/vitals`, `GET /api/qr.svg`, `GET /health`, `GET /ping`

### 3.3 WebSocket `/ws` (JSON messages, same cookie)
- **Server → phone:** `hello {me, build}`, `vitals`, `access` (owners), `denied`, `door`, `drops`, `fun`, `tools`, `tools-ding` (timer done), `room-update` (Yjs, base64), `room-readonly`, `screen` (what the laptop screens are doing, owners), `media-state`, `app-helper {on}`, `app-state` (what's playing in the Netflix/YouTube tab), `remote-ack`, `pong`.
- **Phone → server:**
  - `iam {role:'room'}`
  - `room-sync {sv}` / `room-update {u}` (board, Yjs)
  - `remote {cmd: swap|cinema|night|showcase|scene|wallpaper, arg}` (owners)
  - `media {cmd: toggle|play|pause|seek|seekTo|volume|mute|unmute|stop, arg}`
  - `open-request {url, title}`
  - `app {cmd, arg}`: streaming-tab remote. `move|scroll {dx,dy}`, `click`, `nav up|down|left|right`, `ok`, `back`, `browse`, `home`, `reload`, `type {text, enter}`, `key enter|backspace|escape|space|tab`, `search "<q>"`, `toggle|play|pause`, `seek ±s`, `seekTo s`, `volume 0–100`, `mute`, `fullscreen`, `skip`, `close`, `focus`
  - `ping`
- Close codes: `4401` = not approved / access removed, `4403` = refused, `4000` = role changed (reconnect).
- The board uses **Yjs**: the app needs a Yjs-compatible CRDT (see §6), or it shows the board read-only from a server snapshot.

### 3.4 Data types to mirror
`AppState`, `ToolsState` (`Poll`, `Timer`, `Expense`, `Transfer`, `Alarm`), `FunState` (`QueueItem`, `Pomo`, casting), `ScreenState`: see `app/src/room/roomClient.ts`. **Money is in paise (integers).**

---

## 4. Approach: recommendation

| Option | Effort | Notes |
|---|---|---|
| **A. TWA / WebView wrapper** around `room.html` | very low | Fast, but the changing tunnel URL breaks it and native features are thin. Not worth it alone. |
| **B. Capacitor** (reuse the Preact UI + native plugins) | low–medium | Reuses `RoomApp.tsx` and every card. Add plugins for notifications, share intent, volume keys, secure storage. |
| **C. Native Kotlin + Jetpack Compose** | high | Best feel (remote, haptics, media controls), but every screen is rewritten. |

**Recommended: B (Capacitor) first, with native code where it matters.** Reuse the existing room UI unchanged. Add native pieces for: secure token storage, a foreground WebSocket service + notifications, the share target, volume keys → `media`/`app` volume, `upi://` intents, and QR pairing with the camera. If the remote needs to feel better later, rewrite just the remote screen in native Compose inside the same app.

Decision still open (see §8). The plan below assumes B.

---

## 5. The blocker to solve first: a stable address

Phones reach the laptop only through a **quick tunnel whose URL changes on every server restart**. An app can't hard-code it. Options:

1. **Named Cloudflare Tunnel + a domain** (e.g. `room.<yourdomain>`): stable, HTTPS, free tunnel, domain about ₹800/yr. **Needs your approval and a Cloudflare account** (open offer since Week 6). Best long term; it also enables FCM/web push.
2. **Pairing payload with a lookup:** the QR holds a room ID plus a secret; the laptop publishes its current tunnel URL somewhere the app can read it (needs a small always-on service, which is extra hosting and also needs approval).
3. **Re-scan the QR after each restart:** zero cost, poor experience. Fine for the very first prototype.

**Plan:** prototype with 3; move to 1 once approved.

---

## 6. Next moves (phased)

### Phase 0 · Prep (on the laptop repo)
- [ ] Commit + push the current work (command in §1).
- [ ] Decide: Capacitor vs native (§4), and the stable address (§5).
- [ ] Add a versioned API marker: `GET /api/version` → `{api: 1, build}`, so the app can warn about mismatches.
- [ ] Add **token auth by header** for the app: accept `Authorization: Bearer <token>` the same way as the `jhk_dev` cookie (WebSocket too, via a header or a `?t=` first message, never in logged URLs). Add tests.
- [ ] Add an app pairing flow: a QR that also carries `{url, k}` (it already carries `?k=`); the app reads it with the camera.

### Phase 1 · App skeleton
- [ ] New folder `android/` (Capacitor project pointing at a phone build of `app/room.html`).
- [ ] Join / approve / roles flow works in the app; token kept in `EncryptedSharedPreferences`.
- [ ] Phone UI from `RoomApp.tsx` running inside; API base URL from the stored pairing, not `location`.
- [ ] Builds: debug APK on a real Android phone (the user's friends use Android; the user's own phone is an iPhone, so iOS stays on the web page for now).

### Phase 2 · Native features
- [ ] Foreground service keeps `/ws` open while the app is in use; local notifications for `tools-ding`, the alarm ringing, join/cast requests (owners).
- [ ] Share target: links (reels/YouTube) → cast or queue; images/videos → `PUT /api/drops` → cast.
- [ ] Volume keys → `media volume` / `app volume` while the Remote is open; haptics on D-pad.
- [ ] Media notification with play/pause/±10 s for what's on the wall (`media-state` / `app-state`).
- [ ] UPI: `Intent(ACTION_VIEW, Uri.parse(upiLink))` with a chooser; on return, offer "I paid".

### Phase 3 · Polish and release
- [ ] App icon/splash from `app/public/icon-512.png`; dark theme tokens from `app/src/styles.css`.
- [ ] Permissions kept minimal: INTERNET, CAMERA (QR only), POST_NOTIFICATIONS, FOREGROUND_SERVICE (data sync).
- [ ] Signed release APK (side-load for the room). A Play Store listing only if you decide to publish (approval needed).
- [ ] Tests: extend `tests/run-all.mjs` for the bearer-token API; an instrumented smoke test in the app.

---

## 7. Rules carried over (don't break these)
- Never expose the laptop to the internet beyond what the tunnel + same-Wi-Fi guard allow. The app must respect `4401`/`4403` and the "use the room's Wi-Fi" refusal.
- Never log tokens, typed text (`app type`/`search` are audited without content), or UPI IDs beyond the room.
- Money stays integer paise end to end.
- Nothing gets deployed, published or bought without the user's yes (domain, Play Store, hosting).
- After each step: run `npm test`, look at screenshots, show the result on the laptop (`probe/updates.html` + `npm run show`).

---

## 8. Open decisions (for the user)
1. **Capacitor (reuse the web UI) or native Kotlin/Compose?** Recommendation: Capacitor.
2. **Stable address:** buy a domain + named Cloudflare Tunnel now, or prototype with QR re-scan?
3. **Who installs it?** Side-loaded APK for the room, or a Play Store listing later?
4. **Android only for now?** iPhone stays on the web page unless you want iOS too (Capacitor can do both).
5. **App name / package id** (e.g. `com.jharokha.room`).

---

## 9. Decision log
- 2026-11-19: Android app planned. This document was created. Nothing decided yet beyond the recommendation in §4.
