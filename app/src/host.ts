// The coordinator: owns the video player, the swap protocol, window placement and hotplug.
// W-A (laptop, opener) is the "brain": it owns the library, settings and the B window.
// Both windows can render Layer 1 or Layer 2. SWAP moves content, never windows (v2 §1.2).

import { LoopPlayer } from './engine/loop';
import { epoch, onMessage, send, type Msg } from './link/channel';
import { flushSettings, getSettings, loadSettings, startSettingsAutoFlush, updateSettings } from './store/db';
import { diskReadCount, importFile, listLibrary, persistStorage, readToRam, removeWallpaper, type Wallpaper } from './store/library';
import {
  DEBUG, ROLE, blobMB, currentId, diskReads, lastReadMs, layer, library, loopStats, mode, monitorBack,
  arming, lastTiming, needMonitorTap, overlayOpen, peer, screensInfo, swapFails, swapping, swaps, toast,
} from './state';

let stage: HTMLElement;
let player: LoopPlayer | null = null;
let clip: { blob: Blob; wp: Wallpaper } | null = null;
let pending: { id: string; t0: number } | null = null;
let lastHandOver: string | null = null;   // id of the newest handover this window started
let startOnHello = false;
let started = false;
let details: ScreenDetails | null = null;
let lastPong = 0;
let wakeLock: WakeLockSentinel | null = null;
let swapWaiter: ((ms: number) => void) | null = null;

const FADE_MS = 600;

// ------------------------------------------------------------------------- player
function setClip(c: typeof clip) {
  clip = c;
  blobMB.value = c ? +(c.blob.size / 2 ** 20).toFixed(1) : 0;
}

/** Play `blob` in this window. Crossfades over an existing player; resolves after the first frame. */
async function playLocal(blob: Blob, wp: Wallpaper, at = 0, onFirst?: (t: number) => void) {
  const old = player;
  const p = new LoopPlayer(stage, {
    onStats: (s) => { if (p === player) { loopStats.value = s; send({ t: 'stats', stats: s }); } },
    onFirstFrame: (t) => {
      p.el.classList.add('shown');
      if (old) setTimeout(() => old.dispose(), FADE_MS + 50);
      onFirst?.(t);
    },
  });
  if (!old) p.el.style.transition = 'none'; // nothing to crossfade from: appear on first frame
  player = p;
  setClip({ blob, wp });
  try {
    await p.load(blob);
    await p.start(at);
    if (document.hidden) p.pause();
  } catch (e) {
    p.dispose();
    if (player === p) player = old;
    throw e;
  }
}

function dropPlayer(delay = 350) {
  const p = player;
  player = null;
  if (p) setTimeout(() => p.dispose(), delay);
}

// ------------------------------------------------------------------------- layers / swap
function toL2() {
  layer.value = 'L2';
  dropPlayer();                       // panel fades in over the video, then decoder is released
  if (ROLE === 'B') setClip(null);    // A keeps the clip ref (same RAM, no copy) for hotplug fallback
}

function recordSwap(ms: number, id: string) {
  if (id === 'start') return;
  swaps.value = [...swaps.value, ms];
  if (player && ms > 500 && DEBUG) console.warn(`slow swap ${ms} ms`, player.timing);
  swapWaiter?.(ms);
}

export function requestSwap() {
  if (layer.value === 'start') return;
  if (mode.value === 'single') { overlayOpen.value = !overlayOpen.value; return; }
  if (!peer.value.alive) { toast('Other screen is not responding'); return; }
  const t0 = epoch();
  if (layer.value === 'L1') handOver(t0, rid());
  else send({ t: 'swap-request', t0 });
}

/** Called in the Layer-1 window: give Layer 1 (same Blob, same position) to the other window. */
function handOver(t0: number, id: string) {
  if (pending || !player || !clip) return;
  pending = { id, t0 };
  lastHandOver = id;
  swapping.value = true;
  send({ t: 'become-l1', blob: clip.blob, wp: clip.wp, at: player.currentTime(), swapId: id, t0 });
  setTimeout(() => {
    // Slow, not necessarily failed: a late l1-ready still completes this handover (see onMsg).
    if (pending?.id === id) { pending = null; swapping.value = false; swapFails.value++; toast('Swap is slow…'); }
  }, 3000);
}

const rid = () => Math.random().toString(36).slice(2, 8);

// ------------------------------------------------------------------------- messages
function onMsg(m: Msg) {
  switch (m.t) {
    case 'hello':
      markAlive();
      send({ t: 'hello-ack' });
      if (ROLE === 'A' && startOnHello) { startOnHello = false; sendLayer1ToB(); }
      break;
    case 'hello-ack': markAlive(); break;
    case 'ping': send({ t: 'pong', ts: m.ts }); break;
    case 'pong': markAlive(); peer.value = { alive: true, rtt: +(epoch() - m.ts).toFixed(1) }; break;
    case 'bye':
      peer.value = { alive: false, rtt: null };
      if (ROLE === 'A' && mode.value === 'dual') fallBackToSingle('Monitor window closed');
      break;
    case 'become-l1': {
      const { blob, wp, at, swapId, t0 } = m;
      if (ROLE === 'A') { currentId.value = wp.id; }
      arming.value = true;   // panel goes slightly translucent so the incoming video isn't fully occluded
      playLocal(blob, wp, at, (t) => {
        const ms = Math.round(performance.timeOrigin + t - t0);
        if (player) lastTiming.value = { ...player.timing, totalMs: ms };
        layer.value = 'L1';
        arming.value = false;
        overlayOpen.value = false;
        recordSwap(ms, swapId);
        send({ t: 'l1-ready', swapId, ms });
      }).catch((e) => { arming.value = false; send({ t: 'l1-failed', swapId, error: String(e?.message || e) }); });
      break;
    }
    case 'l1-ready':
      if (m.swapId === lastHandOver || pending?.id === m.swapId) {
        // Also handles a late ready after the 3 s timeout: never leave both windows on Layer 1.
        if (pending?.id === m.swapId) recordSwap(m.ms, m.swapId);
        else if (m.swapId !== 'start') swapFails.value = Math.max(0, swapFails.value - 1);
        pending = null; lastHandOver = null; swapping.value = false;
        if (layer.value === 'L1') toL2();
      } else if (m.swapId === 'start') {
        swapping.value = false;
      }
      break;
    case 'l1-failed':
      if (pending) swapFails.value++;
      pending = null; lastHandOver = null; swapping.value = false;
      toast(`Other screen could not play: ${m.error}`, 8000);
      break;
    case 'swap-request': if (layer.value === 'L1') handOver(m.t0, rid()); break;
    case 'play':
      if (layer.value === 'L1') playLocal(m.blob, m.wp).catch((e) => toast(String(e.message)));
      break;
    case 'select': if (ROLE === 'A') selectWallpaper(m.id); break;
    case 'library-changed': refreshLibrary(); break;
    case 'stats': loopStats.value = m.stats; break;
    case 'close':
      if (ROLE === 'B') { dropPlayer(0); setClip(null); window.close(); }
      break;
  }
}

function markAlive() {
  lastPong = Date.now();
  if (!peer.value.alive) peer.value = { alive: true, rtt: peer.value.rtt };
}

function sendLayer1ToB() {
  if (!clip) { toast('Import a wallpaper first'); return; }
  if (layer.value === 'L1' && player) { handOver(epoch(), 'start'); return; } // single → dual: hand over live
  swapping.value = true;
  send({ t: 'become-l1', blob: clip.blob, wp: clip.wp, at: 0, swapId: 'start', t0: epoch() });
  layer.value = 'L2';
}

// ------------------------------------------------------------------------- library (W-A owns it)
export async function refreshLibrary() {
  library.value = await listLibrary();
}

export async function importWallpapers(files: Iterable<File | Blob>, names?: string[]) {
  let i = 0;
  for (const f of files) {
    const name = names?.[i++] ?? (f as File).name ?? 'clip';
    try {
      toast(`Importing ${name}…`, 60000);
      const wp = await importFile(f, name);
      await refreshLibrary();
      send({ t: 'library-changed' });
      toast(wp.warn ? `Imported ${name} (⚠ ${wp.warn})` : `Imported ${name}`, 6000);
      if (!currentId.value) await selectWallpaper(wp.id);
    } catch (e: any) {
      toast(e.message || String(e), 10000);
    }
  }
}

export async function deleteWallpaper(id: string) {
  await removeWallpaper(id);
  await refreshLibrary();
  send({ t: 'library-changed' });
}

/** Read the chosen wallpaper from OPFS ONCE, then route it to whichever window is Layer 1. */
export async function selectWallpaper(id: string) {
  if (ROLE === 'B') { send({ t: 'select', id }); return; }
  const wp = library.value.find((w) => w.id === id);
  if (!wp) return;
  if (clip?.wp.id === id) return;
  const { blob, ms } = await readToRam(wp);
  diskReads.value = diskReadCount(); lastReadMs.value = ms;
  setClip({ blob, wp });
  currentId.value = id;
  updateSettings({ currentId: id });
  if (!started) return;
  if (layer.value === 'L1') await playLocal(blob, wp);
  else if (mode.value === 'dual') send({ t: 'play', blob, wp });
}

// ------------------------------------------------------------------------- screens / start
async function loadScreenDetails(prompt: boolean) {
  if (!('getScreenDetails' in window)) { screensInfo.value = { count: 1, permission: 'unsupported', labels: [] }; return; }
  let perm = 'prompt';
  try { perm = (await navigator.permissions.query({ name: 'window-management' as PermissionName })).state; } catch { /* older name */ }
  if (perm !== 'granted' && !prompt) { screensInfo.value = { count: 1, permission: perm, labels: [] }; return; }
  try {
    details = await window.getScreenDetails();
    details.addEventListener('screenschange', onScreensChange);
    updateScreensInfo('granted');
  } catch {
    screensInfo.value = { count: 1, permission: 'denied', labels: [] };
  }
}

function updateScreensInfo(permission: string) {
  const list = details?.screens || [];
  screensInfo.value = { count: list.length || 1, permission, labels: list.map((s) => `${s.label || 'screen'} ${s.width}×${s.height}${s.isInternal ? ' (laptop)' : ''}`) };
}

function pickScreens() {
  const list = details!.screens;
  const label = getSettings().wallScreenLabel;
  const wall = list.find((s) => s.label && s.label === label) || list.find((s) => !s.isInternal) || list[list.length - 1];
  const ctrl = list.find((s) => s.isInternal && s !== wall) || list.find((s) => s !== wall) || wall;
  return { wall, ctrl };
}

/** The one user tap that starts everything (fullscreen + 2nd window need a user gesture). */
export async function start() {
  if (ROLE === 'B') return;
  if (!details && screensInfo.value.permission !== 'unsupported') {
    await loadScreenDetails(true);              // permission prompt; the user taps Start again if it expired
  }
  if (!clip && currentId.value) await selectWallpaper(currentId.value);
  if (!clip) { toast('Import a wallpaper first'); return; }
  started = true;
  monitorBack.value = false;
  if (details && details.screens.length >= 2) await startDual();
  else await startSingle();
  keepAwake();
}

async function startSingle() {
  mode.value = 'single';
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch { /* tap overlay handles it */ }
  if (layer.value !== 'L1' && clip) {
    await playLocal(clip.blob, clip.wp, loopStats.value?.mediaTime || 0, () => { layer.value = 'L1'; });
  }
}

async function startDual() {
  const { wall, ctrl } = pickScreens();
  updateSettings({ wallScreenLabel: wall.label || null });
  try { await document.documentElement.requestFullscreen({ screen: ctrl }); } catch { /* keep going */ }
  // With "manage windows" granted, Chrome may allow this popup in the same click (companion window).
  // If fullscreen used up the click instead, play here and ask for one more tap (v2 §1.4 fallback).
  if (!openB(wall)) {
    await startSingle();
    needMonitorTap.value = true;
  }
}

function openB(wall = pickScreens().wall): boolean {
  const feats = `popup,left=${wall.availLeft},top=${wall.availTop},width=${wall.availWidth},height=${wall.availHeight},fullscreen`;
  const w = window.open(`./?w=B${DEBUG ? '&debug' : ''}`, 'jharokha-B', feats);
  if (!w) return false;
  needMonitorTap.value = false;
  monitorBack.value = false;
  mode.value = 'dual';
  overlayOpen.value = false;
  startOnHello = true;
  return true;
}

/** Second tap (or "monitor reconnected" tap): open W-B; Layer 1 is handed over live from this window. */
export function openMonitorWindow() {
  if (!details || details.screens.length < 2) { needMonitorTap.value = false; monitorBack.value = false; return; }
  if (!openB()) toast('Pop-up blocked: allow pop-ups for this site in Chrome settings', 10000);
}

function onScreensChange() {
  const n = details?.screens.length || 1;
  updateScreensInfo('granted');
  if (mode.value === 'dual' && n < 2) fallBackToSingle('Monitor unplugged: single-screen mode');
  else if (mode.value === 'single' && started && n >= 2) monitorBack.value = true;
}

/** Hotplug / B died: W-A takes Layer 1 back from its own Blob ref (RAM, no disk). */
function fallBackToSingle(why: string) {
  send({ t: 'close' });
  mode.value = 'single';
  pending = null; swapping.value = false;
  peer.value = { alive: false, rtt: null };
  toast(why, 6000);
  if (layer.value !== 'L1' && clip) {
    const at = loopStats.value?.mediaTime || 0;
    playLocal(clip.blob, clip.wp, at, () => { layer.value = 'L1'; }).catch((e) => toast(String(e.message)));
  }
}

// ------------------------------------------------------------------------- wake lock, visibility, keys
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed right now */ }
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* needs a gesture */ }
}

// ------------------------------------------------------------------------- auto-swap leak test
export async function autoSwap(n = 50, gapMs = 1500): Promise<{ ok: number; times: number[] }> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const got = new Promise<number | null>((r) => { swapWaiter = r; setTimeout(() => r(null), 4000); });
    requestSwap();
    const ms = await got;
    swapWaiter = null;
    if (ms != null) times.push(ms);
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return { ok: times.length, times };
}

// ------------------------------------------------------------------------- boot
export async function init(stageEl: HTMLElement) {
  stage = stageEl;
  onMessage(onMsg);
  window.addEventListener('pagehide', () => send({ t: 'bye' }));
  setInterval(() => {
    send({ t: 'ping', ts: epoch() });
    if (peer.value.alive && Date.now() - lastPong > 5000) {
      peer.value = { alive: false, rtt: null };
      if (ROLE === 'A' && mode.value === 'dual') fallBackToSingle('Monitor window stopped responding');
    }
  }, 2000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) player?.pause();       // auto-yield to Netflix etc. (2-min release lands in Week 2)
    else { player?.resume(); if (started || ROLE === 'B') keepAwake(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 's') requestSwap();
    else if (k === 'f') toggleFullscreen();
    else if (k === 'escape') overlayOpen.value = false;
  });

  if (ROLE === 'A') {
    persistStorage();
    const s = await loadSettings();
    startSettingsAutoFlush();
    await refreshLibrary();
    currentId.value = s.currentId && library.value.some((w) => w.id === s.currentId) ? s.currentId : library.value[0]?.id ?? null;
    if (currentId.value) await selectWallpaper(currentId.value);   // the one disk read, before Start
    await loadScreenDetails(false);
  } else {
    await refreshLibrary();
    send({ t: 'hello' });
    keepAwake();
  }

  if (DEBUG) {
    (window as any).__jhk = {
      importBlob: (b: Blob, name: string) => importWallpapers([b], [name]),
      LoopPlayer, select: selectWallpaper, swap: requestSwap, autoSwap, start, openMonitorWindow, flushSettings,
      state: { layer, mode, peer, swaps, loopStats, diskReads, blobMB, library, needMonitorTap, lastTiming },
    };
  }
}
