// Seamless RAM loop (from the Week 0 probe).
// Two <video> share one blob: URL. Active on top, standby underneath paused on decoded frame 0.
// ~1.5 frames before the end: standby.play(); on its first presented frame, flip z-order.
// No `loop` attribute, no CSS filters on <video> → keeps Chrome's HW overlay path.

export interface LoopStats {
  loops: number; hitches: number; worstGapMs: number; lastSeamMs: number; worstSeamMs: number;
  lateLoops: number; fps: number; frameMs: number; dropped: number; totalDecoded: number;
  width: number; height: number; duration: number; blobMB: number; mediaTime: number; paused: boolean;
}

type FrameCb = (t: number, meta: VideoFrameCallbackMetadata) => void;

export class LoopPlayer {
  readonly el: HTMLDivElement;
  private url: string | null = null;
  private vids: HTMLVideoElement[] = [];
  private active!: HTMLVideoElement;
  private standby!: HTMLVideoElement;
  private duration = 0;
  private frameMs = 1000 / 30;
  private flipping = false;
  private disposed = false;
  paused = false;
  private lastT = 0;
  private fpsCount = 0;
  private fpsT0 = 0;
  private intervals: number[] = [];
  private startedAt = 0;
  private statsTimer = 0;
  /** Startup breakdown of the last load()+start(): where swap time goes. */
  timing = { loadMs: 0, seekMs: 0, firstFrameMs: 0, atS: 0 };
  private s = { loops: 0, hitches: 0, worstGapMs: 0, lastSeamMs: 0, worstSeamMs: 0, lateLoops: 0, fps: 0, width: 0, height: 0, blobMB: 0 };

  constructor(
    host: HTMLElement,
    private opts: { onStats?: (s: LoopStats) => void; onFirstFrame?: (t: number) => void } = {},
  ) {
    this.el = document.createElement('div');
    this.el.className = 'jhk-player';
    host.appendChild(this.el);
  }

  async load(blob: Blob): Promise<void> {
    const t0 = performance.now();
    this.url = URL.createObjectURL(blob);
    this.s.blobMB = +(blob.size / 2 ** 20).toFixed(1);
    this.vids = [0, 1].map((i) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.disablePictureInPicture = true; (v as any).disableRemotePlayback = true;
      v.className = 'jhk-video';
      v.style.zIndex = i === 0 ? '2' : '1';
      v.src = this.url!;
      v.addEventListener('ended', this.onEnded);
      this.el.appendChild(v);
      return v;
    });
    await Promise.all(this.vids.map(fixDuration));
    if (this.disposed) return;
    this.duration = this.vids[0].duration;
    this.s.width = this.vids[0].videoWidth;
    this.s.height = this.vids[0].videoHeight;
    [this.active, this.standby] = this.vids;
    this.timing.loadMs = Math.round(performance.now() - t0);
  }

  async start(at = 0): Promise<void> {
    if (this.disposed) return;
    const a = this.active, b = this.standby;
    a.style.zIndex = '2'; b.style.zIndex = '1';
    this.timing.atS = +at.toFixed(2);
    const t0 = performance.now();
    await Promise.all([seek(a, at % Math.max(this.duration, 0.001)), seek(b, 0)]);
    const t1 = performance.now();
    this.timing.seekMs = Math.round(t1 - t0);
    let first = true;
    this.startedAt = t1;
    this.watch(a, (t) => {
      if (first) { first = false; this.timing.firstFrameMs = Math.round(t - t1); this.opts.onFirstFrame?.(t); }
    });
    await a.play();
    this.statsTimer = window.setInterval(() => this.emitStats(), 1000);
  }

  private watch(video: HTMLVideoElement, extra?: FrameCb) {
    const cb: VideoFrameRequestCallback = (t, meta) => {
      if (this.disposed || video !== this.active) return;
      extra?.(t, meta);
      this.onFrame(t, meta);
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  }

  private onFrame(t: number, meta: VideoFrameCallbackMetadata) {
    this.fpsCount++;
    if (!this.fpsT0) this.fpsT0 = t;
    if (t - this.fpsT0 >= 1000) {
      this.s.fps = +((this.fpsCount * 1000) / (t - this.fpsT0)).toFixed(1);
      this.fpsCount = 0; this.fpsT0 = t;
    }
    if (this.lastT) {
      const gap = t - this.lastT;
      this.intervals.push(gap);
      if (this.intervals.length > 60) this.intervals.shift();
      const sorted = [...this.intervals].sort((x, y) => x - y);
      this.frameMs = Math.min(Math.max(sorted[sorted.length >> 1] || 33, 8), 100);
      if (t - this.startedAt > 2000 && gap > Math.max(2.5 * this.frameMs, 50) && !this.paused) {
        this.s.hitches++;
        this.s.worstGapMs = Math.max(this.s.worstGapMs, Math.round(gap));
      }
    }
    this.lastT = t;
    if (!this.flipping && meta.mediaTime >= this.duration - (1.5 * this.frameMs) / 1000) this.flip(false);
  }

  private flip(late: boolean) {
    if (this.flipping || this.disposed) return;
    this.flipping = true;
    const oldV = this.active, newV = this.standby, tLastOld = this.lastT;
    if (late) this.s.lateLoops++;
    newV.requestVideoFrameCallback((t) => {
      if (this.disposed) return;
      newV.style.zIndex = '2'; oldV.style.zIndex = '1';
      this.active = newV; this.standby = oldV;
      this.s.lastSeamMs = tLastOld ? Math.round(t - tLastOld) : 0;
      this.s.worstSeamMs = Math.max(this.s.worstSeamMs, this.s.lastSeamMs);
      this.s.loops++;
      this.lastT = t;
      oldV.pause();
      seek(oldV, 0).then(() => { this.flipping = false; });
      this.watch(newV);
    });
    newV.play().catch(() => { this.flipping = false; });
  }

  private onEnded = (e: Event) => { if (e.target === this.active && !this.flipping) this.flip(true); };

  private emitStats() {
    let dropped = 0, total = 0;
    for (const v of this.vids) {
      const q = v.getVideoPlaybackQuality();
      dropped += q.droppedVideoFrames; total += q.totalVideoFrames;
    }
    this.opts.onStats?.({
      ...this.s, frameMs: +this.frameMs.toFixed(1), dropped, totalDecoded: total,
      duration: +this.duration.toFixed(2), mediaTime: +this.currentTime().toFixed(2), paused: this.paused,
    });
  }

  currentTime(): number { return this.active ? this.active.currentTime : 0; }

  pause() {
    if (this.disposed) return;
    this.paused = true; this.vids.forEach((v) => v.pause());
    this.emitStats();                     // UI shows "paused" now, not on the next 1 s tick
  }

  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false; this.lastT = 0;
    this.active?.play().catch(() => {});
    this.emitStats();
  }

  /** Release decoders + blob URL. The Blob itself is freed when nothing references it. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.statsTimer);
    for (const v of this.vids) {
      v.removeEventListener('ended', this.onEnded);
      v.pause(); v.removeAttribute('src'); v.load();
    }
    this.el.remove();
    this.vids = [];
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

function once(el: EventTarget, ev: string) { return new Promise<void>((r) => el.addEventListener(ev, () => r(), { once: true })); }

async function seek(v: HTMLVideoElement, t: number) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return;
  const p = once(v, 'seeked');
  v.currentTime = t;
  await p;
}

// MediaRecorder WebM reports duration=Infinity until you seek far past the end.
async function fixDuration(v: HTMLVideoElement) {
  if (v.readyState < 1) {
    await new Promise<void>((res, rej) => {
      v.addEventListener('loadedmetadata', () => res(), { once: true });
      v.addEventListener('error', () => rej(new Error(`cannot decode: ${v.error?.message || 'media error ' + v.error?.code}`)), { once: true });
    });
  }
  if (Number.isFinite(v.duration)) return;
  const p = once(v, 'durationchange');
  v.currentTime = 1e101;
  await Promise.race([p, new Promise((r) => setTimeout(r, 3000))]);
  await seek(v, 0);
}
