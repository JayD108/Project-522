# Jharokha setup

What runs today (Weeks 0–1): the video wallpaper engine and dual-screen swap, inside an installable web app, served by a small local Node server.

- One command runs it: **`npm start`**. It installs dependencies, builds the app and starts the server on port 8080.
- One command tests it: **`npm test`**. It writes `test-run-<timestamp>.log` to the repo root.
- With two displays it runs dual-screen: the dashboard on the laptop, the wallpaper on the monitor, and ⇄ Swap between them. With one display, or if you deny the "manage windows" permission, it runs single-screen instead of crashing.

No accounts, API keys or secrets are needed. `.env.example` lists the optional settings.

---

## a) Run locally on Windows (dev)

**Needs:** Node.js 22.13 or newer (LTS from https://nodejs.org), Git and Google Chrome.

```powershell
git clone <your-repo-url> jharokha
cd jharokha
node -v                  # must print v22.13 or newer
npm start                # first run: installs app deps, builds, starts the server
```

Then open **http://localhost:8080/app/** in Chrome. On the start screen:
1. Click **Load sample wallpapers** to import the two small clips from `samples/`.
2. Click **Start**. Chrome asks to "manage windows"; click Allow if you have two displays.
   - Two displays: the wallpaper goes to the external one and the dashboard to the laptop. Press **⇄ Swap** or the **S** key.
     If a banner says "One more tap to light up the monitor", tap **Open on monitor**.
   - One display: the wallpaper fills the screen. **S** or the ▣ button shows or hides the dashboard over the video.
3. Add `?debug` to the URL (`/app/?debug`) for the frame-stats HUD and the **Auto-swap ×50** test.

Other commands (all from the repo root):

| Command | What it does |
|---|---|
| `npm test` | Full test run (environment, build, unit tests, server, real playback, single- and dual-screen in headless Chrome). Writes `test-run-<timestamp>.log`. |
| `npm run test:quick` | Same, but without the browser tests |
| `npm run dev` | Server plus Vite hot reload at http://localhost:5173 |
| `npm run build` | Build only (`app/dist`) |
| `npm run setup` | Reinstall app dependencies from the lockfile |
| `npm start -- --no-build` | Start without rebuilding |

Settings: copy `.env.example` to `.env` to change the `PORT` or `HOST`. If port 8080 is busy, the server says so and exits.

Your own wallpapers: encode them with `bash tools/encode.sh in.mp4` (Git Bash plus ffmpeg) for H.264 1080p30 with a 2 s GOP, then use **+ Import**.

---

## b) Run on the ChromeOS Flex laptop (after GitHub)

### 1. Turn on Linux (once)
Settings → About ChromeOS → **Linux development environment** → Turn on. Give it about 20 GB of disk (the HDD has room, and a fixed size keeps it from growing).

### 2. In the Linux terminal (Crostini)
```bash
sudo apt-get update && sudo apt-get install -y git curl ca-certificates

# Node 22 LTS (Debian's packaged Node is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v                                     # v22.13 or newer

git clone <your-repo-url> jharokha
cd jharokha
npm start                                   # installs, builds, starts on :8080
```
Leave that terminal open while you use it, then stop it with Ctrl+C.

**Optional: start automatically at boot** (`systemd --user`, restarts if it crashes). This also builds the app and makes 1080p test clips if ffmpeg is available:
```bash
bash scripts/setup-crostini.sh
systemctl --user status jharokha-probe      # should say "active (running)"
journalctl --user -u jharokha-probe -f      # live logs
```
To update later: `git pull && npm run build && systemctl --user restart jharokha-probe`

### 3. Open and install it in Chrome (the ChromeOS side, not Linux)
1. In Chrome, go to **http://localhost:8080/app/**. ChromeOS forwards `localhost` into Linux automatically.
2. Install as an app: Chrome menu ⋮ → **Cast, save and share** → **Install page as app…** → Install.
   (Or click the install icon at the right end of the address bar.)
3. Open **Jharokha** from the launcher. Click **Load sample wallpapers** (or **+ Import** your own clips), then **Start**, then **Allow** "manage windows".
4. To have it come back after a reboot: Settings → Apps → **Restore apps on startup → Always**, and leave Jharokha open.

### 4. Let phones reach it (later weeks; quick check now)
Settings → About ChromeOS → Linux development environment → **Port forwarding** → Add **8080 / TCP** and turn it on.
A phone on the same Wi-Fi can then open `http://<laptop-Wi-Fi-IP>:8080/lan.html`.

### 5. Testing on the laptop
- `npm run test:quick` works inside Crostini. It checks Node, packages, the build, unit tests and the server.
- The browser tests need a Chrome binary *inside Linux*, and ChromeOS's own Chrome can't be driven from there. To run them anyway: `sudo apt-get install -y chromium` and then `npm test`. Linux Chromium has no GPU video, so its playback numbers say nothing about real performance.
- The real hardware checks (HW decode, 1-hour loop, CPU, fan, Netflix side by side, hostel Wi-Fi) are a manual checklist in **docs/DEVICE-CHECKS.md**.

---

## Troubleshooting
| Symptom | Fix |
|---|---|
| `Node … is too old` | Install Node 22 LTS (step 2 above, or nodejs.org on Windows) |
| `Port 8080 is already in use` | Another copy is running (`systemctl --user stop jharokha-probe`), or set `PORT=8081` in `.env` |
| `/app/` says "App not built yet" | `npm run build` |
| Second screen stays black / "One more tap" banner | Tap **Open on monitor**. Allow pop-ups for the site if Chrome blocked it |
| "Chrome cannot decode this file" / AV1 refused | Re-encode with `tools/encode.sh` (H.264) |
| Browser tests show SKIP | No Chrome found. Set `CHROME_PATH=/path/to/chrome`, or install Chromium |
