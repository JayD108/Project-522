# Jharokha

A live video wallpaper and dual-screen room host for a spare ChromeOS Flex laptop (i5-10210U, 8 GB RAM, HDD) and an external monitor.

```bash
npm start      # install + build + serve → open http://localhost:8080/app/
npm test       # full automated check → test-run-<timestamp>.log
```
**Setup (Windows dev, and ChromeOS Flex/Crostini): [SETUP.md](SETUP.md)**

## What works now (Weeks 0–6)
- **Video engine:** a clip is read from disk once into a RAM Blob, then looped seamlessly on two `<video>` elements that hand off at the end (H.264/VP9; AV1 is refused).
- **Library:** clips are imported into the browser's private file storage (OPFS) with a codec check. Two sample clips are included.
- **Dual screen:** the dashboard sits on the laptop and the wallpaper on the monitor. ⇄ Swap hands the Blob between windows in memory (~100 ms, zero disk reads).
- **Fallback:** with one display, permission denied, or the monitor unplugged or closed, it drops to single-screen from RAM without crashing.
- **Coexist (Week 2):** auto-yield (pause when covered, free the RAM after 2 min), 🎬 Cinema (**C**), 🌙 Night Watch (**N**).
- **Scenes + weather (Week 2):** Dawn / Deep Work / Ambient / Night schedule with the next clip prefetched into RAM; Open-Meteo weather by city.
- **Server core (Week 3):** Fastify + WebSocket + SQLite WAL as a `systemd --user` service. Live Vitals Ring, server panel, live QR for phones, and a "Server offline" badge.
- **Access (Week 4):** QR → name → owner approves on the dashboard → role + 30-day device cookie. Kill switch, quiet hours, audit log, rate limits. Pair the laptop once with `npm run pair`.
- **Room (Week 5):** live Room Board (Yjs), Door Sign, Drop Zone (7 days, 500 MB/device), phone room page with an owner remote. Layer 2 redesigned: tabbed control centre on the laptop, glanceable wall display on the monitor.
- **Fun (Week 6):** watch-party queue with votes, cast-to-wall (owner approves; YouTube plays on the monitor), shared study-room timer, game-night scoreboard, ink theme. Phones can join over the internet (Cloudflare link, off by default).
- **PWA:** installable, with the offline app shell, wake lock, and settings in IndexedDB (writes batched).

## Layout
| Path | What |
|---|---|
| `app/` | The app (Vite + Preact + TypeScript PWA) |
| `server/index.mjs` | Fastify + WebSocket + SQLite (WAL) server: app, samples, vitals, QR, health |
| `tests/run-all.mjs` | The single test runner (writes the consolidated log) |
| `samples/` | Two small synthetic clips used by the app and the tests |
| `probe/` | Week 0 hardware probe pages (`/` and `/lan.html` on the server) |
| `tools/`, `scripts/` | Encode script, test-clip maker, icon maker, Crostini setup, systemd unit |
| `docs/DEVICE-CHECKS.md` | Manual checklist for the real laptop |

Plans and specs: `v1.md`, `v2.md` (v2 wins on conflicts), `TASKS.md`, `DEVLOG.md`.
