import { signal } from '@preact/signals';
import type { LoopStats } from './engine/loop';
import type { Wallpaper } from './store/library';
import type { Scene, SceneKey } from './scenes';
import type { Place, Weather } from './weather';

export type Role = 'A' | 'B';
export type Layer = 'start' | 'L1' | 'L2';
export type Mode = 'single' | 'dual';

const params = new URLSearchParams(location.search);
export const ROLE: Role = params.get('w') === 'B' ? 'B' : 'A';
export const OTHER: Role = ROLE === 'A' ? 'B' : 'A';
export const DEBUG = import.meta.env.DEV || params.has('debug');
/** Auto-yield: a hidden / Cinema / Night window releases its clip after this long (v2 §1.3). `?yield=ms` in debug. */
export const YIELD_MS = (DEBUG && Number(params.get('yield'))) || 2 * 60 * 1000;

export const layer = signal<Layer>(ROLE === 'A' ? 'start' : 'L2');
export const mode = signal<Mode>(ROLE === 'A' ? 'single' : 'dual');
export const overlayOpen = signal(false);            // single mode: Layer 2 drawn over the video
export const peer = signal<{ alive: boolean; rtt: number | null }>({ alive: false, rtt: null });
export const loopStats = signal<LoopStats | null>(null);
export const swaps = signal<number[]>([]);
export const swapFails = signal(0);
export const swapping = signal(false);
export const arming = signal(false);                 // this window is about to take Layer 1
export const library = signal<Wallpaper[]>([]);
export const currentId = signal<string | null>(null);
export const screensInfo = signal<{ count: number; permission: string; labels: string[] }>({ count: 1, permission: 'unknown', labels: [] });
export const monitorBack = signal(false);            // hotplug: monitor reconnected, waiting for a tap
export const needMonitorTap = signal(false);         // popup blocked at Start: one more tap opens W-B
export const notice = signal<string>('');
export const blobMB = signal(0);                     // clip Blob this window holds
export const diskReads = signal(0);                  // OPFS reads by this window
export const lastReadMs = signal(0);
/** Where the last swap's time went, measured in the window that took Layer 1. */
export const lastTiming = signal<{ loadMs: number; seekMs: number; firstFrameMs: number; atS: number; totalMs: number } | null>(null);

// ---- Week 2: coexist + scenes + weather
export const cinema = signal(false);                 // 🎬 Layer 1 paused, Layer 2 a slim dim strip, toasts off
export const showcase = signal(false);               // 🎵 audio-reactive canvas on the wall (Week 7)
export const nightWatch = signal(false);             // 🌙 both screens near-black, faint red clock
export const yielded = signal(false);                // this window released its clip (auto-yield)
export const scenes = signal<Scene[]>([]);
export const autoScenes = signal(false);
export const activeScene = signal<SceneKey | null>(null);
export const nextChange = signal<{ label: string; inMs: number; prefetched: boolean } | null>(null);
export const place = signal<Place | null>(null);
export const weather = signal<Weather | null>(null);
export const weatherError = signal('');
export const theme = signal<'night' | 'ink'>('night');

let noticeTimer = 0;
export function toast(msg: string, ms = 4000) {
  if (cinema.value) return;                          // Cinema = notifications off
  notice.value = msg;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.value = ''; }, ms);
}

export function swapSummary(a: number[]) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], med: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
