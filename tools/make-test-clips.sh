#!/usr/bin/env bash
# Makes synthetic test clips with the house encode settings into probe/clips/ (git-ignored).
# Use these instead of the in-browser "Generate test clip": MediaRecorder WebM has no seek
# index, so mid-clip starts can stall ~3 s, which is NOT representative of real wallpapers.
# Usage: tools/make-test-clips.sh [ffmpeg-binary]
set -euo pipefail
FF="${1:-ffmpeg}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/probe/clips"
mkdir -p "$OUT"
"$FF" -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=8" \
  -c:v libx264 -profile:v high -preset fast -crf 20 -g 60 -keyint_min 60 -sc_threshold 0 \
  -pix_fmt yuv420p -an -movflags +faststart "$OUT/test_1080p30.mp4"
"$FF" -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=8" \
  -c:v libvpx-vp9 -b:v 3M -g 60 -deadline realtime -cpu-used 8 -an "$OUT/test_720p30_vp9.webm"
ls -la "$OUT"
