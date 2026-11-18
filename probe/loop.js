// Jharokha loop engine (probe version, carried into Week 1).
//
// Two <video> elements share ONE blob: URL (the clip lives in RAM, read from disk once).
// The active video sits on top; the standby sits underneath, paused on frame 0 (already
// decoded). ~1.5 frames before the active one ends we call standby.play(); on the standby's
// first presented frame (requestVideoFrameCallback) we flip z-order. No `loop` attribute,
// no CSS filters on the video, no opacity tricks → keeps Chrome's overlay/HW path.

const now = () => performance.now();

export class LoopPlayer {
  /** @param {HTMLElement} host */
  constructor(host, { onStats, onFirstFrame, statsEveryMs = 1000 } = {}) {
    this.host = host;
    this.onStats = onStats;
    this.onFirstFrame = onFirstFrame;
    this.statsEveryMs = statsEveryMs;
    this.url = null;
    this.blob = null;
    this.vids = [];
    this.active = null;
    this.standby = null;
    this.duration = 0;
    this.frameMs = 1000 / 30;
    this.flipping = false;
    this.disposed = false;
    this.paused = false;
    this.s = this.#freshStats();
  }

  #freshStats() {
    return {
      loops: 0, hitches: 0, worstGapMs: 0, lastSeamMs: 0, worstSeamMs: 0,
      lateLoops: 0, fps: 0, frames: 0, dropped: 0, totalDecoded: 0,
      width: 0, height: 0, duration: 0, blobMB: 0, startedAt: now(),
    };
  }

  async load(blob) {
    this.blob = blob;
    this.url = URL.createObjectURL(blob);
    this.s.blobMB = +(blob.size / 2 ** 20).toFixed(1);
    this.vids = [0, 1].map((i) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.disablePictureInPicture = true; v.disableRemotePlayback = true;
      v.className = 'jhk-video';
      v.style.zIndex = String(i === 0 ? 2 : 1);
      v.src = this.url;
      v.addEventListener('ended', this.#endedHandler);
      this.host.appendChild(v);
      return v;
    });
    await Promise.all(this.vids.map((v) => fixDuration(v)));
    this.duration = this.vids[0].duration;
    this.s.duration = +this.duration.toFixed(2);
    this.s.width = this.vids[0].videoWidth;
    this.s.height = this.vids[0].videoHeight;
    [this.active, this.standby] = this.vids;
  }

  /** Start playing at `at` seconds (used by swap to continue where the other screen was). */
  async start(at = 0) {
    const a = this.active, b = this.standby;
    a.style.zIndex = '2'; b.style.zIndex = '1';
    await seek(a, at % Math.max(this.duration, 0.001));
    await seek(b, 0);
    let first = true;
    this.#watch(a, (t) => {
      if (first) { first = false; this.onFirstFrame?.(t); }
    });
    await a.play();
    this.#statsTimer = setInterval(() => this.#emitStats(), this.statsEveryMs);
  }

  #statsTimer = 0;
  #lastT = 0;          // last presented frame time on the *visible* video
  #fpsCount = 0;
  #fpsT0 = 0;
  #intervals = [];

  // Watch frames of the currently visible video.
  #watch(video, extra) {
    const cb = (t, meta) => {
      if (this.disposed || video !== this.active) return;
      extra?.(t, meta);
      this.#onFrame(t, meta);
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  }

  #onFrame(t, meta) {
    const s = this.s;
    s.frames++;
    this.#fpsCount++;
    if (!this.#fpsT0) this.#fpsT0 = t;
    if (t - this.#fpsT0 >= 1000) {
      s.fps = +((this.#fpsCount * 1000) / (t - this.#fpsT0)).toFixed(1);
      this.#fpsCount = 0; this.#fpsT0 = t;
    }
    if (this.#lastT) {
      const gap = t - this.#lastT;
      this.#intervals.push(gap); if (this.#intervals.length > 60) this.#intervals.shift();
      const sorted = [...this.#intervals].sort((x, y) => x - y);
      this.frameMs = Math.min(Math.max(sorted[sorted.length >> 1] || 33, 8), 100);
      // Ignore the first 2 s (decoder warm-up); a gap > 2.5 frames is a visible hitch.
      if (t - s.startedAt > 2000 && gap > Math.max(2.5 * this.frameMs, 50) && !this.paused) {
        s.hitches++;
        s.worstGapMs = Math.max(s.worstGapMs, Math.round(gap));
      }
    }
    this.#lastT = t;
    // Arm the flip ~1.5 frames before the end.
    if (!this.flipping && meta.mediaTime >= this.duration - (1.5 * this.frameMs) / 1000) this.#flip(false);
  }

  #flip(late) {
    if (this.flipping || this.disposed) return;
    this.flipping = true;
    const oldV = this.active, newV = this.standby;
    const tLastOld = this.#lastT;
    if (late) this.s.lateLoops++;
    newV.requestVideoFrameCallback((t) => {
      if (this.disposed) return;
      newV.style.zIndex = '2'; oldV.style.zIndex = '1';
      this.active = newV; this.standby = oldV;
      const seam = tLastOld ? t - tLastOld : 0;
      this.s.lastSeamMs = Math.round(seam);
      this.s.worstSeamMs = Math.max(this.s.worstSeamMs, this.s.lastSeamMs);
      this.s.loops++;
      this.#lastT = t;
      oldV.pause();
      seek(oldV, 0).then(() => { this.flipping = false; });
      this.#watch(newV);
    });
    newV.play().catch(() => { this.flipping = false; });
  }

  #endedHandler = (e) => { if (e.target === this.active && !this.flipping) this.#flip(true); };

  #emitStats() {
    let dropped = 0, total = 0;
    for (const v of this.vids) {
      const q = v.getVideoPlaybackQuality?.();
      if (q) { dropped += q.droppedVideoFrames; total += q.totalVideoFrames; }
    }
    this.s.dropped = dropped; this.s.totalDecoded = total;
    this.onStats?.({ ...this.s, frameMs: +this.frameMs.toFixed(1), mediaTime: +this.currentTime().toFixed(2), paused: this.paused });
  }

  currentTime() { return this.active ? this.active.currentTime : 0; }

  pause() {
    this.paused = true;
    this.vids.forEach((v) => v.pause());
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.#lastT = 0;
    this.active?.play().catch(() => {});
  }

  /** Release decoder + blob URL. The Blob itself is freed once nothing references it. */
  dispose() {
    this.disposed = true;
    clearInterval(this.#statsTimer);
    for (const v of this.vids) {
      v.removeEventListener('ended', this.#endedHandler);
      v.pause(); v.removeAttribute('src'); v.load(); v.remove();
    }
    this.vids = []; this.active = this.standby = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null; this.blob = null;
  }
}

function once(el, ev) { return new Promise((r) => el.addEventListener(ev, r, { once: true })); }

async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return;
  const p = once(v, 'seeked');
  v.currentTime = t;
  await p;
}

// MediaRecorder WebM files report duration=Infinity until you seek far past the end.
async function fixDuration(v) {
  if (v.readyState < 1) await once(v, 'loadedmetadata');
  if (Number.isFinite(v.duration)) return;
  const p = once(v, 'durationchange');
  v.currentTime = 1e101;
  await Promise.race([p, new Promise((r) => setTimeout(r, 3000))]);
  v.currentTime = 0;
  await once(v, 'seeked').catch(() => {});
}

// ---- helpers used by the probe page -----------------------------------------------------

/** Read a source ONCE into a RAM-backed Blob. Returns { blob, ms, codec }. */
export async function loadIntoRam(source, type) {
  const t0 = now();
  let buf;
  if (source instanceof Blob) buf = await source.arrayBuffer();      // File → one sequential read
  else buf = await (await fetch(source, { cache: 'no-store' })).arrayBuffer();
  const codec = sniffCodec(new Uint8Array(buf));
  const blob = new Blob([buf], { type: type || source.type || guessType(codec) });
  return { blob, ms: Math.round(now() - t0), codec };
}

function guessType(codec) { return /VP|AV1-webm/.test(codec) ? 'video/webm' : 'video/mp4'; }

/** Cheap container sniff: looks for codec FourCCs / Matroska CodecIDs in head + tail. */
export function sniffCodec(u8) {
  const N = 4 << 20;
  const parts = u8.length <= 2 * N ? [u8] : [u8.subarray(0, N), u8.subarray(u8.length - N)];
  const has = (str) => parts.some((p) => indexOfAscii(p, str) >= 0);
  if (has('V_AV1')) return 'AV1-webm';
  if (has('V_VP9')) return 'VP9';
  if (has('V_VP8')) return 'VP8';
  if (has('V_MPEG4/ISO/AVC')) return 'H.264-webm';
  if (has('av01')) return 'AV1';
  if (has('vp09')) return 'VP9-mp4';
  if (has('hvc1') || has('hev1')) return 'HEVC';
  if (has('avc1') || has('avc3')) return 'H.264';
  return 'unknown';
}

function indexOfAscii(hay, str) {
  const n = str.length, c0 = str.charCodeAt(0);
  outer: for (let i = 0; i <= hay.length - n; i++) {
    if (hay[i] !== c0) continue;
    for (let j = 1; j < n; j++) if (hay[i + j] !== str.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** Synthetic test clip (VP9 WebM via MediaRecorder) so the probe works with no files. */
export async function generateTestClip({ width = 1280, height = 720, seconds = 8, fps = 30, keyframeMs = 2000, onProgress } = {}) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const g = c.getContext('2d');
  const stream = c.captureStream(fps);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  // keyframe every 2 s like tools/encode.sh (-g 2*fps); without it MediaRecorder emits ~1 keyframe,
  // and every mid-clip start must decode from frame 0.
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6, videoKeyFrameIntervalDuration: keyframeMs });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = once(rec, 'stop');
  rec.start(500);
  const t0 = now();
  await new Promise((resolve) => {
    const draw = () => {
      const t = (now() - t0) / 1000;
      const p = (t % seconds) / seconds;
      const hue = Math.round(p * 360);
      const grd = g.createLinearGradient(0, 0, width, height);
      grd.addColorStop(0, `hsl(${hue},55%,18%)`); grd.addColorStop(1, `hsl(${(hue + 60) % 360},55%,8%)`);
      g.fillStyle = grd; g.fillRect(0, 0, width, height);
      g.fillStyle = '#f4e9d8';
      g.beginPath();
      g.arc(width * (0.1 + 0.8 * p), height / 2 + Math.sin(p * Math.PI * 4) * height * 0.25, height * 0.06, 0, 7);
      g.fill();
      g.font = `${Math.round(height / 12)}px system-ui, sans-serif`;
      g.fillText(`Jharokha probe  ${t.toFixed(2)} s`, width * 0.05, height * 0.12);
      onProgress?.(Math.min(t / seconds, 1));
      if (t < seconds) requestAnimationFrame(draw); else resolve();
    };
    draw();
  });
  rec.stop();
  await done;
  stream.getTracks().forEach((tr) => tr.stop());
  return new Blob(chunks, { type: mime.split(';')[0] });
}
