# Sample wallpapers

Synthetic clips generated with ffmpeg (`testsrc2` and `gradients` sources), so there are no licensing issues.
The app offers them through **Load sample wallpapers** so a fresh clone plays something straight away,
and the automated tests use them.

| File | Codec | Size |
|---|---|---|
| `sample_720p30.mp4` | H.264 High, 720p30, 2 s GOP, faststart | ~1.1 MB |
| `sample_720p30_vp9.webm` | VP9, 720p30, 2 s GOP | ~0.5 MB |

Regenerate: see `tools/make-test-clips.sh` (larger 1080p test clips go to `probe/clips/`, which git ignores).
