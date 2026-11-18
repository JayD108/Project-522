// End-to-end smoke test of the built app in headless Chrome via raw CDP (no Puppeteer).
// Emulates two screens with --screen-info so the dual-screen path really runs.
// Usage: node e2e/smoke.mjs [baseUrl] [--chrome=path]
//   needs the server running:  node server/probe-server.mjs   (serves app/dist at /app/)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:8080';
const CHROME = (process.argv.find((a) => a.startsWith('--chrome=')) || '').slice(9) ||
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const PORT = 9334;
const KF = Number((process.argv.find((a) => a.startsWith('--kf=')) || '--kf=2000').slice(5));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--screen-info={1536x864}{2560x1440}', // labels/isInternal are not accepted by this flag
  'about:blank',
], { stdio: 'ignore' });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`); };

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.wait = new Map(); this.errors = [];
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)(m); this.wait.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    this.ready = new Promise((r) => { this.ws.onopen = r; });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.wait.set(id, r)); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, userGesture: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  }
  async until(expr, ms = 15000) {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await this.ev(expr).catch(() => false)) return true; await sleep(250); }
    return false;
  }
}

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let targets;
for (let i = 0; i < 40; i++) { try { targets = await list(); break; } catch { await sleep(250); } }

const browser = new Cdp((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
await browser.ready;
const origin = new URL(BASE).origin;
for (const name of ['window-management', 'screen-wake-lock']) {
  const r = await browser.send('Browser.setPermission', { origin, permission: { name }, setting: 'granted' });
  if (r.error) console.log(`(could not grant ${name}: ${r.error.message})`);
}

const A = new Cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await A.ready;
await A.send('Runtime.enable');
await A.send('Page.navigate', { url: `${BASE}/app/?debug` });
check('app boots', await A.until(`!!window.__jhk`));

// 1 · import a clip into OPFS: a real encoded clip from /clips if present (tools/make-test-clips.sh),
//     else the in-browser generated one (its WebM has no seek index → expect slow mid-clip starts).
const reads0 = await A.ev(`__jhk.state.diskReads.value`);
const clipUrl = await A.ev(`fetch('/clips').then(r => r.json()).then(l => (l.find(c => /test_1080p30\.mp4$/.test(c.name)) || l[0])?.url || '')`).catch(() => '');
if (clipUrl) {
  console.log(`      using ${clipUrl}`);
  await A.ev(`fetch('${clipUrl}').then(r => r.blob()).then(b => __jhk.importBlob(b, '${clipUrl.split('/').pop()}'))`);
} else {
  console.log('      no /clips found → generated MediaRecorder clip (swap timings will be pessimistic)');
  await A.ev(`(async () => { const m = await import('/loop.js'); const b = await m.generateTestClip({ seconds: 6, keyframeMs: ${KF} }); await __jhk.importBlob(b, 'e2e-clip.webm'); })()`);
}
const lib = await A.ev(`__jhk.state.library.value.map(w => w.name + ' ' + w.codec + ' ' + w.width + 'x' + w.height)`);
check('import into OPFS', lib?.length >= 1, JSON.stringify(lib));
check('selected wallpaper read once into RAM', (await A.ev(`__jhk.state.diskReads.value`)) === reads0 + 1);

// 2 · screens + start → dual
const scr = await A.ev(`getScreenDetails().then(d => d.screens.map(s => s.label + ':' + s.width + 'x' + s.height + (s.isInternal ? ':int' : '')))`).catch((e) => String(e));
check('two emulated screens', Array.isArray(scr) && scr.length === 2, JSON.stringify(scr));
await A.ev(`__jhk.start()`);
await sleep(500);
if (await A.ev(`__jhk.state.needMonitorTap.value`)) {
  console.log('      (popup blocked by the fullscreen click → second-tap path)');
  await A.ev(`__jhk.openMonitorWindow()`);
} else console.log('      (fullscreen + popup in one click worked)');
const dual = await A.until(`__jhk.state.mode.value === 'dual'`, 5000);
check('dual mode', dual, dual ? '' : `mode=${await A.ev(`__jhk.state.mode.value`)} toast="${await A.ev(`document.querySelector('.toast')?.textContent || ''`)}"`);
if (!dual) await finish();
await sleep(1500);
const bT = (await list()).find((t) => t.type === 'page' && t.url.includes('w=B'));
check('W-B window opened', !!bT, bT?.url);
let B;
if (bT) { B = new Cdp(bT.webSocketDebuggerUrl); await B.ready; await B.send('Runtime.enable'); }
if (B) console.log('      visibility A=%s B=%s', await A.ev('document.visibilityState'), await B.ev('document.visibilityState'));
check('W-B plays Layer 1, W-A shows Layer 2',
  await A.until(`__jhk.state.layer.value === 'L2' && __jhk.state.peer.value.alive && __jhk.state.loopStats.value?.fps > 0`, 15000));
if (B) check('W-B layer is L1', await B.until(`__jhk.state.layer.value === 'L1'`, 5000));
console.log('      A: layer=%s peer=%j stats=%j', await A.ev(`__jhk.state.layer.value`), await A.ev(`__jhk.state.peer.value`), await A.ev(`__jhk.state.loopStats.value`));

// 3 · 10 manual swaps, then the ×50 auto test
const readsBefore = await A.ev(`__jhk.state.diskReads.value`);
const readsBeforeB = B ? await B.ev(`__jhk.state.diskReads.value`) : 0;
const heap0 = await A.ev(`performance.memory?.usedJSHeapSize || 0`);
// Record each swap's breakdown in whichever window took Layer 1.
const hook = `window.__t = []; __jhk.state.lastTiming.subscribe(v => v && __t.push(v));
  window.__raf = { max: 0, big: 0 }; let __l = 0; (function f(t) { if (__l) { const g = t - __l; __raf.max = Math.max(__raf.max, g); if (g > 1000) __raf.big++; } __l = t; requestAnimationFrame(f); })(0);`;
await A.ev(hook); if (B) await B.ev(hook);
const r = await A.ev(`__jhk.autoSwap(50, 600)`);
const tA = await A.ev('__t'), tB = B ? await B.ev('__t') : [];
const slow = (l) => l.filter((t) => t.totalMs > 1000).length;
console.log('      rAF gaps: A max %d ms (%d over 1 s) · B max %d ms (%d over 1 s)', ...Object.values(await A.ev('__raf')).map(Math.round), ...(B ? Object.values(await B.ev('__raf')).map(Math.round) : [0, 0]));
console.log(`      into A: ${tA.length} swaps, ${slow(tA)} over 1 s · into B: ${tB.length} swaps, ${slow(tB)} over 1 s`);
const tAll = [...tA, ...tB].sort((a, b) => b.totalMs - a.totalMs);
console.log('      slowest swaps (load/seek/firstFrame/total ms):', tAll.slice(0, 4).map((t) => `${t.loadMs}/${t.seekMs}/${t.firstFrameMs}/${t.totalMs}@${t.atS}s`).join('  '));
const times = r?.times || [];
const sorted = [...times].sort((a, b) => a - b);
const med = sorted[sorted.length >> 1], max = sorted[sorted.length - 1];
check('50 swaps all succeed', r?.ok === 50, `ok ${r?.ok}`);
check('swap < 1 s (max)', max < 1000, `median ${med} ms · max ${max} ms`);
check('zero disk reads during swaps',
  (await A.ev(`__jhk.state.diskReads.value`)) === readsBefore && (!B || (await B.ev(`__jhk.state.diskReads.value`)) === readsBeforeB));
await A.ev(`(window.gc && gc(), 0)`);
const heap1 = await A.ev(`performance.memory?.usedJSHeapSize || 0`);
check('W-A JS heap flat after 50 swaps (< 10 MB growth)', heap1 - heap0 < 10 * 2 ** 20, `${((heap1 - heap0) / 2 ** 20).toFixed(1)} MB`);
const vids = await A.ev(`document.querySelectorAll('video').length`) + (B ? await B.ev(`document.querySelectorAll('video').length`) : 0);
check('no leaked <video> elements (2 total)', vids === 2, `${vids}`);

// 4 · hotplug: closing W-B → W-A falls back to single and plays from its own Blob ref
const readsHot = await A.ev(`__jhk.state.diskReads.value`);
if (B) await B.ev(`window.close()`).catch(() => {});
check('W-B gone → single mode, W-A on Layer 1',
  await A.until(`__jhk.state.mode.value === 'single' && __jhk.state.layer.value === 'L1'`, 10000));
check('fallback used RAM, not disk', (await A.ev(`__jhk.state.diskReads.value`)) === readsHot);

// 5 · loop keeps looping
const loops0 = (await A.ev(`__jhk.state.loopStats.value?.loops`)) || 0;
await sleep(8000);
const st = await A.ev(`__jhk.state.loopStats.value`);
check('loop continues seamlessly', st && st.loops > loops0, st ? `loops ${st.loops}, seam ${st.lastSeamMs} ms, hitches ${st.hitches}` : '');

// 6 · settings persisted + service worker
await A.ev(`__jhk.flushSettings()`);
check('settings saved to IndexedDB', await A.ev(`new Promise(r => { const q = indexedDB.open('jharokha'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('settings'); g.onsuccess = () => r(!!g.result?.currentId); }; })`));
check('service worker registered', await A.until(`navigator.serviceWorker.getRegistration().then(r => !!r?.active)`, 8000));

check('no uncaught page errors', A.errors.length === 0 && (!B || B.errors.length === 0), [...A.errors, ...(B?.errors || [])].join(' | '));

await finish();

function finish() {
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  chrome.kill();
  setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(failed ? 1 : 0); }, 500);
  return new Promise(() => {}); // stop the script here
}
