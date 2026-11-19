// The coordinator: owns the video player, the swap protocol, window placement and hotplug.
// W-A (laptop, opener) is the "brain": it owns the library, settings and the B window.
// Both windows can render Layer 1 or Layer 2. SWAP moves content, never windows (v2 §1.2).

import { LoopPlayer } from './engine/loop';
import { epoch, onMessage, send, type Msg } from './link/channel';
import { flushSettings, getSettings, loadSettings, startSettingsAutoFlush, updateSettings } from './store/db';
import { RAM_BUDGET_MB, diskReadCount, importFile, listLibrary, makeThumb, persistStorage, readToRam, removeWallpaper, setThumb, type Wallpaper } from './store/library';
import {
  DEBUG, ROLE, YIELD_MS, blobMB, currentId, diskReads, lastReadMs, layer, library, loopStats, mode, monitorBack,
  arming, lastTiming, needMonitorTap, overlayOpen, peer, screensInfo, swapFails, swapping, swaps, toast,
  activeScene, autoScenes, cinema, nextChange, nightWatch, showcase, place, scenes, theme, weather, weatherError, yielded,
  SLOW_SWAP_MS, autoStack, rotateMin, stackInfo, stackOverlay, stacked, thermalGuard, thermalHold,
} from './state';
import { vitals } from './ui/vitals';
import { nextScene, sceneAt, type Scene } from './scenes';
import { slowVerdict } from './stacking';
import { fetchWeather, geocode, type Place } from './weather';
import { onServerMessage, setRole, wsSend } from './serverLink';
import { fun } from './room/roomClient';

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
// Week 2
let fakeHidden = false;                 // debug/test stand-in for document.hidden
let yieldTimer = 0;
let resumeAt = 0;                       // media time to come back to after a release
let resumeId: string | null = null;     // …and which clip that time belongs to
let peerYielded = false;                // A: B has dropped its clip
let nextClip: { blob: Blob; wp: Wallpaper } | null = null;  // A: prefetched clip for the next scene
let clipLoading: Promise<boolean> | null = null;
let lastScene: string | null = null;
let lastWpChange = Date.now();
let selectSeq = 0;                      // newest wallpaper pick (older reads that finish late are dropped)          // wallpaper rotation clock
let fakePressure: string | null = null; // debug/test stand-in for Compute Pressure
let hotSince = 0, coolSince = 0;

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
    if (isDormant()) { p.pause(); armYield(); }
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
  checkSlowSwaps();
}

// ------------------------------------------------------------------------- stacked layers (swaps got slow)
// Moving the video between screens costs a decoder start on the other screen. When that gets slow (a busy laptop,
// thermal throttling, a big clip), stop moving it: the screen that has the wallpaper also draws Layer 2 over it,
// and Swap just shows / hides that panel. The other screen stays the dashboard. "Back to swapping" undoes it.
function checkSlowSwaps() {
  if (ROLE !== 'A' || stacked.value || !autoStack.value || mode.value !== 'dual') return;
  const why = slowVerdict(swaps.value, SLOW_SWAP_MS.v);
  if (why) setStacked(true, why, swaps.value[swaps.value.length - 1]);
}

export function setStacked(on: boolean, reason = '', ms: number | null = null, overlay = true, fromPeer = false) {
  const was = stacked.value;
  stacked.value = on;
  stackOverlay.value = on ? overlay : true;
  if (on && !was) stackInfo.value = { reason, ms, at: Date.now() };
  if (!on) stackInfo.value = null;
  if (layer.value === 'L1') overlayOpen.value = on && overlay;
  if (!fromPeer) send({ t: 'stack', on, overlay, reason, ms });
  if (on && !was && !fromPeer) toast(`Swaps got slow (${reason}): both layers are now on one screen`, 7000);
}
export const unstack = () => setStacked(false);


export function requestSwap() {
  if (layer.value === 'start' || cinema.value || nightWatch.value) return;
  if (mode.value === 'single') { overlayOpen.value = !overlayOpen.value; return; }
  if (stacked.value) { setStacked(true, '', null, !stackOverlay.value); return; }   // stacked: show / hide Layer 2 over the wallpaper
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
    if (pending?.id === id) {
      pending = null; swapping.value = false; swapFails.value++; toast('Swap is slow…');
      if (ROLE === 'A') onSwapTimeout(); else send({ t: 'swap-timeout' });
    }
  }, 3000);
}

const rid = () => Math.random().toString(36).slice(2, 8);
function onSwapTimeout() {
  if (autoStack.value && mode.value === 'dual' && !stacked.value) setStacked(true, 'a swap took over 3 s', 3000);
}

// ------------------------------------------------------------------------- messages
function onMsg(m: Msg) {
  switch (m.t) {
    case 'hello':
      markAlive();
      send({ t: 'hello-ack' });
      if (ROLE === 'A') {
        send({ t: 'fx', cinema: cinema.value, night: nightWatch.value, showcase: showcase.value }); send({ t: 'weather', w: weather.value }); send({ t: 'theme', theme: theme.value }); peerYielded = false;
        if (stacked.value) send({ t: 'stack', on: true, overlay: stackOverlay.value, reason: stackInfo.value?.reason || '', ms: stackInfo.value?.ms ?? null });
        if (thermalHold.value) send({ t: 'thermal', hold: true });
        send({ t: 'current', id: currentId.value });
      }
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
        overlayOpen.value = stacked.value && stackOverlay.value;
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
      if (layer.value === 'L1') { yielded.value = false; playLocal(m.blob, m.wp, m.at ?? 0).catch((e) => toast(String(e.message))); }
      break;
    case 'fx': setFx({ cinema: m.cinema, night: m.night, showcase: !!m.showcase }, true); break;
    case 'weather': weather.value = m.w; break;
    case 'theme': applyTheme(m.theme); break;
    case 'stack': setStacked(m.on, m.reason, m.ms, m.overlay, true); break;
    case 'swap-timeout': if (ROLE === 'A') onSwapTimeout(); break;
    case 'thermal': if (thermalHold.value !== m.hold) { thermalHold.value = m.hold; updateDormancy(); } break;
    case 'released':
      if (ROLE === 'A') {
        peerYielded = true;
        // B let go of its Blob; drop our fallback ref too so the RAM is really freed. Hotplug then costs one disk read.
        if (layer.value === 'L2' && !player) { setClip(null); nextClip = null; }
      }
      break;
    case 'need-clip':
      if (ROLE === 'A') {
        peerYielded = false;
        ensureClip().then((ok) => {
          if (ok && clip) send({ t: 'play', blob: clip.blob, wp: clip.wp, at: m.wpId === clip.wp.id ? m.at : 0 });
        }).catch((e) => toast(String(e.message)));
      }
      break;
    case 'select': if (ROLE === 'A') selectWallpaper(m.id); break;
    case 'current': if (ROLE === 'B') currentId.value = m.id; break;
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

async function sendLayer1ToB() {
  if (!clip) await ensureClip();
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

/** Import the sample clips the server ships in /samples/ (so a fresh install plays something). */
export async function loadSamples(): Promise<number> {
  let list: { name: string; url: string }[] = [];
  try { list = await (await fetch(new URL('../api/samples', location.href), { cache: 'no-store' })).json(); }
  catch { toast('Sample clips need the Jharokha server (npm start)', 8000); return 0; }
  const have = new Set(library.value.map((w) => w.name));
  const todo = list.filter((c) => !have.has(c.name));
  if (!todo.length) { toast(list.length ? 'Samples already imported' : 'No sample clips on the server'); return 0; }
  const blobs = await Promise.all(todo.map(async (c) => (await fetch(new URL('..' + c.url, location.href))).blob()));
  await importWallpapers(blobs, todo.map((c) => c.name));
  return todo.length;
}

export async function deleteWallpaper(id: string) {
  if (clip?.wp.id === id && started) { toast('That wallpaper is playing: pick another one first'); return; }
  await removeWallpaper(id);
  if (clip?.wp.id === id) setClip(null);
  await refreshLibrary();
  if (currentId.value === id) {
    currentId.value = null;
    updateSettings({ currentId: null });
    if (library.value[0]) await selectWallpaper(library.value[0].id);
  }
  send({ t: 'library-changed' });
}

/** Read the chosen wallpaper from OPFS ONCE, then route it to whichever window is Layer 1. */
export async function selectWallpaper(id: string) {
  if (ROLE === 'B') { send({ t: 'select', id }); return; }
  const wp = library.value.find((w) => w.id === id);
  if (!wp) return;
  if (clip?.wp.id === id) {
    // Already in RAM. If a newer pick is still being read, cancel it: going back to what's playing must win.
    if (currentId.value !== id) { selectSeq++; currentId.value = id; lastWpChange = Date.now(); updateSettings({ currentId: id }); }
    return;
  }
  const seq = ++selectSeq;
  currentId.value = id;
  lastWpChange = Date.now();
  updateSettings({ currentId: id });
  if (started && isDormant() && (yielded.value || peerYielded)) {
    // Released for Netflix: don't touch the disk now; wake() reads the new choice when we're back.
    setClip(null); resumeAt = 0;
    return;
  }
  let blob: Blob;
  if (nextClip?.wp.id === id) { blob = nextClip.blob; nextClip = null; }       // prefetched ahead of the scene change
  else {
    const r = await readToRam(wp);
    diskReads.value = diskReadCount(); lastReadMs.value = r.ms;
    blob = r.blob;
  }
  if (seq !== selectSeq) return;            // a newer pick arrived while this one was reading: drop it
  setClip({ blob, wp });
  if (!wp.thumb) backfillThumb(wp, blob);
  if (nextClip && nextClip.wp.id !== id) nextClip = null;
  if (!started) return;
  if (layer.value === 'L1') await playLocal(blob, wp);
  else if (mode.value === 'dual') send({ t: 'play', blob, wp });
}

/** Older clips have no poster: make one from the copy already in RAM (no disk read). */
function backfillThumb(wp: Wallpaper, blob: Blob) {
  makeThumb(blob).then(async (t) => {
    if (t && (await setThumb(wp.id, t))) { await refreshLibrary(); send({ t: 'library-changed' }); }
  }).catch(() => {});
}

/** Layer 2 switcher, keys [ and ], phones: the previous / next wallpaper in the library. */
export function stepWallpaper(dir: 1 | -1) {
  const list = library.value;
  if (!list.length) return;
  const i = list.findIndex((w) => w.id === currentId.value);
  const next = list[(i + dir + list.length) % list.length];
  if (next && next.id !== currentId.value) selectWallpaper(next.id).catch((e) => toast(String(e.message)));
}

export function setRotate(min: number) {
  if (ROLE === 'B') return;
  rotateMin.value = [0, 5, 15, 30, 60, 120].includes(min) ? min : 0;
  updateSettings({ rotateMin: rotateMin.value });
  lastWpChange = Date.now();
}
export function setAutoStack(on: boolean) {
  autoStack.value = on;
  if (ROLE === 'A') updateSettings({ autoStack: on });
}
export function setThermalGuard(on: boolean) {
  thermalGuard.value = on;
  if (ROLE === 'A') updateSettings({ thermalGuard: on });
  if (!on && thermalHold.value) setThermalHold(false);
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
  const y = new URLSearchParams(location.search).get('yield');
  const w = window.open(`./?w=B${DEBUG ? '&debug' : ''}${DEBUG && y ? `&yield=${y}` : ''}`, 'jharokha-B', feats);
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
  if (stacked.value) { stacked.value = false; stackInfo.value = null; stackOverlay.value = true; }
  pending = null; swapping.value = false;
  peer.value = { alive: false, rtt: null };
  toast(why, 6000);
  if (layer.value !== 'L1') {
    const at = loopStats.value?.mediaTime || 0;
    ensureClip()
      .then((ok) => { if (ok && clip) return playLocal(clip.blob, clip.wp, at, () => { layer.value = 'L1'; }); })
      .catch((e) => toast(String(e.message)));
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
  setRole(ROLE);
  if (ROLE === 'A') { startRemote(); currentId.subscribe((id) => send({ t: 'current', id })); }   // the monitor's switcher shows what's playing
  let lastCast: string | null = null;
  fun.subscribe((f) => { const k = f?.casting?.url ?? null; if (k !== lastCast) { lastCast = k; updateDormancy(); } });
  window.addEventListener('pagehide', () => send({ t: 'bye' }));
  setInterval(() => {
    send({ t: 'ping', ts: epoch() });
    if (peer.value.alive && Date.now() - lastPong > 5000) {
      peer.value = { alive: false, rtt: null };
      if (ROLE === 'A' && mode.value === 'dual') fallBackToSingle('Monitor window stopped responding');
    }
  }, 2000);

  document.addEventListener('visibilitychange', updateDormancy);   // auto-yield to Netflix etc.

  document.addEventListener('keydown', (e) => {
    // Night Watch: any key wakes (except bare modifiers), and does nothing else.
    if (nightWatch.value && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) { e.preventDefault(); setFx({ night: false }); return; }
    const tg = e.target as HTMLElement | null;
    if (tg && (tg instanceof HTMLInputElement || tg instanceof HTMLTextAreaElement || tg instanceof HTMLSelectElement || tg.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;     // Ctrl+S, Alt+N… belong to Chrome
    const k = e.key.toLowerCase();
    if (k === 's') requestSwap();
    else if (k === 'f') toggleFullscreen();
    else if (k === 'c') toggleCinema();
    else if (k === 'n') toggleNightWatch();
    else if (k === 'v') toggleShowcase();
    else if (k === '[') stepWallpaper(-1);
    else if (k === ']') stepWallpaper(1);
    else if (k === 'escape') { overlayOpen.value = false; if (cinema.value || nightWatch.value || showcase.value) setFx({ cinema: false, night: false, showcase: false }); }
  });

  if (ROLE === 'A') {
    persistStorage();
    const s = await loadSettings();
    startSettingsAutoFlush();
    await refreshLibrary();
    scenes.value = s.scenes; autoScenes.value = s.autoScenes; place.value = s.place; weather.value = s.lastWeather;
    applyTheme(s.theme);
    autoStack.value = s.autoStack; thermalGuard.value = s.thermalGuard; rotateMin.value = s.rotateMin || 0;
    const has = (id: string | null | undefined): id is string => !!id && library.value.some((w) => w.id === id);
    const sc = sceneAt(new Date(), s.scenes);
    activeScene.value = sc?.key ?? null;
    if (s.autoScenes) lastScene = sc?.key ?? null;
    // Auto scenes on: the scene's wallpaper wins over the last manual pick (still just one disk read).
    currentId.value = s.autoScenes && has(sc?.wallpaperId) ? sc!.wallpaperId : has(s.currentId) ? s.currentId : library.value[0]?.id ?? null;
    if (currentId.value) await selectWallpaper(currentId.value);   // the one disk read, before Start
    await loadScreenDetails(false);
    setInterval(schedulerTick, 15000);
    schedulerTick();
    startWeather();
    setInterval(thermalTick, 5000);
  } else {
    await refreshLibrary();
    send({ t: 'hello' });
    keepAwake();
  }

  if (DEBUG) {
    (window as any).__jhk = {
      importBlob: (b: Blob, name: string) => importWallpapers([b], [name]),
      LoopPlayer, select: selectWallpaper, setFx, setTheme, toggleCinema, toggleNightWatch, setScene, setAutoScenes, schedulerTick,
      fakeHidden: (h: boolean) => { fakeHidden = h; updateDormancy(); },
      hasPrefetch: () => nextClip?.wp.id ?? null,
      setSlowSwapMs: (ms: number) => { SLOW_SWAP_MS.v = ms; }, setStacked, unstack, stepWallpaper, setRotate, setAutoStack, setThermalGuard,
      fakePressure: (p: string | null) => { fakePressure = p; thermalTick(); }, rotateNow: () => { lastWpChange = 0; schedulerTick(); },
      playerCount: () => document.querySelectorAll('.jhk-player').length, loadSamples, deleteWallpaper, swap: requestSwap, autoSwap, start, openMonitorWindow, flushSettings,
      state: { layer, mode, peer, swaps, loopStats, diskReads, blobMB, library, needMonitorTap, lastTiming, overlayOpen, currentId, screensInfo,
        cinema, nightWatch, showcase, yielded, scenes, autoScenes, activeScene, nextChange, weather, stacked, stackOverlay, stackInfo, thermalHold, rotateMin },
    };
  }
}

// ========================================================================= Week 2 · coexist
// A window is "dormant" when it's covered (hidden), or in 🎬 Cinema / 🌙 Night Watch.
// Dormant → pause at once; still dormant after YIELD_MS (2 min) → drop the player AND the Blob ref (v2 §1.3).
function isDormant() { return document.hidden || fakeHidden || cinema.value || nightWatch.value || showcase.value || thermalHold.value || castHere(); }
/** This window is the one on the wall (monitor): W-B in dual mode, the only window in single mode. */
export const isWallWindow = () => ROLE === 'B' || mode.value === 'single';
/** A cast is showing in this window → the wallpaper pauses (and frees the decoder after the yield delay). */
export const castHere = () => !!fun.value?.casting && isWallWindow() && (started || ROLE === 'B');

function armYield() {
  if (!yieldTimer && !yielded.value) yieldTimer = window.setTimeout(releaseMedia, YIELD_MS);
}

function updateDormancy() {
  if (isDormant()) { player?.pause(); armYield(); }
  else {
    clearTimeout(yieldTimer); yieldTimer = 0;
    wake().catch((e) => toast(String(e?.message || e)));
  }
}

function releaseMedia() {
  yieldTimer = 0;
  if (!isDormant()) return;
  const had = !!player || !!clip || !!nextClip;
  if (player) { resumeAt = player.currentTime(); resumeId = clip?.wp.id ?? null; dropPlayer(0); }
  // Dual + Layer 2 on A with B still playing: B shares the same Blob, so keep the ref (dropping it frees nothing).
  if (ROLE === 'B' || layer.value === 'L1' || mode.value === 'single' || peerYielded || cinema.value || nightWatch.value || showcase.value || thermalHold.value) setClip(null);
  nextClip = null;
  yielded.value = true;
  if (had) send({ t: 'released' });
}

/** Back from dormant: resume, or get the clip back (from the other window's RAM, or one disk read on A). */
async function wake() {
  if (started || ROLE === 'B') keepAwake();
  if (!yielded.value) { player?.resume(); return; }
  if (layer.value !== 'L1' || !(started || ROLE === 'B')) { yielded.value = false; return; }
  if (player) { player.resume(); yielded.value = false; return; }
  if (!clip && ROLE === 'A') await ensureClip();
  if (clip) { yielded.value = false; await playLocal(clip.blob, clip.wp, clip.wp.id === resumeId ? resumeAt : 0); }
  else if (ROLE === 'B') send({ t: 'need-clip', wpId: resumeId, at: resumeAt });
}

/** A only: make sure `clip` holds the current wallpaper (prefetch, else ONE disk read). */
function ensureClip(): Promise<boolean> {
  if (clip && clip.wp.id === currentId.value) return Promise.resolve(true);
  return (clipLoading ??= (async () => {
    try {
      const wp = library.value.find((w) => w.id === currentId.value);
      if (!wp) return false;
      if (nextClip?.wp.id === wp.id) { setClip(nextClip); nextClip = null; return true; }
      const { blob, ms } = await readToRam(wp);
      diskReads.value = diskReadCount(); lastReadMs.value = ms;
      setClip({ blob, wp });
      return true;
    } finally { clipLoading = null; }
  })());
}

export function setFx(patch: { cinema?: boolean; night?: boolean; showcase?: boolean }, fromPeer = false) {
  const before = `${cinema.value}${nightWatch.value}${showcase.value}`;
  if (patch.cinema !== undefined) cinema.value = patch.cinema;
  if (patch.night !== undefined) nightWatch.value = patch.night;
  if (patch.showcase !== undefined) showcase.value = patch.showcase;
  if (!fromPeer) send({ t: 'fx', cinema: cinema.value, night: nightWatch.value, showcase: showcase.value });
  if (before !== `${cinema.value}${nightWatch.value}${showcase.value}`) updateDormancy();
}
export const toggleCinema = () => setFx({ cinema: !cinema.value, night: false, showcase: false });
export const toggleNightWatch = () => setFx({ night: !nightWatch.value, cinema: false, showcase: false });
export const toggleShowcase = () => setFx({ showcase: !showcase.value, cinema: false, night: false });

// ========================================================================= Week 2 · scenes
const PREFETCH_MS = 3 * 60 * 1000;   // read the next scene's clip this long before it starts

export function schedulerTick() {
  if (ROLE !== 'A') return;
  const now = new Date();
  const list = scenes.value;
  const cur = sceneAt(now, list);
  activeScene.value = cur?.key ?? null;
  const nx = nextScene(now, list);
  nextChange.value = nx ? { label: nx.scene.label, inMs: nx.inMs, prefetched: !!nextClip && nextClip.wp.id === nx.scene.wallpaperId } : null;
  rotationTick();
  if (!autoScenes.value || !cur) return;
  if (cur.key !== lastScene) {
    lastScene = cur.key;
    if (cur.wallpaperId && cur.wallpaperId !== currentId.value && library.value.some((w) => w.id === cur.wallpaperId)) {
      selectWallpaper(cur.wallpaperId).catch((e) => toast(String(e.message)));
    }
    return;
  }
  if (nx && nx.inMs <= PREFETCH_MS) prefetch(nx.scene);
}

/** Wallpaper rotation: the next clip every N minutes (read into RAM 3 min early, like a scene change). */
function rotationTick() {
  const n = rotateMin.value;
  if (!n || !started || library.value.length < 2) return;
  const list = library.value;
  const i = list.findIndex((w) => w.id === currentId.value);
  const next = list[(i + 1) % list.length];
  const left = lastWpChange + n * 60000 - Date.now();
  if (left <= 0) {
    if (isDormant()) return;                       // covered by Netflix etc.: don't spend a disk read now
    selectWallpaper(next.id).catch((e) => toast(String(e.message)));
  } else if (left <= PREFETCH_MS) prefetchId(next.id);
}

async function prefetch(s: Scene) { return prefetchId(s.wallpaperId); }
async function prefetchId(id: string | null) {
  if (!id || id === currentId.value || nextClip?.wp.id === id || isDormant()) return;
  const wp = library.value.find((w) => w.id === id);
  if (!wp) return;
  // RAM budget (v2 §5): the playing clip and the prefetched one together stay under RAM_BUDGET_MB.
  if (((clip?.blob.size || 0) + wp.bytes) / 2 ** 20 > RAM_BUDGET_MB) return;
  nextClip = { blob: new Blob(), wp };            // placeholder so a second tick doesn't start a second read
  try {
    const { blob, ms } = await readToRam(wp);
    diskReads.value = diskReadCount(); lastReadMs.value = ms;
    if (nextClip?.wp.id === id) nextClip = { blob, wp };
  } catch { nextClip = null; }
  if (nextChange.value) nextChange.value = { ...nextChange.value, prefetched: nextClip?.wp.id === id };
}

export function setScene(key: string, patch: Partial<Pick<Scene, 'start' | 'wallpaperId'>>) {
  scenes.value = scenes.value.map((s) => (s.key === key ? { ...s, ...patch } : s));
  updateSettings({ scenes: scenes.value });
  if (nextClip && patch.wallpaperId !== undefined) nextClip = null;
  lastScene = null;                               // re-apply: an edit to the current scene takes effect now
  schedulerTick();
}

export function setAutoScenes(on: boolean) {
  autoScenes.value = on;
  updateSettings({ autoScenes: on });
  lastScene = null;
  if (!on) nextClip = null;
  schedulerTick();
}

// ========================================================================= Week 2 · weather
const WEATHER_MS = 30 * 60 * 1000;
let weatherBusy = false;

async function refreshWeather() {
  const p = place.value;
  if (!p || weatherBusy || !navigator.onLine) return;
  weatherBusy = true;
  try {
    const w = await fetchWeather(p);
    weather.value = w; weatherError.value = '';
    updateSettings({ lastWeather: w });
    send({ t: 'weather', w });
  } catch (e: any) {
    weatherError.value = e?.message || String(e);
  } finally { weatherBusy = false; }
}

function startWeather() {
  if (!weather.value || Date.now() - weather.value.at > WEATHER_MS) refreshWeather();
  setInterval(refreshWeather, WEATHER_MS);
  window.addEventListener('online', () => { if (!weather.value || Date.now() - weather.value.at > 5 * 60000) refreshWeather(); });
}

export async function setPlace(name: string) {
  if (!name.trim()) {
    place.value = null; weather.value = null; weatherError.value = '';
    updateSettings({ place: null, lastWeather: null });
    send({ t: 'weather', w: null });
    return;
  }
  try {
    const p: Place = await geocode(name);
    place.value = p; weatherError.value = '';
    updateSettings({ place: p });
    await refreshWeather();
  } catch (e: any) {
    weatherError.value = e?.message || String(e);
  }
}

// ========================================================================= Week 8 · thermal guard
// Compute Pressure "serious"/"critical" for 20 s → pause the wallpaper on both screens (a paused <video> decodes
// nothing); back to "nominal"/"fair" for 60 s → play again. ChromeOS hides temperatures, so CPU pressure is the signal.
const HOT_MS = 20_000, COOL_MS = 60_000;
export function currentPressure() { return fakePressure ?? vitals.value.pressure; }
function thermalTick() {
  const p = currentPressure();
  const hot = p === 'serious' || p === 'critical';
  const now = Date.now();
  if (hot) { coolSince = 0; hotSince ||= now; } else { hotSince = 0; coolSince ||= now; }
  const fake = fakePressure !== null;                // tests: act at once instead of waiting 20 s / 60 s
  if (!thermalHold.value && hot && thermalGuard.value && started && (fake || now - hotSince >= HOT_MS)) setThermalHold(true);
  else if (thermalHold.value && !hot && (fake || p === 'n/a' || now - coolSince >= COOL_MS)) setThermalHold(false);
}
function setThermalHold(on: boolean) {
  thermalHold.value = on;
  send({ t: 'thermal', hold: on });
  toast(on ? 'The laptop is working hard: wallpaper paused to keep it cool' : 'Cooled down: wallpaper playing again', 6000);
  updateDormancy();
  reportScreen(true);
}

// ========================================================================= Week 5 · owner remote
// The server relays an owner's phone buttons to this window (W-A); we report back what the screens are doing.
function screenState() {
  const sc = scenes.value.find((x) => x.key === activeScene.value);
  return {
    mode: mode.value, layer: layer.value, cinema: cinema.value, night: nightWatch.value, showcase: showcase.value, currentId: currentId.value,
    wallpapers: library.value.map((w) => ({ id: w.id, name: w.name })), scene: sc?.label ?? null, autoScenes: autoScenes.value,
    stacked: stacked.value, rotateMin: rotateMin.value,
    tz: -new Date().getTimezoneOffset(), thermal: { state: currentPressure(), guard: thermalHold.value },
  };
}
let lastSent = '';
function reportScreen(force = false) {
  const s = screenState();
  const k = JSON.stringify(s);
  if (!force && k === lastSent) return;
  if (wsSend({ t: 'screen-state', s })) lastSent = k;
}
function startRemote() {
  setInterval(() => reportScreen(), 1500);
  onServerMessage('remote', (m: { cmd: string; arg: unknown; by: string }) => {
    switch (m.cmd) {
      case 'swap': requestSwap(); break;
      case 'cinema': toggleCinema(); break;
      case 'night': toggleNightWatch(); break;
      case 'showcase': toggleShowcase(); break;
      case 'wallpaper':
        if (m.arg === 'next' || m.arg === 'prev') stepWallpaper(m.arg === 'next' ? 1 : -1);
        else if (typeof m.arg === 'string') selectWallpaper(m.arg).catch((e) => toast(String(e.message)));
        break;
      case 'stack': setStacked(!stacked.value, 'switched on from a phone'); break;
      case 'scene': {
        const sc = scenes.value.find((x) => x.key === m.arg);
        if (sc?.wallpaperId) selectWallpaper(sc.wallpaperId).catch((e) => toast(String(e.message)));
        break;
      }
    }
    if (m.cmd !== 'ping') toast(`${m.by}: ${m.cmd}`, 2500);
    setTimeout(() => reportScreen(true), 300);
  });
}

// ========================================================================= Week 6 · ink theme (both screens)
function applyTheme(t: 'night' | 'ink') {
  theme.value = t === 'ink' ? 'ink' : 'night';
  document.documentElement.dataset.theme = theme.value;
}
export function setTheme(t: 'night' | 'ink') {
  applyTheme(t);
  updateSettings({ theme: theme.value });
  send({ t: 'theme', theme: theme.value });
}

// ========================================================================= apps window ("Open on PC")
// Browsers only open a new window after a tap on THIS screen. So the first time, one tap opens a named
// "apps window" (on the wall screen when there are two); after that we keep its handle and simply point it at
// whatever a phone asks for (navigating a window we opened needs no tap).
let appWin: Window | null = null;
export function launchApp(url: string): boolean {
  if (appWin && !appWin.closed) {
    try { appWin.location.href = url; appWin.focus(); return true; } catch { /* lost it */ }
  }
  return false;
}
/** Call from a click/tap handler. Opens (or reuses) the apps window with `url`. */
export function launchAppWithTap(url: string): boolean {
  if (launchApp(url)) return true;
  let feats = '';
  if (details && details.screens.length >= 2) {
    const { wall } = pickScreens();
    feats = `left=${wall.availLeft},top=${wall.availTop},width=${wall.availWidth},height=${wall.availHeight}`;
  }
  appWin = window.open(url, 'jharokha-apps', feats);
  return !!appWin;
}
export const appWindowOpen = () => !!appWin && !appWin.closed;
