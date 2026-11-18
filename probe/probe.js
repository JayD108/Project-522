// Jharokha Week 0 probe. The same page runs as W-A (opener, ?role=A) and W-B (?role=B).
// Each window can render Layer 1 (video) or Layer 2 (vitals). SWAP moves content, not windows:
// the Layer-1 window sends the clip Blob + current time over BroadcastChannel, the other window
// starts playing from RAM, and when its first frame is on screen the old window fades to Layer 2.

import { LoopPlayer, loadIntoRam, generateTestClip } from './loop.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ROLE = params.get('role') === 'B' ? 'B' : 'A';
const OTHER = ROLE === 'A' ? 'B' : 'A';
const epoch = () => performance.timeOrigin + performance.now(); // comparable across windows
const ch = new BroadcastChannel('jharokha-probe');

const S = {
  layer: 'setup',                 // 'setup' | 'L1' | 'L2'
  clip: null,                     // { blob, name, codec, readMs, mb }
  player: null,
  screens: null,
  peer: { alive: false, rtt: null, lastPong: 0 },
  swaps: [], swapFails: 0, pendingSwap: null, sendToBOnHello: false,
  loopStats: null, server: null, codecs: [], events: [],
  wakeLock: null, pressure: 'n/a', hudOn: true, onSwapRecorded: null,
};

// ---------------------------------------------------------------- log
function log(msg) {
  const t = new Date().toISOString().slice(11, 23);
  S.events.push(`${t} [${ROLE}] ${msg}`);
  if (S.events.length > 300) S.events.shift();
  $('log').textContent = S.events.slice().reverse().join('\n');
}
window.addEventListener('error', (e) => log(`ERROR ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log(`REJECT ${e.reason?.message || e.reason}`));

// ---------------------------------------------------------------- messaging
function post(m) { ch.postMessage({ ...m, from: ROLE, to: m.to || OTHER }); }

ch.onmessage = ({ data: m }) => {
  if (m.to !== ROLE) return;
  switch (m.t) {
    case 'hello':
      S.peer.alive = true; S.peer.lastPong = Date.now();
      log(`peer ${m.from} said hello`);
      post({ t: 'hello-ack' });
      if (S.sendToBOnHello && S.clip?.blob) {
        S.sendToBOnHello = false;
        const t0 = epoch();
        S.pendingSwap = { id: 'start', t0 };
        post({ t: 'become', blob: S.clip.blob, meta: clipMeta(), at: 0, swapId: 'start', t0 });
        log(`sent clip Blob (${S.clip.mb} MB) to ${OTHER} over BroadcastChannel`);
        setLayer('L2');
      }
      break;
    case 'hello-ack': S.peer.alive = true; S.peer.lastPong = Date.now(); break;
    case 'ping': post({ t: 'pong', ts: m.ts }); break;
    case 'pong': S.peer.alive = true; S.peer.lastPong = Date.now(); S.peer.rtt = epoch() - m.ts; break;
    case 'become': becomeL1(m.blob, m.meta, m.at, m.swapId, m.t0); break;
    case 'l1-ready':
      if (S.pendingSwap?.id === m.swapId) {
        S.pendingSwap = null;
        recordSwap(m.ms, m.swapId);
        if (S.layer === 'L1') becomeL2();
      }
      break;
    case 'l1-failed':
      S.pendingSwap = null; S.swapFails++;
      log(`peer failed to start Layer 1: ${m.error}`);
      break;
    case 'swap-request': if (S.layer === 'L1') doSwap(m.t0); break;
    case 'stats': S.loopStats = m.stats; break;
    case 'bye': S.peer.alive = false; log(`peer ${m.from} closed`); break;
  }
};
window.addEventListener('pagehide', () => post({ t: 'bye' }));

setInterval(() => {
  post({ t: 'ping', ts: epoch() });
  if (S.peer.alive && Date.now() - S.peer.lastPong > 5000) { S.peer.alive = false; log('peer lost'); }
}, 2000);

function clipMeta() { const { blob, ...m } = S.clip || {}; return m; }

// ---------------------------------------------------------------- layers
function setLayer(layer) {
  S.layer = layer;
  $('setup').classList.toggle('hidden', layer !== 'setup');
  $('vitals').classList.toggle('hidden', layer === 'setup');
  $('panel').classList.toggle('gone', layer === 'L1');
  $('hud').classList.toggle('hidden', layer !== 'L1' || !S.hudOn);
  $('autoBtn').classList.toggle('hidden', ROLE !== 'A');
  document.title = `Jharokha ${ROLE} · ${layer}`;
  render();
}

async function becomeL1(blob, meta, at, swapId, t0) {
  try {
    if (S.player) S.player.dispose();
    S.clip = { ...(meta || S.clip || {}), blob };
    const player = new LoopPlayer($('stage'), {
      onStats: (st) => { S.loopStats = st; post({ t: 'stats', stats: st }); renderHud(st); },
      onFirstFrame: (t) => {
        const ms = Math.round(performance.timeOrigin + t - t0);
        recordSwap(ms, swapId);
        post({ t: 'l1-ready', swapId, ms });
        setLayer('L1');
      },
    });
    S.player = player;
    await player.load(blob);
    await player.start(at || 0);
    if (document.hidden) player.pause();
    keepAwake();
  } catch (e) {
    log(`Layer 1 start failed: ${e.message}`);
    post({ t: 'l1-failed', swapId, error: e.message });
  }
}

function becomeL2() {
  setLayer('L2');
  const p = S.player; S.player = null;
  // Let the panel fade in over the video, then release the decoder and blob URL.
  setTimeout(() => p?.dispose(), 350);
}

function recordSwap(ms, id) {
  if (id === 'start') { log(`initial Layer 1 start: first frame after ${ms} ms`); return; }
  S.swaps.push(ms);
  log(`swap ${S.swaps.length}: ${ms} ms${ms > 1000 ? '  ⚠ over 1 s' : ''}`);
  S.onSwapRecorded?.(ms);
}

function requestSwap() {
  if (S.layer === 'setup') return;
  if (!S.peer.alive) { log('swap: no peer window'); return; }
  const t0 = epoch();
  if (S.layer === 'L1') doSwap(t0); else post({ t: 'swap-request', t0 });
}

function doSwap(t0) {
  if (S.pendingSwap || !S.player || !S.clip?.blob) return;
  const id = Math.random().toString(36).slice(2, 8);
  S.pendingSwap = { id, t0 };
  post({ t: 'become', blob: S.clip.blob, meta: clipMeta(), at: S.player.currentTime(), swapId: id, t0 });
  setTimeout(() => {
    if (S.pendingSwap?.id === id) { S.pendingSwap = null; S.swapFails++; log('swap timed out (3 s)'); }
  }, 3000);
}

// ---------------------------------------------------------------- auto-swap leak test
async function autoSwap(n = 50) {
  const btn = $('autoBtn');
  btn.disabled = true;
  const heap0 = heapMB();
  const start = S.swaps.length;
  log(`auto-swap ×${n} started, JS heap ${heap0} MB`);
  for (let i = 0; i < n; i++) {
    const got = new Promise((r) => { S.onSwapRecorded = r; setTimeout(r, 4000); });
    requestSwap();
    await got;
    S.onSwapRecorded = null;
    await new Promise((r) => setTimeout(r, 1500));
    btn.textContent = `Auto-swap ${i + 1}/${n}`;
  }
  const done = S.swaps.slice(start);
  log(`auto-swap done: ${done.length}/${n} ok, ${summary(done)}, heap ${heap0} → ${heapMB()} MB (this window)`);
  btn.textContent = 'Auto-swap ×50'; btn.disabled = false;
}

function summary(a) {
  if (!a.length) return 'n=0';
  const s = [...a].sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n=${s.length} min ${s[0]} · med ${q(0.5)} · p95 ${q(0.95)} · max ${s[s.length - 1]} ms`;
}

// ---------------------------------------------------------------- setup: clip
$('file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await useSource(f, f.name);
};
$('clipSel').onchange = async (e) => { if (e.target.value) await useSource(e.target.value, e.target.selectedOptions[0].text); };
$('genBtn').onclick = async () => {
  const b = $('genBtn'); b.disabled = true;
  const blob = await generateTestClip({ onProgress: (p) => { b.textContent = `Recording… ${Math.round(p * 100)}%`; } });
  b.textContent = 'Generate test clip'; b.disabled = false;
  await useSource(blob, 'generated-test.webm');
};

async function useSource(src, name) {
  $('clipInfo').textContent = `reading ${name}…`;
  try {
    const { blob, ms, codec } = await loadIntoRam(src);
    const mb = +(blob.size / 2 ** 20).toFixed(1);
    S.clip = { blob, name, codec, readMs: ms, mb };
    const bad = /AV1|HEVC|unknown/.test(codec);
    $('clipInfo').innerHTML = `${name}\n${mb} MB in RAM · read in ${ms} ms · codec <span class="${bad ? 'warn' : 'good'}">${codec}</span>` +
      (bad ? '\n⚠ not H.264/VP9: may decode on CPU' : '') + (mb > 300 ? '\n⚠ over 300 MB RAM budget' : '');
    log(`clip loaded: ${name}, ${mb} MB, ${codec}, ${ms} ms`);
    ['startDual', 'startWindowed', 'startSingle'].forEach((id) => { $(id).disabled = false; });
  } catch (e) {
    $('clipInfo').textContent = `failed: ${e.message}`;
    log(`clip load failed: ${e.message}`);
  }
}

async function listServerClips() {
  try {
    const r = await fetch(srvBase() + '/clips', { cache: 'no-store' });
    for (const c of await r.json()) {
      const o = document.createElement('option');
      o.value = srvBase() + c.url; o.textContent = `${c.name} (${(c.bytes / 2 ** 20).toFixed(0)} MB)`;
      $('clipSel').appendChild(o);
    }
  } catch { /* no server or no clips */ }
}

// ---------------------------------------------------------------- setup: screens
$('detectBtn').onclick = detectScreens;
async function detectScreens() {
  if (!('getScreenDetails' in window)) { $('screens').textContent = 'Window Management API not available (needs Chrome + secure context: localhost/https)'; log('getScreenDetails unsupported'); return; }
  try {
    const sd = await window.getScreenDetails();
    S.screens = sd;
    sd.addEventListener('screenschange', () => { log(`screenschange: now ${sd.screens.length} screen(s)`); renderScreens(); });
    sd.addEventListener('currentscreenchange', () => log(`window moved to screen "${sd.currentScreen.label}"`));
    renderScreens();
    const ext = sd.screens.findIndex((s) => !s.isInternal);
    $('wallScreen').value = String(ext >= 0 ? ext : sd.screens.length - 1);
    log(`detected ${sd.screens.length} screen(s)`);
  } catch (e) { $('screens').textContent = `denied / failed: ${e.message}`; log(`getScreenDetails failed: ${e.message}`); }
}

function renderScreens() {
  const sd = S.screens; if (!sd) return;
  $('screens').textContent = sd.screens.map((s, i) =>
    `#${i} ${s.label || '(no label)'}${s.isPrimary ? ' · primary' : ''}${s.isInternal ? ' · internal' : ' · external'}\n` +
    `   ${s.width}×${s.height} @ dpr ${s.devicePixelRatio}  avail ${s.availLeft},${s.availTop} ${s.availWidth}×${s.availHeight}`).join('\n');
  const sel = $('wallScreen'), keep = sel.value;
  sel.innerHTML = sd.screens.map((s, i) => `<option value="${i}">#${i} ${s.label || ''} ${s.width}×${s.height}</option>`).join('');
  if (keep) sel.value = keep;
}

// ---------------------------------------------------------------- start
$('startDual').onclick = () => startTwo(true);
$('startWindowed').onclick = () => startTwo(false);
$('startSingle').onclick = async () => {
  try { await document.documentElement.requestFullscreen(); } catch (e) { log(`fullscreen failed: ${e.message}`); }
  becomeL1(S.clip.blob, clipMeta(), 0, 'start', epoch());
};

async function startTwo(fullscreen) {
  let feats;
  if (fullscreen) {
    if (!S.screens) { log('detect screens first'); return; }
    const list = S.screens.screens;
    const wall = list[Number($('wallScreen').value) || 0];
    const ctrl = list.find((s) => s !== wall) || wall;
    if (ctrl === wall) log('only one screen: both windows will share it');
    try { await document.documentElement.requestFullscreen({ screen: ctrl }); log(`A fullscreen on "${ctrl.label}"`); }
    catch (e) { log(`A fullscreen failed: ${e.message}`); }
    feats = `popup,left=${wall.availLeft},top=${wall.availTop},width=${wall.availWidth},height=${wall.availHeight}` + ($('fsPopup').checked ? ',fullscreen' : '');
  } else {
    feats = `popup,left=${screen.availLeft + 60},top=${screen.availTop + 60},width=960,height=540`;
  }
  S.sendToBOnHello = true;
  const w = window.open(`./?role=B${fullscreen ? '&fs=1' : ''}`, 'jhk-B', feats);
  log(w ? `opened W-B (${feats})` : 'W-B popup BLOCKED: allow popups for this site');
}

// ---------------------------------------------------------------- fullscreen, wake lock, visibility
async function toggleFs() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) { log(`fullscreen: ${e.message}`); }
}
$('fsBtn').onclick = toggleFs;
$('tapFs').querySelector('button').onclick = async () => { await toggleFs(); $('tapFs').classList.add('hidden'); };
document.addEventListener('fullscreenchange', () => log(`fullscreen ${document.fullscreenElement ? 'ON' : 'off'}`));

async function keepAwake() {
  if (!('wakeLock' in navigator) || S.wakeLock || document.hidden) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; log('wake lock released'); });
    log('wake lock held');
  } catch (e) { log(`wake lock failed: ${e.message}`); }
}

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    if (S.player) { S.player.pause(); log('hidden → Layer 1 paused (auto-yield)'); } else log('hidden');
  } else {
    log(`visible again after ${((Date.now() - hiddenAt) / 1000).toFixed(1)} s`);
    S.player?.resume();
    keepAwake();
  }
});

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 's') requestSwap();
  else if (k === 'f') toggleFs();
  else if (k === 'h') { S.hudOn = !S.hudOn; $('hud').classList.toggle('hidden', S.layer !== 'L1' || !S.hudOn); }
  else if (k === 'p' && S.player) { S.player.paused ? S.player.resume() : S.player.pause(); }
});
$('swapBtn').onclick = requestSwap;
$('autoBtn').onclick = () => autoSwap(50);

// ---------------------------------------------------------------- vitals
function heapMB() { return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : 'n/a'; }

let battery = null;
navigator.getBattery?.().then((b) => { battery = b; }).catch(() => {});

if ('PressureObserver' in window) {
  try {
    const po = new PressureObserver((recs) => { S.pressure = recs[recs.length - 1].state; });
    po.observe('cpu', { sampleInterval: 2000 }).catch((e) => { S.pressure = `unavailable (${e.message})`; });
  } catch (e) { S.pressure = `unavailable (${e.message})`; }
} else S.pressure = 'API missing';

function renderHud(st) {
  if (S.layer !== 'L1' || !S.hudOn) return;
  $('hud').textContent = `${st.width}×${st.height} · ${st.fps} fps · dropped ${st.dropped}/${st.totalDecoded}\n` +
    `loops ${st.loops} · hitches ${st.hitches} · seam ${st.lastSeamMs}/${st.worstSeamMs} ms · t ${st.mediaTime}/${st.duration}s`;
}

function render() {
  const p = S.peer;
  $('roleTag').textContent = `W-${ROLE} · ${S.layer}`;
  $('linkTag').textContent = p.alive ? `peer W-${OTHER} ✓ ${p.rtt != null ? p.rtt.toFixed(1) + ' ms' : ''}` : 'peer: none';
  $('linkTag').className = `tag ${p.alive ? 'ok' : ''}`;
  if (S.layer === 'setup') return;

  $('swapInfo').textContent = `${summary(S.swaps)}\nfails ${S.swapFails}${S.pendingSwap ? '\nswapping…' : ''}\nlast: ${S.swaps.slice(-5).join(', ') || '—'} ms`;
  const st = S.loopStats;
  $('loopInfo').textContent = st
    ? `${st.width}×${st.height} · ${st.fps} fps (frame ${st.frameMs} ms)${st.paused ? ' · PAUSED' : ''}\n` +
      `dropped ${st.dropped} / ${st.totalDecoded} decoded\n` +
      `loops ${st.loops} · hitches ${st.hitches} (worst gap ${st.worstGapMs} ms)\n` +
      `seam last ${st.lastSeamMs} ms · worst ${st.worstSeamMs} ms · late loops ${st.lateLoops}\n` +
      `blob ${st.blobMB} MB · clip ${st.duration} s · at ${st.mediaTime} s`
    : 'waiting for stats…';

  const c = navigator.connection;
  const b = battery ? `${Math.round(battery.level * 100)}%${battery.charging ? ' charging' : ''}` : 'n/a';
  $('selfInfo').textContent =
    `screen ${screen.width}×${screen.height} @ dpr ${devicePixelRatio}${screen.isExtended ? ' · extended desktop' : ''}\n` +
    `fullscreen ${document.fullscreenElement ? 'yes' : 'no'} · visible ${!document.hidden} · wake lock ${S.wakeLock ? 'held' : 'no'}\n` +
    `JS heap ${heapMB()} MB · blob ref ${S.clip?.blob ? S.clip.mb + ' MB' : 'none'}\n` +
    `CPU pressure ${S.pressure} · battery ${b}\n` +
    `net ${navigator.onLine ? 'online' : 'OFFLINE'}${c ? ` · ${c.effectiveType} ~${c.downlink} Mb/s rtt ${c.rtt} ms` : ''}\n` +
    `isolated ${self.crossOriginIsolated}`;
}
setInterval(render, 1000);

// ---------------------------------------------------------------- server
function srvBase() {
  const v = $('srvBase').value.trim();
  if (v) return v.replace(/\/$/, '');
  return location.protocol.startsWith('http') ? location.origin : 'http://localhost:8080';
}

async function pingServer() {
  const tag = $('srvTag');
  try {
    const t = performance.now();
    const r = await fetch(srvBase() + '/ping', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const rtt = performance.now() - t;
    tag.textContent = `server ✓ ${rtt.toFixed(0)} ms`; tag.className = 'tag ok';
    S.server = { ...(S.server || {}), rtt: +rtt.toFixed(1) };
  } catch {
    tag.textContent = 'server offline'; tag.className = 'tag bad';
    S.server = null;
  }
}

async function healthServer() {
  try {
    const h = await (await fetch(srvBase() + '/health', { cache: 'no-store' })).json();
    S.server = { ...(S.server || {}), health: h };
    $('srvInfo').textContent =
      `${h.hostname} · ${h.platform}${h.inCrostini ? ' · Crostini' : ''}\n` +
      `node ${h.node} · up ${h.uptimeS} s · ${h.requests} req · ${h.activeClients60s} client(s)/60s\n` +
      `VM mem ${h.mem.availMB}/${h.mem.totalMB} MB free (${h.mem.source}) · rss ${h.rssMB} MB · load ${h.load.join(' ')}\n` +
      `sqlite ${h.sqlite.ok ? 'WAL ✓ boots ' + h.sqlite.boots : '✗ ' + (h.sqlite.reason || h.sqlite.journal_mode)}\n` +
      `LAN (server view): ${h.lan.map((a) => a.addr).join(', ') || 'none'}\n` +
      `phone page: http://<laptop-wifi-ip>:${h.port}/lan.html`;
  } catch { $('srvInfo').textContent = `no server at ${srvBase()}`; }
}
setInterval(pingServer, 2000);
setInterval(healthServer, 10000);

// ---------------------------------------------------------------- codecs
async function probeCodecs() {
  if (!navigator.mediaCapabilities) return;
  const rows = [
    ['H.264 1080p30', 'video/mp4; codecs="avc1.640028"', 1920, 1080, 30],
    ['VP9 1080p30', 'video/webm; codecs="vp09.00.40.08"', 1920, 1080, 30],
    ['H.264 1440p60', 'video/mp4; codecs="avc1.640032"', 2560, 1440, 60],
    ['VP9 1440p60', 'video/webm; codecs="vp09.00.50.08"', 2560, 1440, 60],
    ['HEVC 1080p30', 'video/mp4; codecs="hvc1.1.6.L120.90"', 1920, 1080, 30],
    ['AV1 1080p30 (avoid)', 'video/mp4; codecs="av01.0.08M.08"', 1920, 1080, 30],
  ];
  const out = [];
  for (const [label, contentType, width, height, framerate] of rows) {
    try {
      const r = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType, width, height, framerate, bitrate: 8e6 } });
      out.push({ label, ...pick(r) });
    } catch (e) { out.push({ label, supported: false, err: e.message }); }
  }
  S.codecs = out;
  $('codecTbl').innerHTML = '<tr><td></td><td>supported</td><td>smooth</td><td>power-efficient (HW)</td></tr>' +
    out.map((r) => `<tr><td>${r.label}</td>${['supported', 'smooth', 'powerEfficient'].map((k) => `<td class="${r[k] ? 'good' : 'warn'}">${r[k] ? 'yes' : 'no'}</td>`).join('')}</tr>`).join('');
}
const pick = ({ supported, smooth, powerEfficient }) => ({ supported, smooth, powerEfficient });

// ---------------------------------------------------------------- report
$('copyBtn').onclick = async () => {
  const sd = S.screens?.screens?.map((s) => ({ label: s.label, w: s.width, h: s.height, dpr: s.devicePixelRatio, internal: s.isInternal, primary: s.isPrimary }));
  const report = {
    at: new Date().toISOString(), role: ROLE, layer: S.layer, ua: navigator.userAgent,
    screens: sd, clip: clipMeta(), codecs: S.codecs, swaps: { summary: summary(S.swaps), all: S.swaps, fails: S.swapFails },
    loop: S.loopStats, pressure: S.pressure, server: S.server, log: S.events,
  };
  try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); log('report copied to clipboard'); }
  catch (e) { log(`clipboard failed (${e.message}); report printed to console`); console.log(report); }
};

// ---------------------------------------------------------------- boot
$('srvBase').placeholder = srvBase();
if (ROLE === 'A') {
  setLayer('setup');
  probeCodecs();
  listServerClips();
} else {
  setLayer('L2');
  log('W-B ready, waiting for W-A');
  if (params.get('fs') === '1') {
    // If the "fullscreen popup" feature worked we are already fullscreen; otherwise ask for one tap.
    setTimeout(() => { if (!document.fullscreenElement) $('tapFs').classList.remove('hidden'); else log('opened directly in fullscreen'); }, 400);
  }
  post({ t: 'hello' });
}
pingServer(); healthServer();
log(`W-${ROLE} loaded · ${location.href}`);
