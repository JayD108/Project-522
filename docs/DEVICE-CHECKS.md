# Week 0 · Device checks (run on the ChromeOS Flex laptop)

Goal: one evening, answer the three risky questions before building anything else.
1. Does a RAM-buffered loop play smoothly and quietly on this hardware?
2. Do two fullscreen windows on two screens plus a content swap work on ChromeOS?
3. Can a friend's phone on the hostel Wi-Fi reach a server running in Crostini?

Tip: press **Copy report** in the probe after each test and paste the JSON into `docs/results/` (or send it to me).

## A. Prep
- [ ] ChromeOS Flex fully updated. Note the version from `chrome://version`.
- [ ] `chrome://gpu`: "Video Decode: Hardware accelerated". Screenshot it.
- [ ] Linux turned on: Settings > About ChromeOS > Linux development environment.
- [ ] In the Linux terminal: follow SETUP.md (b). In short: install Node 22, `git clone`, `npm start` (or `bash scripts/setup-crostini.sh` for auto-start)
- [ ] `npm run test:quick` inside Crostini: the log should show all PASS
- [ ] Encode 3 test clips on the main PC: `tools/encode.sh in.mp4` (1080p30), plus one 1440p60 variant for the Legion. Copy them into `probe/clips/`.

## B. Loop smoothness (single screen)
- [ ] Chrome: `http://localhost:8080/`, pick a server clip, then **Single-screen loop test**
- [ ] `chrome://media-internals`: the player shows a hardware decoder (`VaapiVideoDecoder` / `VDAVideoDecoder`), **not** `VpxVideoDecoder`/`FFmpegVideoDecoder`
- [ ] Leave it for 1 hour. Pass: hitches ≈ 0, worst seam < 70 ms, dropped frames ≈ 0, CPU < 10 % in Task Manager (Search+Esc)
- [ ] Disk: after the clip loads, no further reads. ChromeOS has no per-disk monitor, so check `chrome://blob-internals`: the blob should be in memory, not "on disk".

## C. Dual screen (monitor plugged in)
- [ ] **Detect screens** → allow "Manage windows". Both screens listed, Legion marked external.
- [ ] **Start dual-screen**. Results to note:
  - W-A goes fullscreen on the laptop panel: yes / no
  - W-B opens on the monitor: yes / no; directly fullscreen: yes / no (if no, does the one tap work?)
- [ ] Press ⇄ SWAP ~10 times. Pass: each < 1000 ms, with no black frame you can see
- [ ] **Auto-swap ×50**. Pass: 50/50 ok, JS heap roughly flat
- [ ] Unplug the monitor, then replug it. Check the log for `screenschange` (this feeds the Week 1 hotplug design)
- [ ] If two fullscreen windows misbehave, try **Start 2 windows, no fullscreen** plus shelf auto-hide (v2 §1.4 fallback)

## D. Coexist with Netflix
- [ ] With dual screen running, play Netflix/YouTube fullscreen on the monitor over W-B
- [ ] The log should show `hidden → Layer 1 paused (auto-yield)`. If it doesn't, ChromeOS doesn't report occlusion and Cinema will need to be manual
- [ ] Netflix stats overlay (Ctrl+Alt+Shift+D): dropped frames ≈ 0

## E. Hostel network
- [ ] Settings > Linux > **Port forwarding** > add 8080 TCP, then toggle it on
- [ ] Laptop Wi-Fi IP: Settings > Network > Wi-Fi > IP address
- [ ] Friend's phone (on hostel Wi-Fi, not your hotspot): `http://<ip>:8080/lan.html`
  - Loads → no client isolation ✅. Run **Ping ×20** and **Speed test**.
  - Doesn't load → client isolation. Use the v2 §3.5 plan (travel router / hotspot)
- [ ] Repeat from 1–2 other rooms/floors (subnet check)
- [ ] Reboot the laptop. Is the server back without you doing anything? (`systemctl --user status jharokha-probe`)

## F. The real app (Week 1)
- [ ] `http://localhost:8080/app/`, then install it (Chrome menu > Cast, save and share > Install page as app)
- [ ] Import the 3 encoded clips. AV1 should be refused and HEVC should show ⚠
- [ ] Plug in the monitor and press **Start**. Note which of these happened:
  - (a) both screens light up from one click, or
  - (b) the banner "One more tap to light up the monitor" appears (fullscreen used up the click)
- [ ] ⇄ Swap ×10: smooth, < 1 s. "Disk" in the Wallpaper engine card stays at the same count
- [ ] Open `/app/?debug` for the HUD and the **Auto-swap ×50** button
- [ ] Unplug the monitor: the laptop takes the wallpaper (no disk read). Replug it: the "Monitor connected" banner appears
- [ ] Reboot with "Restore apps: Always". Does Jharokha come back? Count the taps to get to full dual-screen

## Results
| Check | Result | Notes |
|---|---|---|
| HW decode | | |
| 1 h loop: hitches / CPU | | |
| Dual fullscreen | | |
| Swap ms (median / max) | | |
| Auto-yield under Netflix | | |
| Phone reaches server | | |
| Server back after reboot | | |
| Start: one click or two (F) | | |
| App swap ms (median / max) | | |
