#!/usr/bin/env node
// Week 8 · soak test: run the whole thing for hours and check that memory stays flat (< 50 MB growth).
//   npm run soak                      → 72 h (the Week 8 target)
//   npm run soak -- --minutes=20      → a short run
//   node scripts/soak.mjs --minutes=60 --every=30
// It starts its OWN server (temp data dir, free port), so the real `jharokha` service is untouched, and a headless
// Chrome with two emulated screens running the dashboard (W-A) + monitor window (W-B). Every `--every` seconds it
// swaps; every 10 cycles it changes the wallpaper; the room gets polls / timers / calendar traffic like real use.
// Every minute it samples server RSS, Chrome RSS (whole process tree), each window's JS heap, <video> count,
// swap times. Output: data/soak/soak-<stamp>.csv + .json (summary, verdict). Exit 0 = pass.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from '../tests/lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const MINUTES = arg('minutes', 72 * 60);
const EVERY_S = arg('every', 60);
const SAMPLE_S = arg('sample', 60);
const LIMIT_MB = arg('limit', 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (x) => String(x).padStart(2, '0');
const d0 = new Date();
const stamp = `${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}-${pad(d0.getHours())}${pad(d0.getMinutes())}`;
const OUT = path.join(ROOT, 'data', 'soak');
fs.mkdirSync(OUT, { recursive: true });
const CSV = path.join(OUT, `soak-${stamp}.csv`), JSON_OUT = path.join(OUT, `soak-${stamp}.json`);
process.env.JHK_OPENER = 'none';

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const rssMB = (pid) => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return 0; } };
function treeRssMB(rootPid) {
  // Sum RSS over a process and all its descendants (Chrome = browser + GPU + renderers + utility processes).
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const ppid = Number(fs.readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1].split(' ')[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d)); } catch { /* gone */ }
  }
  let sum = 0; const stack = [rootPid];
  while (stack.length) { const p = stack.pop(); sum += rssMB(p); stack.push(...(kids.get(p) || [])); }
  return sum;
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let server, chrome, exitCode = 1;
const samples = [];
try {
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome/Chromium found (set CHROME_PATH)');
  if (!fs.existsSync(path.join(ROOT, 'app', 'dist', 'index.html'))) throw new Error('app not built: run `npm run build` first');
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-soak-'));
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', JHK_DATA: dataDir, JHK_NETGUARD_LOOKUP: '0', JHK_OFFLINE: '1' }, stdio: 'ignore' });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/ping`)).ok) break; } catch { /* */ } await sleep(100); }
  log(`server pid ${server.pid} on :${port} (data ${dataDir})`);

  const cport = await freePort();
  chrome = await launch({ bin, port: cport, origin: base, screens: '{1536x864}{2560x1440}', grant: ['window-management'] });
  const chromePid = Number(execFileSync('pgrep', ['-f', `remote-debugging-port=${cport}`], { encoding: 'utf8' }).trim().split('\n')[0]);
  const A = await chrome.attach((await chrome.pageTargets())[0]);
  await A.send('Page.enable');
  await A.send('Page.navigate', { url: `${base}/app/?debug` });
  if (!(await A.until('!!window.__jhk && !!document.querySelector(".panel")', 20000))) throw new Error('dashboard did not boot');
  await A.ev('__jhk.loadSamples()', 60000);
  await A.ev('__jhk.start()', 20000);
  await sleep(800);
  if (await A.ev('__jhk.state.needMonitorTap.value')) await A.ev('__jhk.openMonitorWindow()');
  let bt = null;
  for (let i = 0; i < 40 && !bt; i++) { bt = (await chrome.pageTargets()).find((t) => t.url.includes('w=B')); if (!bt) await sleep(250); }
  if (!bt) throw new Error('monitor window never opened');
  const B = await chrome.attach(bt);
  await A.until(`__jhk.state.mode.value === 'dual'`, 10000);
  log(`chrome pid ${chromePid}, dual screen up; running ${MINUTES} min, a cycle every ${EVERY_S} s`);

  const own = (p, body, method) => fetch(base + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json()).catch(() => ({}));
  fs.writeFileSync(CSV, 'minute,server_rss_mb,chrome_rss_mb,heap_a_mb,heap_b_mb,videos,swaps,swap_med_ms,swap_max_ms,stacked,fps,dropped,errors\n');
  const heap = (S) => S.ev(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1`).catch(() => -1);
  const t0 = Date.now();
  let cycle = 0, nextSample = 0, swapTimes = [];
  while (Date.now() - t0 < MINUTES * 60000) {
    cycle++;
    try {
      const n0 = await A.ev('__jhk.state.swaps.value.length');
      if (!(await A.ev('__jhk.state.stacked.value'))) {
        await A.ev('__jhk.swap()');
        if (await A.until(`__jhk.state.swaps.value.length > ${n0}`, 5000, 100)) swapTimes.push(await A.ev('__jhk.state.swaps.value.at(-1)'));
      } else { await A.ev('__jhk.unstack()'); }
      if (cycle % 10 === 0) await A.ev('__jhk.stepWallpaper(1)');
      // room traffic
      const p = await own('/api/tools/poll', { q: `Soak ${cycle}?`, options: ['yes', 'no'] });
      if (p.poll) { await own(`/api/tools/poll/${p.poll.id}/vote`, { option: p.poll.options[0].id }); await own(`/api/tools/poll/${p.poll.id}`, undefined, 'DELETE'); }
      const ev = await own('/api/tools/event', { title: `soak ${cycle}`, at: Date.now() + 3600e3, allDay: false, remind: 10 });
      if (ev.event) await own(`/api/tools/event/${ev.event.id}`, undefined, 'DELETE');
      if (cycle % 5 === 0) await own('/api/system/backups', {});
    } catch (e) { log('cycle error:', e.message); }
    if (Date.now() - t0 >= nextSample) {
      nextSample += SAMPLE_S * 1000;
      await sleep(1500);                 // let the last swap's old player finish fading out before counting <video>s
      const s = [...swapTimes].sort((a, b) => a - b);
      const row = {
        minute: +((Date.now() - t0) / 60000).toFixed(1), server: rssMB(server.pid), chrome: treeRssMB(chromePid), heapA: await heap(A), heapB: await heap(B),
        videos: (await A.ev(`document.querySelectorAll('video').length`).catch(() => -1)) + (await B.ev(`document.querySelectorAll('video').length`).catch(() => -1)),
        swaps: swapTimes.length, med: s.length ? s[s.length >> 1] : 0, max: s.length ? s.at(-1) : 0, stacked: await A.ev('__jhk.state.stacked.value').catch(() => null),
        fps: await A.ev(`__jhk.state.loopStats.value?.fps ?? -1`).catch(() => -1), dropped: await A.ev(`__jhk.state.loopStats.value?.dropped ?? -1`).catch(() => -1), errors: A.errors.length + B.errors.length,
      };
      samples.push(row);
      fs.appendFileSync(CSV, `${row.minute},${row.server},${row.chrome},${row.heapA},${row.heapB},${row.videos},${row.swaps},${row.med},${row.max},${row.stacked},${row.fps},${row.dropped},${row.errors}\n`);
      log(`min ${row.minute}: server ${row.server} MB · chrome ${row.chrome} MB · heap ${row.heapA}/${row.heapB} MB · videos ${row.videos} · swaps ${row.swaps} (med ${row.med} ms)`);
      swapTimes = swapTimes.slice(-200);
    }
    await sleep(EVERY_S * 1000);
  }
  exitCode = 0;
} catch (e) {
  console.error('soak aborted:', e.message);
} finally {
  // Verdict: growth = average of the last 5 samples minus the average after warm-up (samples 3-7).
  const avg = (a, k) => (a.length ? a.reduce((x, r) => x + r[k], 0) / a.length : 0);
  const warm = samples.slice(2, 7), end = samples.slice(-5);
  const growth = samples.length >= 8 ? { server: +(avg(end, 'server') - avg(warm, 'server')).toFixed(1), chrome: +(avg(end, 'chrome') - avg(warm, 'chrome')).toFixed(1), heapA: +(avg(end, 'heapA') - avg(warm, 'heapA')).toFixed(1), heapB: +(avg(end, 'heapB') - avg(warm, 'heapB')).toFixed(1) } : null;
  const pass = exitCode === 0 && !!growth && growth.server < LIMIT_MB && growth.chrome < LIMIT_MB && samples.every((r) => r.videos <= 2);
  const summary = { startedAt: d0.toISOString(), minutes: MINUTES, samples: samples.length, limitMB: LIMIT_MB, growth, last: samples.at(-1) ?? null, pass, csv: CSV };
  fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
  console.log(`\nsoak ${pass ? 'PASS' : 'FAIL'}: ${growth ? `server +${growth.server} MB, chrome +${growth.chrome} MB, heap A +${growth.heapA} / B +${growth.heapB} MB` : 'not enough samples (needs ≥ 8 minutes)'} over ${samples.length} samples`);
  console.log(`csv: ${CSV}\nsummary: ${JSON_OUT}`);
  try { await chrome?.close(); } catch { /* */ }
  server?.kill();
  process.exit(pass ? 0 : 1);
}
