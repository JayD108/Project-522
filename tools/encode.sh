#!/usr/bin/env bash
# Jharokha house encoding standard (v1 §4.1): H.264 High, fixed GOP, no audio, faststart.
# Usage: tools/encode.sh in.mp4 [out.mp4] [height=1080] [fps=30]
#   tools/encode.sh rain.mov                       -> rain_1080p30.mp4
#   tools/encode.sh waves.mp4 waves_1440p60.mp4 1440 60   (monitor variant)
# Never AV1: Intel UHD Gen 9.5 has no AV1 hardware decode.
set -euo pipefail

in="${1:?usage: encode.sh in.mp4 [out.mp4] [height] [fps]}"
h="${3:-1080}"
fps="${4:-30}"
out="${2:-${in%.*}_${h}p${fps}.mp4}"
gop=$((fps * 2))   # keyframe every 2 s -> clean loop points

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (sudo apt install ffmpeg)"; exit 1; }

ffmpeg -hide_banner -y -i "$in" \
  -vf "scale=-2:${h}:flags=lanczos,fps=${fps}" \
  -c:v libx264 -profile:v high -preset slow -crf 20 \
  -g "$gop" -keyint_min "$gop" -sc_threshold 0 -pix_fmt yuv420p \
  -an -movflags +faststart "$out"

bytes=$(stat -c %s "$out" 2>/dev/null || stat -f %z "$out")
echo "wrote $out ($((bytes / 1048576)) MB)"
[ "$bytes" -gt $((300 * 1048576)) ] && echo "WARNING: over the 300 MB RAM budget, shorten the loop or raise -crf"
exit 0
