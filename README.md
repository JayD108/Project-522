# Jharokha

A live video wallpaper and dual-screen room host for a spare ChromeOS Flex laptop (i5-10210U, 8 GB RAM, HDD) and an external monitor.

```bash
npm start      # install + build + serve → open http://localhost:8080/app/
npm test       # full automated check → test-run-<timestamp>.log
```
**Setup (Windows dev, and ChromeOS Flex/Crostini): [SETUP.md](SETUP.md)**

## What works now (Weeks 0–1)
- **Video engine:** a clip is read from disk once into a RAM Blob, then looped seamlessly on two `<video>` elements that hand off at the end (H.264/VP9; AV1 is refused).
- **Library:** clips are imported into the browser's private file storage (OPFS) with a codec check. Two sample clips are included.
- **Dual screen:** the dashboard sits on the laptop and the wallpaper on the monitor. ⇄ Swap hands the Blob between windows in memory (~100 ms, zero disk reads).
- **Fallback:** with one display, permission denied, or the monitor unplugged or closed, it drops to single-screen from RAM without crashing.
- **PWA:** installable, with the offline app shell, wake lock, and settings in IndexedDB (writes batched).

## Layout
| Path | What |
|---|---|
| `app/` | The app (Vite + Preact + TypeScript PWA) |
| `server/probe-server.mjs` | Zero-dependency local server: app, samples, health, SQLite WAL check |
| `tests/run-all.mjs` | The single test runner (writes the consolidated log) |
| `samples/` | Two small synthetic clips used by the app and the tests |
| `probe/` | Week 0 hardware probe pages (`/` and `/lan.html` on the server) |
| `tools/`, `scripts/` | Encode script, test-clip maker, icon maker, Crostini setup, systemd unit |
| `docs/DEVICE-CHECKS.md` | Manual checklist for the real laptop |

Plans and specs: `v1.md`, `v2.md` (v2 wins on conflicts), `TASKS.md`, `DEVLOG.md`.
