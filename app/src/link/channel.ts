// BroadcastChannel link between W-A (laptop) and W-B (monitor). Blobs travel by reference: no copy, no disk.

import { ROLE, OTHER, type Role } from '../state';
import type { LoopStats } from '../engine/loop';
import type { Wallpaper } from '../store/library';
import type { Weather } from '../weather';

export type Msg =
  | { t: 'hello' } | { t: 'hello-ack' } | { t: 'bye' }
  | { t: 'ping'; ts: number } | { t: 'pong'; ts: number }
  /** Receiver starts Layer 1 with this clip at `at` seconds. `swapId` ties it to the swap that asked. */
  | { t: 'become-l1'; blob: Blob; wp: Wallpaper; at: number; swapId: string; t0: number }
  | { t: 'l1-ready'; swapId: string; ms: number }
  | { t: 'l1-failed'; swapId: string; error: string }
  /** Sent by the Layer-2 window to the Layer-1 window: "hand Layer 1 over to me". */
  | { t: 'swap-request'; t0: number }
  /** New wallpaper for the window that is currently Layer 1 (crossfade, no layer change). */
  | { t: 'play'; blob: Blob; wp: Wallpaper; at?: number }
  /** 🎬 Cinema / 🌙 Night Watch state, mirrored on both windows. */
  | { t: 'fx'; cinema: boolean; night: boolean; showcase?: boolean }
  /** Auto-yield: this window dropped its clip Blob (so the other may drop its ref too and free the RAM). */
  | { t: 'released' }
  /** B woke up on Layer 1 without a clip: A re-reads it (once) and sends `play`. */
  | { t: 'need-clip'; wpId: string | null; at: number }
  | { t: 'weather'; w: Weather | null }
  | { t: 'theme'; theme: 'night' | 'ink' }
  | { t: 'select'; id: string }
  /** A → B: the wallpaper that is current now (B's switcher highlights it). */
  | { t: 'current'; id: string | null }
  | { t: 'library-changed' }
  | { t: 'stats'; stats: LoopStats }
  | { t: 'swap-done'; ms: number }
  /** Stacked layers on/off (+ is Layer 2 shown over the wallpaper right now), mirrored on both windows. */
  | { t: 'stack'; on: boolean; overlay: boolean; reason: string; ms: number | null }
  /** The Layer-1 window's handover timed out (slow swap): the brain decides about stacking. */
  | { t: 'swap-timeout' }
  /** Thermal guard: wallpaper paused on both screens until the laptop cools down. */
  | { t: 'thermal'; hold: boolean }
  /** Monitor gone: B hands Layer 1 back (if it has it) and closes. */
  | { t: 'close' };

type Envelope = Msg & { from: Role; to: Role };

const ch = new BroadcastChannel('jharokha');
const handlers = new Set<(m: Msg) => void>();

ch.onmessage = (e: MessageEvent<Envelope>) => {
  if (e.data.to !== ROLE) return;
  handlers.forEach((h) => h(e.data));
};

export function send(m: Msg) { ch.postMessage({ ...m, from: ROLE, to: OTHER }); }
export function onMessage(h: (m: Msg) => void) { handlers.add(h); return () => handlers.delete(h); }

/** Cross-window comparable clock (ms since epoch, sub-ms resolution). */
export const epoch = () => performance.timeOrigin + performance.now();
