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
- [ ] Reboot the laptop. Is the server back without you doing anything? (`systemctl --user status jharokha`)

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

## G. Week 2: coexist, scenes, weather
- [ ] Netflix CPU baseline: Jharokha closed, Netflix fullscreen on the monitor for 5 min. Note the CPU % in Task Manager (Search+Esc)
- [ ] Same again with Jharokha in dual-screen and Netflix covering W-B. After 2 min the W-B engine card (or `?debug` HUD) should say "released". Note the CPU % (pass: ≤ the baseline)
- [ ] If W-B never says "released" under Netflix, ChromeOS isn't reporting occlusion. Press 🎬 Cinema (or **C**) instead and check it releases after 2 min
- [ ] 🌙 Night Watch (**N**): both screens near-black, red clock readable but faint in a dark room; ☀ wake brings the wallpaper back
- [ ] Schedule: set a scene to start 4 min from now with another wallpaper and turn on Auto. The card should say "already in RAM" about 3 min before, and the switch should crossfade with no stutter
- [ ] Weather: type your city, then Set. The temperature appears on both screens

## H. Week 3: server core
- [ ] Layer 2 shows the Vitals Ring with 4 coloured arcs, and the Server panel says "● live"
- [ ] Settings > Linux > Port forwarding: 8080 TCP is on. In the Server panel press **Set Wi-Fi IP** and type the laptop's Wi-Fi IP (Settings > Network > Wi-Fi)
- [ ] A phone on the same Wi-Fi scans the QR: `/lan.html` loads. After that, the panel should say "Learned from a phone" if you clear the manual IP
- [ ] In the Linux terminal: `systemctl --user stop jharokha`. Within ~4 s the red "● Server offline" badge appears and the wallpaper keeps playing. Then `systemctl --user start jharokha`: the badge goes away by itself
- [ ] Restart the laptop. Without touching Linux, open Jharokha: the server is up (ring "Server" green). If not, open the Terminal app once and check whether it comes up

## I. Week 4: access
- [ ] `npm run show` (or `npm run pair`) in the Linux terminal: the dashboard opens and the Access card appears (it is now an owner)
- [ ] Phone on the same Wi-Fi: **type** `http://<laptop-wifi-ip>:8080/join` in the phone's browser, or scan the QR. Type a name → "Waiting for approval"
  - Nothing loads? In the Linux terminal: `journalctl --user -u jharokha -n 20`. No `device …` line means the phone never reached Linux: check port forwarding (§E), make sure the phone isn't on mobile data, or the hostel Wi-Fi may block device-to-device traffic (v2 §3.5: hotspot / travel router)
- [ ] The laptop shows "<name> wants to join". Tap ✓ Collaborator: the phone shows "You're in"
- [ ] Kill switch on: the phone page says "owner-only mode" after a refresh. Then off
- [ ] Remove: the phone shows "Removed from the room" within 15 s

## J. Week 5: room + new Layer 2
- [ ] Laptop dashboard: tabs Home / Wallpapers / Room / System. Add a note and set the door sign on Home
- [ ] Dual-screen: swap so the dashboard is on the monitor. It should switch to the wall layout (huge clock, sticky notes, QR) and fit with no scrolling. Readable from your bed or desk?
- [ ] Phone (once it can reach the laptop): /join → approved → **Open the room** → add a note (it appears on the wall), upload a file (it's in Room → Drop zone)
- [ ] If you approved the phone as **Owner**: Remote tab → Cinema / Night / Swap act on the laptop

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
| Netflix CPU: without / with Jharokha (G) | | |
| Auto-yield releases under Netflix (G) | | |
| Phone scans QR → page loads (H) | | |
| Server up after reboot, no taps (H) | | |
| Phone joins + approved (I) | | |
| Wall layout readable from 3 m (J) | | |

## Week 7 · phone remote + utilities (on the real laptop)
- [ ] Load the extension once: Chrome → `chrome://extensions` → Developer mode → Load unpacked → Linux files → jharokha → extension. System tab → "Phone remote for Netflix / YouTube" turns green.
- [ ] Phone → Netflix: opens full screen on the PC; Remote: arrows move the highlight along a row, OK opens a title; play/pause, ±10 s, volume work; "Skip intro" appears and works.
- [ ] Phone → YouTube: Type → "Search YouTube" → results; Touchpad → tap a video; it plays; full screen fills the window.
- [ ] If the phone says Chrome is holding the sound: touch the laptop once, then check everything works from the phone again.
- [ ] Split & Settle: "Pay with UPI" opens GPay/PhonePe on Android with the amount filled in (iPhone: needs a UPI app that accepts upi:// links).
- [ ] Sunrise alarm overnight with Night Watch on: light starts on time, chime at the time, "I'm up" from the phone.
- [ ] Showcase with music playing: allow the microphone once on the wall window; the ring reacts to the beat.

## Week 8 · harden + stacked layers (on the real laptop)
- [ ] `npm run soak` overnight (or the full 72 h): result in `data/soak/*.json` → `"pass": true`; note server/Chrome growth here. (Headless Chromium in Crostini decodes in software; the real ChromeOS Chrome uses the GPU.)
- [ ] Real Compute Pressure: run something heavy (e.g. a 4K YouTube video + a big compile) for a minute. Does System → Keep it running show "CPU pressure: serious", and does the wallpaper pause with the amber badge? Does it come back ~1 min after?
- [ ] Next morning: `ls ~/.local/share/jharokha/backups/` has a snapshot from 03:30 IST.
- [ ] Stacked layers on the real monitor: System → *Stack now*. The monitor shows the wall display over the moving wallpaper. Is it readable from 3 m? Does the video still play smoothly (no stutter compared with plain Layer 1)?
- [ ] Wallpaper switcher: tap a poster on the monitor's wall display → the laptop's wallpaper changes in < 1 s.
