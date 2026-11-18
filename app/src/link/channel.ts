// BroadcastChannel link between W-A (laptop) and W-B (monitor). Blobs travel by reference: no copy, no disk.

import { ROLE, OTHER, type Role } from '../state';
import type { LoopStats } from '../engine/loop';
import type { Wallpaper } from '../store/library';

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
  | { t: 'play'; blob: Blob; wp: Wallpaper }
  | { t: 'select'; id: string }
  | { t: 'library-changed' }
  | { t: 'stats'; stats: LoopStats }
  | { t: 'swap-done'; ms: number }
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
