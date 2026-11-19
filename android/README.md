# Jharokha Owner (Android)

The owner's own controller for the Jharokha laptop. It is native Kotlin + Jetpack Compose, and only the owner uses it. Guests keep using the phone web page (`/app/room.html`). Plan and API contract: [`../ANDROID.md`](../ANDROID.md).

## Build

```bash
cd android
./gradlew assembleDebug testDebugUnitTest     # APK → app/build/outputs/apk/debug/app-debug.apk
```

The toolchain matches the other Android projects on this PC: AGP 9.5.1, Gradle 9.6, Kotlin 2.2.10, Compose BOM 2026.02.01, compileSdk 37, minSdk 29. Android Studio can open the `android/` folder directly.

## Pair a phone

1. On the laptop, open the dashboard → **Room** tab → **Access** card → **Pair my phone (Android app)**. A QR appears for 10 minutes (`POST /api/pair/phone`).
2. In the app, tap **Scan the pairing QR**, or scan it with the phone's camera app (`jharokha://pair?u=<laptop>&c=<32 hex>`). The phone must be on the room's Wi-Fi while pairing.
3. The phone is now an owner device. Its token is AES-GCM encrypted with an Android Keystore key and is never backed up. Owners stay signed in while they keep using the app (sliding 30 days).

**The laptop restarted and the internet link changed?** Tap ⋯ → *Scan room QR*, or *Scan room QR* on the offline banner, and scan the normal join QR on the wall. The app takes the new address and keeps its token.

## What's in it

| Tab | What |
|---|---|
| Home | Join and cast requests (approve / deny), what's on the wall, door sign, laptop health (uptime, RAM, load, disk, heat) |
| Wall | Swap · Cinema · Night · Showcase · Stack, wallpaper ◀ ▶ and picker, cast controls, send a link to the wall or open it on the laptop |
| Remote | Netflix / YouTube tab via the Jharokha Remote extension: D-pad, touchpad + scroll strip, player, volume, typing / search |
| People | Same Wi-Fi only / Anywhere, internet sharing on/off, kill switch, quiet hours, devices (roles, kick out), audit log |
| Tools | Sunrise alarm (set, I'm up, snooze, test), laundry timers, snapshot now |

On the Wall and Remote tabs, the **phone's volume buttons** change the laptop's volume (5 % per press). Remote keys give a haptic tick.

## Layout

| Path | What |
|---|---|
| `data/Store.kt` | Address, phone name, Keystore-encrypted token |
| `data/Api.kt` | OkHttp; the token goes in the same `jhk_dev` cookie the web pages use (no logging interceptor) |
| `data/Hub.kt` | The one `/ws` link (reconnect with backoff; 4401 → checks `/api/me`, signs out if removed), all live state, every action |
| `data/Models.kt` | Typed mirrors of the server JSON |
| `data/Pairing.kt` | QR / link parser (unit-tested) |
| `ui/` | Compose screens, theme = the dashboard's `styles.css` tokens |

## Not yet (Phase 2, see ANDROID.md §6)

The app is connected only while it's on screen. The next steps are a foreground service plus notifications (join requests, timer done, alarm), the share sheet (send a reel or YouTube link from any app to the wall), and media controls in the notification shade. A release build needs a signing key, which only you can create and keep.
