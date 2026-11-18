#!/usr/bin/env node
// Jharokha: one command runs every check and writes ONE readable log: test-run-<timestamp>.log
//   npm test                 (from the repo root)
//   node tests/run-all.mjs [--no-browser] [--swaps=N]
// Exit code 0 = all checks passed (skips allowed), 1 = something failed.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, chromeVersion, launch } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const args = process.argv.slice(2);
const NO_BROWSER = args.includes('--no-browser');
const SWAPS = Number((args.find((a) => a.startsWith('--swaps=')) || '--swaps=30').slice(8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_NODE = [22, 13];

// =============================================================================== report
const startedAt = new Date();
const pad = (x) => String(x).padStart(2, '0');
const stamp = `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`; // local time
const LOG = path.join(ROOT, `test-run-${stamp}.log`);
const sections = [];
let cur = null;
const header = {};

function section(title) { cur = { title, checks: [], notes: [], t0: Date.now() }; sections.push(cur); console.log(`\n[${sections.length}] ${title}`); }
function note(line) { cur.notes.push(line); console.log(`      ${line}`); }
/** Record one check. status: 'PASS' | 'FAIL' | 'SKIP'. */
function record(name, status, detail = '', ms = null, extra = '') {
  cur.checks.push({ name, status, detail, ms, extra });
  console.log(`  ${status.padEnd(4)}  ${name}${detail ? '  · ' + detail : ''}${ms != null ? `  (${fmtMs(ms)})` : ''}`);
}
const pass = (n, d, ms) => record(n, 'PASS', d, ms);
const fail = (n, d, ms, extra) => record(n, 'FAIL', d, ms, extra);
const skip = (n, why) => record(n, 'SKIP', why);
const check = (n, ok, okDetail, failReason, ms, extra) => (ok ? pass(n, okDetail, ms) : fail(n, failReason || okDetail, ms, extra));
/** Run fn as one timed check; a thrown error becomes FAIL with its message as the reason. */
async function timed(name, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    const ok = r === undefined || r === true || r?.ok !== false;
    const detail = typeof r === 'object' && r ? r.detail || '' : '';
    if (ok) pass(name, detail, Date.now() - t);
    else fail(name, r.reason || detail || 'check returned false', Date.now() - t, r.extra);
    return ok;
  } catch (e) {
    fail(name, e.message || String(e), Date.now() - t, e.extra);
    return false;
  }
}
function fmtMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`; }
const tail = (txt, n = 25) => String(txt || '').trim().split(/\r?\n/).slice(-n).join('\n');

function writeLog() {
  const all = sections.flatMap((s) => s.checks);
  const n = (st) => all.filter((c) => c.status === st).length;
  const W = 78, bar = '='.repeat(W), sub = '-'.repeat(W);
  const L = [];
  L.push(bar, ` JHAROKHA TEST RUN · ${startedAt.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`, bar);
  for (const [k, v] of Object.entries(header)) L.push(` ${k.padEnd(9)}: ${v}`);
  L.push(` Command  : node tests/run-all.mjs ${args.join(' ')}`.trimEnd());
  L.push(sub, ` RESULT   : ${n('FAIL') ? 'FAILED' : 'ALL PASSED'} · ${n('PASS')} passed · ${n('FAIL')} failed · ${n('SKIP')} skipped · ${fmtMs(Date.now() - startedAt)}`, bar, '');
  sections.forEach((s, i) => {
    L.push(`[${i + 1}] ${s.title}`, sub);
    for (const c of s.checks) {
      const time = c.ms != null ? ` (${fmtMs(c.ms)})` : '';
      L.push(`  ${c.status.padEnd(4)}  ${c.name}${time}`);
      if (c.detail) L.push(`        ${c.status === 'FAIL' ? 'reason: ' : c.status === 'SKIP' ? 'why:    ' : ''}${c.detail}`);
    }
    if (s.notes.length) { L.push('  notes:'); s.notes.forEach((x) => L.push(`    · ${x}`)); }
    L.push('');
  });
  const failed = sections.flatMap((s) => s.checks.filter((c) => c.status === 'FAIL').map((c) => ({ ...c, section: s.title })));
  L.push(bar, ' FAILURES', bar);
  if (!failed.length) L.push('  none');
  for (const f of failed) {
    L.push(`  ✗ [${f.section}] ${f.name}`, `      reason: ${f.detail}`);
    if (f.extra) L.push('      ---- output (last lines) ----', ...String(f.extra).split('\n').map((x) => '      ' + x), '      -----------------------------');
  }
  L.push('', bar, ` END · log file: ${LOG}`, bar, '');
  fs.writeFileSync(LOG, L.join('\n'), 'utf8');
  return { failed: n('FAIL') };
}

// =============================================================================== helpers
const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
/** Run a command, capture combined output. On Windows npm/npx are .cmd shims, so they go through the shell. */
function run(cmd, argv, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const p = process.platform === 'win32'
      ? spawn([cmd, ...argv].map(q).join(' '), { cwd, shell: true, env })
      : spawn(cmd, argv, { cwd, env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill(); out += `\n[killed after ${timeoutMs} ms]`; }, timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, ''), ms: Date.now() - t }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e), ms: Date.now() - t }); });
  });
}
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const tryExec = (cmd, a) => {
  try {
    if (process.platform === 'win32' && cmd === 'npm') return execFileSync([cmd, ...a].map(q).join(' '), { encoding: 'utf8', shell: true }).trim();
    return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

// =============================================================================== main
let server = null;
const chromes = [];
let exitCode = 1;
try {
  header.Machine = `${os.platform()} ${os.arch()} · ${os.release()} · ${os.cpus().length} CPU threads · ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`;
  header.Node = `${process.version} · npm ${tryExec('npm', ['-v']) || '?'}`;
  const sha = tryExec('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']);
  const dirty = tryExec('git', ['-C', ROOT, 'status', '--porcelain']);
  header.Git = sha ? `${sha} (${tryExec('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'])}) · ${dirty ? 'uncommitted changes' : 'clean tree'}` : 'not a git checkout';

  // ----------------------------------------------------------------------------- 1. environment
  section('ENVIRONMENT & DEPENDENCIES');
  const [maj, min] = process.versions.node.split('.').map(Number);
  check(`Node.js >= ${MIN_NODE.join('.')}`, maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]), process.version,
    `found ${process.version}; install Node 22 LTS or newer (see SETUP.md)`);
  await timed('node:sqlite built-in available (server DB)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:'); db.close();
    return { detail: 'ok' };
  });
  const npmV = tryExec('npm', ['-v']);
  check('npm available', !!npmV, `npm ${npmV}`, 'npm not on PATH');
  if (!fs.existsSync(path.join(APP, 'node_modules'))) {
    note('app/node_modules missing → running `npm ci` in app/ (first run)');
    const r = await run('npm', ['ci', '--no-audit', '--no-fund'], APP);
    check('install app dependencies (npm ci)', r.code === 0, 'installed', `npm ci exited ${r.code}`, r.ms, tail(r.out));
  }
  const REQUIRED = ['preact', '@preact/signals', 'vite', '@preact/preset-vite', 'typescript', 'vite-plugin-pwa', 'vitest'];
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  for (const name of REQUIRED) {
    const want = pkg.dependencies?.[name] || pkg.devDependencies?.[name];
    const pj = path.join(APP, 'node_modules', ...name.split('/'), 'package.json');
    const have = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).version : null;
    check(`package ${name}`, !!have, `${have} (wants ${want})`, have ? '' : `not installed (wants ${want}); run: npm run setup`);
  }
  const ls = await run('npm', ['ls', '--depth=0'], APP, 60000);
  check('dependency tree consistent (npm ls)', ls.code === 0, 'no missing/invalid packages', 'npm ls reports problems', ls.ms, tail(ls.out, 15));
  const samples = ['sample_720p30.mp4', 'sample_720p30_vp9.webm'].map((f) => path.join(ROOT, 'samples', f));
  const missing = samples.filter((f) => !fs.existsSync(f)).map((f) => path.basename(f));
  check('sample videos present', !missing.length,
    missing.length ? '' : samples.map((f) => `${path.basename(f)} ${(fs.statSync(f).size / 2 ** 20).toFixed(2)} MB`).join(', '),
    `missing in samples/: ${missing.join(', ')} (restore with git checkout -- samples/)`);
  const chromeBin = NO_BROWSER ? null : findChrome();
  if (NO_BROWSER) skip('Chrome for browser tests', '--no-browser given');
  else if (!chromeBin) skip('Chrome for browser tests', 'no Chrome/Chromium found (set CHROME_PATH); browser sections will be skipped');
  else { header.Chrome = `${chromeVersion(chromeBin)} · ${chromeBin}`; pass('Chrome for browser tests', header.Chrome); }

  // ----------------------------------------------------------------------------- 2. build
  section('BUILD (TypeScript typecheck + Vite production build + PWA service worker)');
  const b = await run('npm', ['run', 'build'], APP);
  const built = b.code === 0;
  check('npm run build exits 0 (tsc --noEmit && vite build)', built, 'no type errors, bundle built', `build failed with exit code ${b.code}`, b.ms, tail(b.out, 40));
  const warn = b.out.split('\n').filter((l) => /warn|error/i.test(l) && !/0 errors/i.test(l));
  check('build output has no warnings/errors', built && warn.length === 0, 'clean', warn.slice(0, 5).join(' | ') || 'build failed');
  const DIST = path.join(APP, 'dist');
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js', 'icon-192.png', 'icon-512.png']) {
    check(`dist/${f} exists`, fs.existsSync(path.join(DIST, f)), '', 'missing after build');
  }
  await timed('PWA manifest is valid and installable-shaped', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8'));
    const big = (m.icons || []).some((i) => /512/.test(i.sizes));
    if (!m.name || !m.start_url || !big || !['standalone', 'fullscreen'].includes(m.display)) return { ok: false, reason: `name=${m.name} start_url=${m.start_url} display=${m.display} 512px icon=${big}` };
    return { detail: `name "${m.name}", display ${m.display}, ${m.icons.length} icons` };
  });
  if (fs.existsSync(path.join(DIST, 'assets'))) {
    const files = fs.readdirSync(path.join(DIST, 'assets'));
    const js = files.filter((f) => f.endsWith('.js')).reduce((a, f) => a + fs.statSync(path.join(DIST, 'assets', f)).size, 0);
    note(`bundle: ${files.join(', ')} · JS ${(js / 1024).toFixed(1)} KB (uncompressed)`);
    check('JS bundle under 150 KB (always-on page budget)', js < 150 * 1024, `${(js / 1024).toFixed(1)} KB`, `${(js / 1024).toFixed(1)} KB`);
  }

  // ----------------------------------------------------------------------------- 3. unit tests
  section('UNIT TESTS (vitest)');
  const vjson = path.join(os.tmpdir(), `jhk-vitest-${process.pid}.json`);
  const v = await run('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${vjson}`], APP);
  if (fs.existsSync(vjson)) {
    const rep = JSON.parse(fs.readFileSync(vjson, 'utf8'));
    for (const file of rep.testResults) {
      for (const t of file.assertionResults) {
        const name = `${path.relative(APP, file.name).replace(/\\/g, '/')} › ${t.ancestorTitles.join(' › ')} › ${t.title}`;
        check(name, t.status === 'passed', '', (t.failureMessages || []).join(' ').split('\n')[0].slice(0, 300), t.duration != null ? Math.round(t.duration) : null);
      }
    }
    fs.rmSync(vjson, { force: true });
  } else fail('vitest ran', `no JSON report (exit ${v.code})`, v.ms, tail(v.out));

  // ----------------------------------------------------------------------------- 4. server
  section('LOCAL SERVER (static app + API + SQLite WAL)');
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-data-'));
  let serverOut = '';
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'probe-server.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', JHK_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  const up = await timed(`server starts and answers /ping on :${port}`, async () => {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/ping`)).ok) return { detail: 'up' }; } catch { /* starting */ } await sleep(150); }
    return { ok: false, reason: 'no answer within 6 s', extra: tail(serverOut) };
  });
  if (up) {
    await timed('/health reports ok and SQLite in WAL mode', async () => {
      const h = await (await fetch(`${base}/health`)).json();
      if (!h.ok || !h.sqlite?.ok) return { ok: false, reason: `ok=${h.ok} sqlite=${JSON.stringify(h.sqlite)}` };
      return { detail: `node ${h.node}, journal_mode=${h.sqlite.journal_mode}, platform ${h.platform}` };
    });
    await timed('/app/ serves the built app (HTML)', async () => {
      const r = await fetch(`${base}/app/`);
      const txt = await r.text();
      return r.ok && /<div id="root">/.test(txt) ? { detail: `${r.status} ${r.headers.get('content-type')}` } : { ok: false, reason: `status ${r.status}` };
    });
    await timed('/app/sw.js is served with Cache-Control: no-store', async () => {
      const r = await fetch(`${base}/app/sw.js`);
      return r.ok && r.headers.get('cache-control') === 'no-store' ? { detail: 'no-store' } : { ok: false, reason: `status ${r.status}, cache-control ${r.headers.get('cache-control')}` };
    });
    await timed('/api/samples lists both sample clips', async () => {
      const l = await (await fetch(`${base}/api/samples`)).json();
      return l.length >= 2 ? { detail: l.map((c) => c.name).join(', ') } : { ok: false, reason: `got ${JSON.stringify(l)}` };
    });
    await timed('sample clip downloads with correct size and type', async () => {
      const r = await fetch(`${base}/samples/sample_720p30.mp4`);
      const buf = await r.arrayBuffer();
      const want = fs.statSync(samples[0]).size;
      return buf.byteLength === want && r.headers.get('content-type') === 'video/mp4' ? { detail: `${buf.byteLength} bytes, video/mp4` } : { ok: false, reason: `${buf.byteLength}/${want} bytes, ${r.headers.get('content-type')}` };
    });
    await timed('path traversal is blocked', async () => {
      const codes = [];
      for (const p of ['/app/..%2f..%2fserver%2fprobe-server.mjs', '/samples/..%2fpackage.json', '/%2e%2e/server/probe-server.mjs']) codes.push((await fetch(base + p)).status);
      return codes.every((c) => c >= 400) ? { detail: `statuses ${codes.join(', ')}` } : { ok: false, reason: `statuses ${codes.join(', ')}` };
    });
  }

  // the documented one-command start (npm start → scripts/start.mjs) must bring the app up by itself
  await timed('`npm start` (scripts/start.mjs) brings the app up on its own', async () => {
    const p2 = await freePort();
    let out2 = '';
    const st = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.mjs'), '--no-build'], {
      cwd: ROOT, env: { ...process.env, PORT: String(p2), HOST: '127.0.0.1', JHK_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    st.stdout.on('data', (d) => { out2 += d; }); st.stderr.on('data', (d) => { out2 += d; });
    try {
      for (let i = 0; i < 50; i++) {
        try { const r = await fetch(`http://localhost:${p2}/app/`); if (r.ok) return { detail: `GET /app/ → ${r.status} on :${p2} (built app; this run used --no-build after the build above)` }; } catch { /* starting */ }
        await sleep(150);
      }
      return { ok: false, reason: 'app not reachable within 7.5 s', extra: tail(out2) };
    } finally { st.kill(); }
  });

  // ----------------------------------------------------------------------------- 5-7. browser
  if (!chromeBin || !up || !built) {
    for (const t of ['VIDEO ENGINE (real playback in Chrome)', 'APP · SINGLE-SCREEN (fallback when only one display)', 'APP · DUAL-SCREEN SWAP (two emulated displays)']) {
      section(t);
      skip('whole section', !chromeBin ? (NO_BROWSER ? '--no-browser given' : 'no Chrome found') : !up ? 'server did not start' : 'build failed');
    }
  } else {
    await engineTests(chromeBin, base);
    await singleScreenTests(chromeBin, base);
    await dualScreenTests(chromeBin, base);
  }
  exitCode = 0;
} catch (e) {
  if (!cur) section('RUNNER');
  fail(`test runner crashed during "${cur.title}" (later sections did not run)`, e.message, null, e.stack);
} finally {
  for (const c of chromes) await c.close().catch(() => {});
  if (server) server.kill();
  const { failed } = writeLog();
  console.log(`\nLog written to: ${LOG}`);
  process.exit(failed || exitCode ? 1 : 0);
}

// =============================================================================== browser sections
async function openApp(chromeBin, base, opts = {}) {
  const c = await launch({ bin: chromeBin, port: await freePort(), origin: new URL(base).origin, ...opts });
  chromes.push(c);
  const page = await c.attach((await c.pageTargets())[0]);
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `${base}/app/?debug` });
  const ok = await page.until('!!window.__jhk && !!document.querySelector(".panel")', 15000);
  return { c, page, ok };
}

async function engineTests(chromeBin, base) {
  section('VIDEO ENGINE (real playback in Chrome)');
  note('Headless Chrome decodes in software; HW decode/CPU/fan are checked on the laptop (docs/DEVICE-CHECKS.md).');
  note('"dropped" comes from getVideoPlaybackQuality(). Headless Chrome reports ~95% dropped in EVERY window type (tab, new window,');
  note('popup, emulated display) while requestVideoFrameCallback still sees a full 30 fps with no hitches, so that counter is a headless');
  note('artefact and is reported but not used as a pass/fail gate here. fps / hitches / seam (measured per presented frame) are the gates.');
  const { c, page, ok } = await openApp(chromeBin, base);
  check('app page boots (debug hooks present)', ok, '', 'window.__jhk never appeared', null, page.errors.join('\n'));
  if (!ok) return;
  for (const [file, codecWanted] of [['sample_720p30.mp4', 'H.264'], ['sample_720p30_vp9.webm', 'VP9']]) {
    await timed(`${file}: fetch → RAM Blob → LoopPlayer plays and loops`, async () => {
      const r = await page.ev(`(async () => {
        const blob = await (await fetch('/samples/${file}')).blob();
        const ram = new Blob([await blob.arrayBuffer()], { type: blob.type });   // same as readToRam()
        const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;z-index:50';
        document.body.appendChild(host);
        const t0 = performance.now(); let first = 0, stats = null;
        const p = new __jhk.LoopPlayer(host, { onFirstFrame: (t) => { first = t - t0; }, onStats: (s) => { stats = s; } });
        await p.load(ram); await p.start(0);
        const tFirstWait = performance.now();
        while (!first && performance.now() - tFirstWait < 5000) await new Promise((r) => setTimeout(r, 20));
        const t1 = p.currentTime();
        const deadline = performance.now() + 12000;               // clip is 6 s: wait for one full loop
        while ((!stats || stats.loops < 1) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        await new Promise((r) => setTimeout(r, 1100));
        const out = { blobType: ram.type, blobBytes: ram.size, srcIsBlob: host.querySelector('video').src.startsWith('blob:'),
          firstFrameMs: Math.round(first), t1, t2: p.currentTime(), stats, videos: host.querySelectorAll('video').length };
        p.dispose(); host.remove();
        out.videosAfterDispose = document.querySelectorAll('.jhk-player video').length;
        return out;
      })()`, 40000);
      const s = r.stats || {};
      const problems = [];
      if (!r.srcIsBlob) problems.push('video src is not a blob: URL');
      if (!r.firstFrameMs) problems.push('no first frame within 5 s');
      if (!(s.fps > 0)) problems.push(`fps ${s.fps}`);
      if (!(s.loops >= 1)) problems.push(`no loop completed (loops=${s.loops})`);
      if (s.width !== 1280 || s.height !== 720) problems.push(`decoded ${s.width}×${s.height}, expected 1280×720`);
      if (r.videos !== 2) problems.push(`${r.videos} <video> elements, expected 2 (ping-pong)`);
      if (s.hitches > 2) problems.push(`${s.hitches} hitches (gaps > 2.5 frames)`);
      if (s.lastSeamMs > 100) problems.push(`loop seam ${s.lastSeamMs} ms (> 100 ms is visible)`);
      const detail = `${r.blobType} ${(r.blobBytes / 2 ** 20).toFixed(2)} MB in RAM · first frame ${r.firstFrameMs} ms · ${s.fps} fps · loops ${s.loops} · seam ${s.lastSeamMs} ms · hitches ${s.hitches} · dropped ${s.dropped}/${s.totalDecoded} (headless counter, see note)`;
      return problems.length ? { ok: false, reason: problems.join('; ') + ' | ' + detail } : { detail };
    });
  }
  await timed('engine releases its <video> elements on dispose', async () => {
    const n = await page.ev(`document.querySelectorAll('.jhk-player').length`);
    return n === 0 ? { detail: '0 players left' } : { ok: false, reason: `${n} players left in the DOM` };
  });
  check('no uncaught page errors', page.errors.length === 0, 'none', page.errors.slice(0, 3).join(' | '));
}

async function singleScreenTests(chromeBin, base) {
  section('APP · SINGLE-SCREEN (fallback when only one display)');
  note('One display, "manage windows" permission NOT granted (prompt auto-denied in headless) → app must fall back, not crash.');
  const { page, ok } = await openApp(chromeBin, base);
  check('app boots', ok, '', 'app did not boot', null, page.errors.join('\n'));
  if (!ok) return;
  await timed('Load sample wallpapers → imported into OPFS with codec detected', async () => {
    const n = await page.ev(`__jhk.loadSamples()`, 60000);
    const lib = await page.ev(`__jhk.state.library.value.map(w => w.name + ':' + w.codec + ':' + w.width + 'x' + w.height)`);
    const good = lib.length === 2 && lib.some((x) => x.includes(':H.264:1280x720')) && lib.some((x) => x.includes(':VP9:1280x720'));
    return good ? { detail: `${n} imported → ${lib.join(', ')}` } : { ok: false, reason: `library = ${JSON.stringify(lib)}` };
  });
  await timed('OPFS really holds the files (byte sizes match)', async () => {
    const r = await page.ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('videos');
      const out = []; for (const w of __jhk.state.library.value) { const f = await (await d.getFileHandle(w.id)).getFile(); out.push([w.bytes, f.size]); } return out; })()`);
    return r.every(([a, b]) => a === b && a > 0) ? { detail: r.map(([a]) => `${a} B`).join(', ') } : { ok: false, reason: JSON.stringify(r) };
  });
  const reads0 = await page.ev(`__jhk.state.diskReads.value`);
  check('first wallpaper pre-read into RAM exactly once', reads0 === 1, `disk reads = ${reads0}`, `disk reads = ${reads0}, expected 1`);
  await timed('Start → single-screen mode, Layer 1 playing (no crash)', async () => {
    await page.ev(`__jhk.start()`, 20000);
    const ok2 = await page.until(`__jhk.state.mode.value === 'single' && __jhk.state.layer.value === 'L1' && __jhk.state.loopStats.value?.fps > 0`, 15000);
    const st = await page.ev(`({ mode: __jhk.state.mode.value, layer: __jhk.state.layer.value, perm: __jhk.state.screensInfo.value.permission, fps: __jhk.state.loopStats.value?.fps })`);
    return ok2 ? { detail: `mode ${st.mode}, layer ${st.layer}, fps ${st.fps}, screen permission "${st.perm}"` } : { ok: false, reason: JSON.stringify(st) };
  });
  await timed('single-screen "swap" toggles the virtual layers (dashboard over video)', async () => {
    const seq = [];
    for (let i = 0; i < 4; i++) {
      await page.ev(`__jhk.swap()`);
      await sleep(400);
      seq.push(await page.ev(`({ o: __jhk.state.overlayOpen.value, panel: !document.querySelector('.panel').classList.contains('gone'), playing: !__jhk.state.loopStats.value?.paused })`));
    }
    const okSeq = seq.every((s, i) => s.o === (i % 2 === 0) && s.panel === s.o && s.playing);
    return okSeq ? { detail: `overlay ${seq.map((s) => (s.o ? 'ON' : 'off')).join(' → ')}, video kept playing` } : { ok: false, reason: JSON.stringify(seq) };
  });
  await timed('switch wallpaper → one disk read, crossfade, back to 2 <video>', async () => {
    const other = await page.ev(`__jhk.state.library.value.find(w => w.id !== __jhk.state.currentId.value).id`);
    const mb0 = await page.ev(`__jhk.state.blobMB.value`);
    await page.ev(`__jhk.select('${other}')`, 20000);
    await sleep(1500);                                         // crossfade 600 ms, then the old player is disposed
    await page.until(`__jhk.state.loopStats.value?.fps > 0 && __jhk.state.loopStats.value?.mediaTime > 0.5`, 5000);
    const r = await page.ev(`({ reads: __jhk.state.diskReads.value, cur: __jhk.state.currentId.value, mb: __jhk.state.blobMB.value, vids: document.querySelectorAll('video').length, fps: __jhk.state.loopStats.value?.fps, t: __jhk.state.loopStats.value?.mediaTime })`);
    const okSw = r.reads === reads0 + 1 && r.cur === other && r.mb !== mb0 && r.vids === 2 && r.fps > 0;
    return okSw ? { detail: `reads ${reads0}→${r.reads}, blob ${mb0}→${r.mb} MB, ${r.vids} videos, new clip playing at ${r.fps} fps (t=${r.t}s)` } : { ok: false, reason: JSON.stringify(r) };
  });
  await timed('delete the non-playing wallpaper (OPFS + library)', async () => {
    const victim = await page.ev(`__jhk.state.library.value.find(w => w.id !== __jhk.state.currentId.value).id`);
    await page.ev(`__jhk.deleteWallpaper('${victim}')`);
    const r = await page.ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('videos');
      let gone = false; try { await d.getFileHandle('${victim}'); } catch { gone = true; } return { n: __jhk.state.library.value.length, gone }; })()`);
    return r.n === 1 && r.gone ? { detail: '1 left, file removed from OPFS' } : { ok: false, reason: JSON.stringify(r) };
  });
  await timed('settings survive a reload (IndexedDB) and Start replays the chosen wallpaper', async () => {
    const cur = await page.ev(`__jhk.state.currentId.value`);
    await page.ev(`__jhk.flushSettings()`);
    await page.send('Page.reload');
    await sleep(500);
    const booted = await page.until(`!!window.__jhk && __jhk.state.currentId.value === '${cur}' && __jhk.state.diskReads.value === 1`, 15000);
    return booted ? { detail: 'same wallpaper restored, read once' } : { ok: false, reason: `currentId after reload = ${await page.ev('__jhk?.state.currentId.value').catch(() => '?')}` };
  });
  await timed('service worker active (offline app shell)', async () => (await page.until(`navigator.serviceWorker.getRegistration().then(r => !!r?.active)`, 10000)) ? { detail: 'active' } : { ok: false, reason: 'no active service worker' });
  check('no uncaught page errors', page.errors.length === 0, 'none', page.errors.slice(0, 3).join(' | '));
}

async function dualScreenTests(chromeBin, base) {
  section('APP · DUAL-SCREEN SWAP (two emulated displays)');
  note('Displays emulated with --screen-info={1536x864}{2560x1440}; "manage windows" granted like the user would.');
  let c, A;
  try {
    ({ c, page: A } = await openApp(chromeBin, base, { screens: '{1536x864}{2560x1440}', grant: ['window-management'] }));
  } catch (e) { fail('launch Chrome with two displays', e.message); return; }
  pass('launch Chrome with two displays', c.version);
  await timed('app sees 2 screens', async () => {
    const n = await A.ev(`getScreenDetails().then(d => d.screens.map(s => s.width + 'x' + s.height))`);
    return n.length === 2 ? { detail: n.join(' + ') } : { ok: false, reason: JSON.stringify(n) };
  });
  await A.ev(`__jhk.loadSamples()`, 60000);
  const reads0 = await A.ev(`__jhk.state.diskReads.value`);
  let B = null;
  await timed('Start → W-B opens on 2nd screen; W-A = Layer 2, W-B = Layer 1', async () => {
    await A.ev(`__jhk.start()`, 20000);
    await sleep(500);
    let path2 = 'one click';
    if (await A.ev(`__jhk.state.needMonitorTap.value`)) { path2 = 'second tap (popup blocked by fullscreen click)'; await A.ev(`__jhk.openMonitorWindow()`); }
    let bt = null;
    for (let i = 0; i < 30 && !bt; i++) { bt = (await c.pageTargets()).find((t) => t.url.includes('w=B')); if (!bt) await sleep(200); }
    if (!bt) return { ok: false, reason: `W-B never opened (path: ${path2})` };
    B = await c.attach(bt);
    const okL = await A.until(`__jhk.state.mode.value === 'dual' && __jhk.state.layer.value === 'L2' && __jhk.state.loopStats.value?.fps > 0`, 15000)
      && await B.until(`__jhk.state.layer.value === 'L1'`, 5000);
    return okL ? { detail: `start path: ${path2}` } : { ok: false, reason: `A=${await A.ev('__jhk.state.layer.value')} B=${await B.ev('__jhk.state.layer.value')}` };
  });
  if (!B) return;
  const layers = async () => [await A.ev('__jhk.state.layer.value'), await B.ev('__jhk.state.layer.value')];
  await timed(`${SWAPS} swaps: layers flip every time, exactly one window on Layer 1`, async () => {
    const times = [], bad = [];
    const readsA = await A.ev('__jhk.state.diskReads.value'), readsB = await B.ev('__jhk.state.diskReads.value');
    for (let i = 0; i < SWAPS; i++) {
      const before = await layers();
      const n0 = (await A.ev('__jhk.state.swaps.value.length'));
      await A.ev('__jhk.swap()');
      const done = await A.until(`__jhk.state.swaps.value.length > ${n0}`, 4000, 50);
      await sleep(450);                                   // let the old window finish fading to Layer 2
      const after = await layers();
      if (!done) bad.push(`#${i + 1} no completion`);
      else times.push(await A.ev('__jhk.state.swaps.value.at(-1)'));
      if (after[0] === before[0] || after[1] === before[1] || after.filter((x) => x === 'L1').length !== 1) bad.push(`#${i + 1} ${before.join('/')}→${after.join('/')}`);
    }
    const s = [...times].sort((a, b) => a - b);
    const stat = s.length ? `median ${s[s.length >> 1]} ms · max ${s.at(-1)} ms · min ${s[0]} ms` : 'no swaps completed';
    const readsDelta = (await A.ev('__jhk.state.diskReads.value')) - readsA + (await B.ev('__jhk.state.diskReads.value')) - readsB;
    note(`swap times (ms): ${times.join(', ')}`);
    if (bad.length) return { ok: false, reason: `${bad.length} bad swaps: ${bad.slice(0, 5).join('; ')} · ${stat}` };
    if (s.at(-1) >= 1000) return { ok: false, reason: `slowest swap ${s.at(-1)} ms ≥ 1000 ms · ${stat}` };
    if (readsDelta !== 0) return { ok: false, reason: `${readsDelta} disk reads during swaps (must be 0)` };
    return { detail: `${times.length}/${SWAPS} ok · ${stat} · 0 disk reads` };
  });
  await timed('no leaked <video> elements or players after swaps', async () => {
    const n = (await A.ev(`document.querySelectorAll('video').length`)) + (await B.ev(`document.querySelectorAll('video').length`));
    return n === 2 ? { detail: '2 videos total (one ping-pong pair)' } : { ok: false, reason: `${n} videos across both windows` };
  });
  await timed('W-A JS heap stays small after swaps (< 60 MB)', async () => {
    const h = await A.ev(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1`);
    return h >= 0 && h < 60 ? { detail: `${h} MB used` } : { ok: false, reason: `${h} MB` };
  });
  await timed('monitor window lost → W-A falls back to single-screen from RAM (no disk read)', async () => {
    const r0 = await A.ev('__jhk.state.diskReads.value');
    await B.ev('window.close()').catch(() => {});
    const okF = await A.until(`__jhk.state.mode.value === 'single' && __jhk.state.layer.value === 'L1' && __jhk.state.loopStats.value?.fps > 0`, 10000);
    const r1 = await A.ev('__jhk.state.diskReads.value');
    if (!okF) return { ok: false, reason: `mode ${await A.ev('__jhk.state.mode.value')}, layer ${await A.ev('__jhk.state.layer.value')}` };
    return r1 === r0 ? { detail: 'single mode, Layer 1 playing on the laptop' } : { ok: false, reason: `${r1 - r0} disk read(s) during fallback` };
  });
  check('total disk reads in this session = 1 (only the initial wallpaper)', (await A.ev('__jhk.state.diskReads.value')) === reads0,
    `reads = ${reads0}`, `reads went from ${reads0} to ${await A.ev('__jhk.state.diskReads.value')}`);
  check('no uncaught page errors in either window', A.errors.length === 0 && B.errors.length === 0, 'none', [...A.errors, ...B.errors].slice(0, 3).join(' | '));
}
