#!/usr/bin/env node
// Jharokha: one command runs every check and writes ONE readable log: test-run-<timestamp>.log
//   npm test                 (from the repo root)
//   node tests/run-all.mjs [--no-browser] [--swaps=N]
// Exit code 0 = all checks passed (skips allowed), 1 = something failed.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome, chromeVersion, launch } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Test servers must never open real Chrome tabs on this laptop ("open on PC" uses garcon-url-handler).
process.env.JHK_OPENER = 'none';
const APP = path.join(ROOT, 'app');
const args = process.argv.slice(2);
const NO_BROWSER = args.includes('--no-browser');
const SWAPS = Number((args.find((a) => a.startsWith('--swaps=')) || '--swaps=30').slice(8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_NODE = [22, 13];
const YIELD_TEST_MS = 1500;
const ROOM_CODE = 'roomtest';   // fixed QR room code on test servers (JHK_ROOM_CODE)
const Yjs = () => createRequire(path.join(ROOT, 'server', 'package.json'))('yjs');
const yb64 = (u) => Buffer.from(u).toString('base64');
/** Click a Layer 2 tab by its label (control-centre layout). */
const TAB = (label) => `[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('${label}'))?.click()`;   // ?yield= shortens the 2-minute auto-yield for the Week 2 tests

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
/** Close the Chromes of earlier sections (the laptop can't hold a dozen headless Chromes at once). */
async function freeChromes() { for (const c of chromes.splice(0)) await c.close().catch(() => {}); }
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
  const SRV = path.join(ROOT, 'server');
  if (!fs.existsSync(path.join(SRV, 'node_modules'))) {
    note('server/node_modules missing → running `npm ci` in server/ (first run)');
    const r = await run('npm', ['ci', '--no-audit', '--no-fund'], SRV);
    check('install server dependencies (npm ci)', r.code === 0, 'installed', `npm ci exited ${r.code}`, r.ms, tail(r.out));
  }
  const spkg = JSON.parse(fs.readFileSync(path.join(SRV, 'package.json'), 'utf8'));
  for (const [name, want] of Object.entries(spkg.dependencies)) {
    const pj = path.join(SRV, 'node_modules', ...name.split('/'), 'package.json');
    const have = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).version : null;
    check(`server package ${name}`, have === want, `${have}`, have ? `${have} installed, wants ${want}: run npm run setup` : `not installed (wants ${want}); run: npm run setup`);
  }
  const sls = await run('npm', ['ls', '--depth=0'], SRV, 60000);
  check('server dependency tree consistent (npm ls)', sls.code === 0, 'no missing/invalid packages', 'npm ls reports problems', sls.ms, tail(sls.out, 15));
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

  // --only=appremote: build + just that section (quick iteration; the full run is still the gate).
  const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
  if (ONLY) {
    const b0 = await run('npm', ['run', 'build'], APP);
    check('npm run build', b0.code === 0, 'built', tail(b0.out, 30));
    if (ONLY === 'appremote' && chromeBin && b0.code === 0) await appRemoteTests(chromeBin);
    if (ONLY === 'week7') { await week7ServerTests(); if (chromeBin && b0.code === 0) await week7BrowserTests(chromeBin); }
    throw Object.assign(new Error('only'), { only: true });
  }
  // ----------------------------------------------------------------------------- 2. build
  section('BUILD (TypeScript typecheck + Vite production build + PWA service worker)');
  const b = await run('npm', ['run', 'build'], APP);
  const built = b.code === 0;
  check('npm run build exits 0 (tsc --noEmit && vite build)', built, 'no type errors, bundle built', `build failed with exit code ${b.code}`, b.ms, tail(b.out, 40));
  const warn = b.out.split('\n').filter((l) => /warn|error/i.test(l) && !/0 errors/i.test(l));
  check('build output has no warnings/errors', built && warn.length === 0, 'clean', warn.slice(0, 5).join(' | ') || 'build failed');
  const DIST = path.join(APP, 'dist');
  for (const f of ['index.html', 'room.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js', 'icon-192.png', 'icon-512.png']) {
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
    // Budget = what the always-on dashboard page loads at start (its script + modulepreloads). Lazy chunks (Yjs) and the phone page don't count.
    const idx = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const initial = [...idx.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    const js = initial.reduce((a, f) => a + fs.statSync(path.join(DIST, f)).size, 0);
    note(`dashboard initial JS: ${initial.map((f) => path.basename(f)).join(' + ')}; lazy/other: ${files.filter((f) => f.endsWith('.js') && !initial.includes('assets/' + f)).join(', ')}`);
    note(`bundle: ${files.join(', ')} · JS ${(js / 1024).toFixed(1)} KB (uncompressed)`);
    check('dashboard initial JS under 150 KB (always-on page budget)', js < 150 * 1024, `${(js / 1024).toFixed(1)} KB`, `${(js / 1024).toFixed(1)} KB`);
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
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
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
    await timed('Week 3 · /api/vitals: uptime, traffic, DB size, disk, memory', async () => {
      const v = await (await fetch(`${base}/api/vitals`)).json();
      const okV = v.ok && v.sqlite?.journal_mode === 'wal' && v.dbBytes > 0 && v.disk?.freeGB > 0 && v.mem?.availMB > 0 && typeof v.reqPerS === 'number';
      return okV ? { detail: `db ${v.dbBytes} B (wal), disk ${v.disk.freeGB}/${v.disk.totalGB} GB free, ${v.mem.availMB} MB RAM free, ${v.reqPerS} req/s` } : { ok: false, reason: JSON.stringify(v).slice(0, 300) };
    });
    await timed('Week 3 · /ws pushes vitals on connect and every 2 s, answers ping', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      const got = [];
      let pong = false;
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'vitals') got.push(m); if (m.t === 'pong') pong = true; };
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws error')); });
      ws.send(JSON.stringify({ t: 'ping', ts: 1 }));
      await sleep(2600);
      ws.close();
      const last = got.at(-1);
      return got.length >= 2 && pong && last.v.wsClients >= 1 && last.join?.url
        ? { detail: `${got.length} vitals messages in 2.6 s, pong ok, wsClients ${last.v.wsClients}, join ${last.join.url} (${last.join.source})` }
        : { ok: false, reason: `messages ${got.length}, pong ${pong}` };
    });
    await timed('Week 3 · QR: /api/qr.svg is a valid SVG for the join address', async () => {
      const r = await fetch(`${base}/api/qr.svg`);
      const t = await r.text();
      return r.ok && r.headers.get('content-type')?.startsWith('image/svg+xml') && /^<svg[^>]+viewBox="0 0 \d+ \d+"/.test(t) && t.includes('<path')
        ? { detail: `${t.length} bytes SVG` } : { ok: false, reason: `${r.status} ${r.headers.get('content-type')} ${t.slice(0, 80)}` };
    });
    await timed('Week 3 · Wi-Fi IP: owner sets it, QR follows, bad input → 400', async () => {
      const post = (body) => fetch(`${base}/api/lan-host`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const a = await post({ host: '192.168.1.23' });
      const aj = await a.json();
      const b = await (await fetch(`${base}/api/join`)).json();
      const bad = await post({ host: '999.1.1.1' });
      await post({ host: '' });
      // From 127.0.0.1 but addressed to a LAN host (what a forwarded phone would look like) → not trusted.
      const spoof = await new Promise((res) => {
        const rq = http.request({ host: '127.0.0.1', port, path: '/api/lan-host', method: 'POST', headers: { host: `192.168.1.50:${port}`, 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); });
        rq.end(JSON.stringify({ host: '1.2.3.4' }));
      });
      const okH = a.ok && aj.source === 'manual' && /^http:\/\/192\.168\.1\.23:\d+\/join\?k=\w+$/.test(b.url) && bad.status === 400 && spoof === 403;
      return okH ? { detail: `manual ${b.host} → QR ${b.url} · bad → 400 · 127.0.0.1 with a LAN Host → 403` } : { ok: false, reason: JSON.stringify({ aj, b, bad: bad.status, spoof }) };
    });
    await timed('path traversal is blocked', async () => {
      const codes = [];
      for (const p of ['/app/..%2f..%2fserver%2findex.mjs', '/samples/..%2fpackage.json', '/%2e%2e/server/index.mjs']) codes.push((await fetch(base + p)).status);
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
    for (const t of ['VIDEO ENGINE (real playback in Chrome)', 'APP · SINGLE-SCREEN (fallback when only one display)', 'APP · DUAL-SCREEN SWAP (two emulated displays)',
      'WEEK 2 · COEXIST + SCENES (single screen)', 'WEEK 2 · COEXIST (dual screen: auto-yield frees RAM in both windows)',
      'WEEK 3 · DASHBOARD: VITALS RING, SERVER PANEL, QR, OFFLINE BADGE', 'WEEK 4 · ACCESS: JOIN → APPROVE → ROLES (dashboard + phone page)',
      'WEEK 5 · LAYER 2 REDESIGN + ROOM PAGE (laptop, wall monitor, phone)', 'WEEK 6 · FUN LAYER ON SCREEN (cast, study room, scoreboard, ink theme)',
      'REFINEMENTS · OPEN FILES + PLAY LINKS ON THE LAPTOP', 'PHONE: CAST FROM PHONE, MEDIA REMOTE, APPS, PEOPLE (new phone UI)']) {
      section(t);
      skip('whole section', !chromeBin ? (NO_BROWSER ? '--no-browser given' : 'no Chrome found') : !up ? 'server did not start' : 'build failed');
    }
  } else {
    await engineTests(chromeBin, base);
    await singleScreenTests(chromeBin, base);
    await dualScreenTests(chromeBin, base);
    await week2SingleTests(chromeBin, base);
    await week2DualTests(chromeBin, base);
    await week3Tests(chromeBin);
  }
  await week4ServerTests();
  if (chromeBin && built) await week4BrowserTests(chromeBin);
  await week5ServerTests();
  await tunnelTests();
  await week6ServerTests();
  if (chromeBin && built) await week6BrowserTests(chromeBin);
  await sameWifiTests();
  if (chromeBin && built) await openOnLaptopTests(chromeBin);
  await secureChainTests();
  if (chromeBin && built) await phoneCastTests(chromeBin);
  if (chromeBin && built) await week5BrowserTests(chromeBin);
  if (chromeBin && built) await appRemoteTests(chromeBin);
  await week7ServerTests();
  if (chromeBin && built) await week7BrowserTests(chromeBin);
  exitCode = 0;
} catch (e) {
  if (e.only) { /* --only run finished */ } else {
  if (!cur) section('RUNNER');
  fail(`test runner crashed during "${cur.title}" (later sections did not run)`, e.message, null, e.stack);
  }
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
  await page.send('Page.navigate', { url: `${base}/app/?debug${opts.query || ''}` });
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
     let firstTry = null;
     for (let attempt = 1; ; attempt++) {
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
      // Software decode (no GPU in Crostini/CI) occasionally stutters under host load. Only a stutter gets one retry,
      // and the log keeps the first attempt so it stays visible.
      const onlyHitches = problems.length > 0 && problems.every((x) => /hitches|loop seam/.test(x));
      if (onlyHitches && attempt === 1) { firstTry = problems.join('; '); continue; }
      const retried = firstTry ? ` · RETRIED once (1st try: ${firstTry})` : '';
      return problems.length ? { ok: false, reason: problems.join('; ') + ' | ' + detail + retried } : { detail: detail + retried };
     }
    });
  }
  await timed('engine releases its <video> elements on dispose', async () => {
    const n = await page.ev(`document.querySelectorAll('.jhk-player').length`);
    return n === 0 ? { detail: '0 players left' } : { ok: false, reason: `${n} players left in the DOM` };
  });
  check('no uncaught page errors', page.errors.length === 0, 'none', page.errors.slice(0, 3).join(' | '));
}

async function singleScreenTests(chromeBin, base) {
  await freeChromes();
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
  await freeChromes();
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
  await timed('Layer 1 has a Swap button at the bottom; clicking it swaps the screens', async () => {
    const [a0] = await layers();
    const L1 = a0 === 'L1' ? A : B;
    const btn = await L1.ev(`(() => { const b = document.querySelector('.l1-swap'); if (!b) return null; const r = b.getBoundingClientRect(); return { y: r.bottom, h: innerHeight, cx: r.left + r.width / 2, w: innerWidth, t: b.textContent }; })()`);
    const n0 = await A.ev('__jhk.state.swaps.value.length');
    await L1.ev(`document.querySelector('.l1-swap').click()`);
    const done = await A.until(`__jhk.state.swaps.value.length > ${n0}`, 4000, 50);
    await sleep(450);
    const after = await layers();
    const ok = btn && btn.h - btn.y < 60 && Math.abs(btn.cx - btn.w / 2) < 4 && done && after[0] !== a0;
    return ok ? { detail: `"${btn.t}" bottom-centre → swapped (${a0}→${after[0]} on W-A)` } : { ok: false, reason: JSON.stringify({ btn, done, after }) };
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

// =============================================================================== Week 2

async function week2SingleTests(chromeBin, base) {
  await freeChromes();
  section('WEEK 2 · COEXIST + SCENES (single screen)');
  note(`Auto-yield delay shortened to ${YIELD_TEST_MS} ms with ?yield= (2 min in real use). document.hidden can't be forced in headless,`);
  note('so "covered" is simulated with a debug hook that goes through the same code path as visibilitychange.');
  const { page, ok } = await openApp(chromeBin, base, { query: `&yield=${YIELD_TEST_MS}` });
  check('app boots', ok, '', 'app did not boot', null, page.errors.join('\n'));
  if (!ok) return;
  await page.ev(`__jhk.loadSamples()`, 60000);
  await page.ev(`__jhk.start()`, 20000);
  const playing = `__jhk.state.layer.value === 'L1' && __jhk.state.loopStats.value?.fps > 0 && !__jhk.state.loopStats.value?.paused`;
  check('Start → Layer 1 playing', await page.until(playing, 15000), '', 'not playing');
  const S = (e) => page.ev(e);
  const snap = () => S(`({ reads: __jhk.state.diskReads.value, mb: __jhk.state.blobMB.value, players: __jhk.playerCount(), y: __jhk.state.yielded.value,
    paused: __jhk.state.loopStats.value?.paused, t: __jhk.state.loopStats.value?.mediaTime })`);

  await timed('covered briefly (< yield delay) → pause, then resume with no disk read', async () => {
    const a = await snap();
    await S(`__jhk.fakeHidden(true)`); await sleep(400);
    const p = await S(`document.querySelector('.jhk-player video:not([hidden])')?.paused ?? true`);
    await S(`__jhk.fakeHidden(false)`);
    const back = await page.until(playing, 5000);
    const b = await snap();
    return p && back && b.reads === a.reads && !b.y ? { detail: `paused while covered, resumed, reads ${a.reads}→${b.reads}` }
      : { ok: false, reason: JSON.stringify({ pausedWhileHidden: p, back, a, b }) };
  });
  await timed('covered > yield delay → player and RAM Blob released; uncovered → one re-read, plays on', async () => {
    const a = await snap();
    await S(`__jhk.fakeHidden(true)`);
    const rel = await page.until(`__jhk.state.yielded.value && __jhk.playerCount() === 0 && __jhk.state.blobMB.value === 0`, YIELD_TEST_MS + 4000);
    const mid = await snap();
    await S(`__jhk.fakeHidden(false)`);
    const back = await page.until(playing, 8000);
    const b = await snap();
    if (!rel) return { ok: false, reason: `not released: ${JSON.stringify(mid)}` };
    if (!back) return { ok: false, reason: `did not come back: ${JSON.stringify(b)}` };
    return b.reads === a.reads + 1 ? { detail: `released ${a.mb} MB + decoder; back with 1 disk read (${a.reads}→${b.reads}), resumed near t=${b.t}s` }
      : { ok: false, reason: `reads ${a.reads}→${b.reads}` };
  });
  await timed('🎬 Cinema: wallpaper paused, slim strip shown, toasts off; exit resumes', async () => {
    await S(`__jhk.toggleCinema()`); await sleep(400);
    const r = await S(`({ c: __jhk.state.cinema.value, strip: !!document.querySelector('.cinema-strip'), paused: __jhk.state.loopStats.value?.paused,
      big: !!document.querySelector('.cc-head') })`);
    await S(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))`);
    const toastBefore = await S(`!!document.querySelector('.toast')`);
    await S(`__jhk.swap()`);   // swap is ignored in cinema
    await S(`__jhk.toggleCinema()`);
    const back = await page.until(playing, 8000);
    const ok2 = r.c && r.strip && r.paused !== false && !r.big && back;
    return ok2 ? { detail: `strip on, dashboard hidden, video paused${toastBefore ? '' : ', no toasts'}; resumed after exit` } : { ok: false, reason: JSON.stringify({ ...r, back }) };
  });
  await timed('🎬 Cinema > yield delay also releases the clip (decoder free for Netflix)', async () => {
    await S(`__jhk.toggleCinema()`);
    const rel = await page.until(`__jhk.state.yielded.value && __jhk.playerCount() === 0`, YIELD_TEST_MS + 4000);
    await S(`__jhk.toggleCinema()`);
    const back = await page.until(playing, 8000);
    return rel && back ? { detail: 'released while in Cinema, plays again after' } : { ok: false, reason: JSON.stringify({ rel, back }) };
  });
  await timed('🌙 Night Watch: black screen, deep-red Fraunces clock with date + minute bar', async () => {
    await S(`__jhk.toggleNightWatch()`); await sleep(600);
    const r = await S(`(async () => { await document.fonts.ready; const n = document.querySelector('.night'); const t = n?.querySelector('.nw-time');
      return { on: !!n, bg: n && getComputedStyle(n).backgroundColor, color: t && getComputedStyle(t).color, font: t && getComputedStyle(t).fontFamily,
        fontLoaded: document.fonts.check('200 40px Fraunces'), size: t && parseFloat(getComputedStyle(t).fontSize), text: t?.textContent,
        date: n?.querySelector('.nw-date')?.textContent, bar: !!n?.querySelector('.nw-bar span'), cursor: n && getComputedStyle(n).cursor }; })()`);
    const [R, G, B] = (r.color || '').match(/\d+/g)?.map(Number) || [];
    const ok = r.on && r.bg === 'rgb(0, 0, 0)' && R > 2 * G && R > 2 * B && R < 150 && /Fraunces/.test(r.font) && r.fontLoaded && r.size >= 120 && /\d:\d\d/.test(r.text) && r.date && r.bar && r.cursor === 'none';
    if (ok) await page.send('Page.captureScreenshot', { format: 'png' }).then((x) => { if (x.result?.data) { fs.writeFileSync(path.join(ROOT, 'test-shot-night.png'), Buffer.from(x.result.data, 'base64')); note('screenshot: test-shot-night.png'); } });
    return ok ? { detail: `clock ${r.color} ${Math.round(r.size)}px Fraunces (loaded) "${r.text}" · ${r.date} · cursor hidden while idle` } : { ok: false, reason: JSON.stringify(r) };
  });
  await timed('🌙 Night Watch: moving the mouse shows the cursor + wake hint; any key wakes', async () => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 300 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 310 });
    await sleep(500);
    const r = await S(`({ cls: document.querySelector('.night')?.className, cursor: getComputedStyle(document.querySelector('.night')).cursor, hint: getComputedStyle(document.querySelector('.nw-hint')).opacity })`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', text: 'x' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX' });
    const back = await page.until(playing + ` && !document.querySelector('.night') && !__jhk.state.cinema.value`, 8000);
    return /awake/.test(r.cls) && r.cursor === 'pointer' && Number(r.hint) > 0.5 && back ? { detail: `cursor "${r.cursor}", hint shown; a key woke it and the wallpaper resumed` } : { ok: false, reason: JSON.stringify({ ...r, back }) };
  });
  await timed('🌙 Night Watch: a single tap anywhere wakes it', async () => {
    await S(`__jhk.toggleNightWatch()`); await sleep(400);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 200, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 200, button: 'left', clickCount: 1 });
    const back = await page.until(playing + ` && !document.querySelector('.night')`, 8000);
    return back ? { detail: 'one tap → awake, wallpaper playing' } : { ok: false, reason: 'still in Night Watch' };
  });
  await timed('Cinema and Night Watch are exclusive', async () => {
    await S(`__jhk.toggleCinema()`); await S(`__jhk.toggleNightWatch()`);
    const r = await S(`[__jhk.state.cinema.value, __jhk.state.nightWatch.value]`);
    await S(`__jhk.setFx({ cinema: false, night: false })`);
    await page.until(playing, 8000);
    return !r[0] && r[1] ? { detail: 'Night replaced Cinema' } : { ok: false, reason: JSON.stringify(r) };
  });

  // ---- scenes: build a schedule around "now" in the page's local time
  const lib = await S(`__jhk.state.library.value.map(w => w.id)`);
  const cur0 = await S(`__jhk.state.currentId.value`);
  const other = lib.find((x) => x !== cur0);
  const hhmm = (offMin) => `(() => { const d = new Date(Date.now() + ${offMin} * 60000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); })()`;
  await timed('scheduler: turning Auto on switches to the current scene\'s wallpaper', async () => {
    await S(`__jhk.setScene('dawn', { start: ${hhmm(-120)}, wallpaperId: null })`);
    await S(`__jhk.setScene('work', { start: ${hhmm(-60)}, wallpaperId: '${cur0}' })`);
    await S(`__jhk.setScene('ambient', { start: ${hhmm(2)}, wallpaperId: '${other}' })`);
    await S(`__jhk.setScene('night', { start: ${hhmm(120)}, wallpaperId: null })`);
    const r0 = await S(`__jhk.state.diskReads.value`);
    await S(`__jhk.setAutoScenes(true)`);
    await sleep(500);
    const r = await S(`({ scene: __jhk.state.activeScene.value, cur: __jhk.state.currentId.value, reads: __jhk.state.diskReads.value })`);
    return r.scene === 'work' && r.cur === cur0 ? { detail: `scene "work" active, wallpaper unchanged (already right), reads ${r0}→${r.reads}` } : { ok: false, reason: JSON.stringify(r) };
  });
  await timed('scheduler: next scene\'s clip is prefetched into RAM < 3 min before it starts', async () => {
    const r0 = await S(`__jhk.state.diskReads.value`);
    await S(`__jhk.schedulerTick()`);
    const got = await page.until(`__jhk.hasPrefetch() === '${other}' && __jhk.state.nextChange.value?.prefetched`, 5000);
    const r = await S(`({ next: __jhk.state.nextChange.value, reads: __jhk.state.diskReads.value })`);
    return got && r.reads === r0 + 1 ? { detail: `"${r.next.label}" in ${Math.round(r.next.inMs / 1000)} s, clip read early (reads ${r0}→${r.reads})` } : { ok: false, reason: JSON.stringify({ got, ...r, r0 }) };
  });
  await timed('scheduler: at the boundary it switches using the prefetched clip (0 disk reads)', async () => {
    const r0 = await S(`__jhk.state.diskReads.value`);
    await S(`__jhk.setScene('ambient', { start: ${hhmm(0)} })`);   // boundary = now
    const sw = await page.until(`__jhk.state.currentId.value === '${other}' && __jhk.state.activeScene.value === 'ambient'`, 5000);
    await sleep(1500);                                         // crossfade 600 ms, then the old player is disposed
    await page.until(`__jhk.state.loopStats.value?.fps > 0 && __jhk.state.loopStats.value?.mediaTime > 0.5`, 5000);
    const r = await S(`({ reads: __jhk.state.diskReads.value, players: __jhk.playerCount(), fps: __jhk.state.loopStats.value?.fps, pre: __jhk.hasPrefetch() })`);
    return sw && r.reads === r0 && r.players === 1 && r.fps > 0 ? { detail: `switched to the Ambient wallpaper, reads ${r0}→${r.reads}, crossfaded (1 player left)` }
      : { ok: false, reason: JSON.stringify({ sw, r0, ...r }) };
  });
  await timed('schedule survives a reload (batched IndexedDB settings)', async () => {
    await S(`__jhk.flushSettings()`);
    await page.send('Page.reload');
    await sleep(500);
    const okR = await page.until(`!!window.__jhk && __jhk.state.autoScenes.value && __jhk.state.activeScene.value === 'ambient' && __jhk.state.currentId.value === '${other}'`, 15000);
    const reads = await S(`__jhk.state.diskReads.value`).catch(() => -1);
    return okR && reads === 1 ? { detail: 'auto on, Ambient wallpaper chosen at boot with 1 disk read' } : { ok: false, reason: `reads ${reads}, ok ${okR}` };
  });
  check('no uncaught page errors', page.errors.length === 0, 'none', page.errors.slice(0, 3).join(' | '));
}

async function week2DualTests(chromeBin, base) {
  await freeChromes();
  section('WEEK 2 · COEXIST (dual screen: auto-yield frees RAM in both windows)');
  let c, A;
  try {
    ({ c, page: A } = await openApp(chromeBin, base, { screens: '{1536x864}{2560x1440}', grant: ['window-management'], query: `&yield=${YIELD_TEST_MS}` }));
  } catch (e) { fail('launch Chrome with two displays', e.message); return; }
  await A.ev(`__jhk.loadSamples()`, 60000);
  await A.ev(`__jhk.start()`, 20000);
  await sleep(500);
  if (await A.ev(`__jhk.state.needMonitorTap.value`)) await A.ev(`__jhk.openMonitorWindow()`);
  let bt = null;
  for (let i = 0; i < 30 && !bt; i++) { bt = (await c.pageTargets()).find((t) => t.url.includes('w=B')); if (!bt) await sleep(200); }
  if (!bt) { fail('W-B opens', 'never opened'); return; }
  const B = await c.attach(bt);
  const bPlaying = `__jhk.state.layer.value === 'L1' && __jhk.state.loopStats.value?.fps > 0 && !__jhk.state.loopStats.value?.paused`;
  check('dual-screen running (W-B on Layer 1)', await B.until(bPlaying, 15000), '', 'W-B not playing');
  await timed('🎬 Cinema from W-A reaches W-B: both paused, then both drop the Blob', async () => {
    await A.ev(`__jhk.toggleCinema()`);
    const mirrored = await B.until(`__jhk.state.cinema.value`, 3000);
    const rel = await B.until(`__jhk.state.yielded.value && __jhk.playerCount() === 0 && __jhk.state.blobMB.value === 0`, YIELD_TEST_MS + 4000)
      && await A.until(`__jhk.state.blobMB.value === 0`, 3000);
    const strip = await A.ev(`!!document.querySelector('.cinema-strip')`);
    return mirrored && rel && strip ? { detail: 'W-B mirrored Cinema, strip on W-A, 0 MB held in either window' }
      : { ok: false, reason: JSON.stringify({ mirrored, rel, strip, aMB: await A.ev('__jhk.state.blobMB.value'), bMB: await B.ev('__jhk.state.blobMB.value') }) };
  });
  await timed('exit Cinema → W-B asks W-A for the clip: one disk read, W-B plays again', async () => {
    const r0 = await A.ev(`__jhk.state.diskReads.value`);
    await A.ev(`__jhk.toggleCinema()`);
    const back = await B.until(bPlaying, 10000);
    const r1 = await A.ev(`__jhk.state.diskReads.value`);
    const layers = [await A.ev('__jhk.state.layer.value'), await B.ev('__jhk.state.layer.value')];
    return back && r1 === r0 + 1 && layers.join() === 'L2,L1' ? { detail: `reads ${r0}→${r1}, layers ${layers.join('/')}` } : { ok: false, reason: JSON.stringify({ back, r0, r1, layers }) };
  });
  await timed('swap still works after a yield cycle (0 disk reads)', async () => {
    const r0 = await A.ev(`__jhk.state.diskReads.value`);
    const n0 = await A.ev(`__jhk.state.swaps.value.length`);
    await A.ev(`__jhk.swap()`);
    const done = await A.until(`__jhk.state.swaps.value.length > ${n0}`, 4000, 50);
    await sleep(600);
    const layers = [await A.ev('__jhk.state.layer.value'), await B.ev('__jhk.state.layer.value')];
    const r1 = await A.ev(`__jhk.state.diskReads.value`);
    return done && layers.join() === 'L1,L2' && r1 === r0 ? { detail: `swapped in ${await A.ev('__jhk.state.swaps.value.at(-1)')} ms` } : { ok: false, reason: JSON.stringify({ done, layers, r0, r1 }) };
  });
  await timed('🌙 Night Watch from W-B shows on both screens', async () => {
    await B.ev(`__jhk.toggleNightWatch()`);
    const both = await A.until(`!!document.querySelector('.night')`, 3000) && await B.until(`!!document.querySelector('.night')`, 3000);
    await B.ev(`__jhk.toggleNightWatch()`);
    const off = await A.until(`!document.querySelector('.night') && __jhk.state.loopStats.value?.fps > 0`, 8000);
    return both && off ? { detail: 'on both, off on both, wallpaper back' } : { ok: false, reason: JSON.stringify({ both, off }) };
  });
  check('no uncaught page errors in either window', A.errors.length === 0 && B.errors.length === 0, 'none', [...A.errors, ...B.errors].slice(0, 3).join(' | '));
}

// =============================================================================== Week 3
async function week3Tests(chromeBin) {
  await freeChromes();
  section('WEEK 3 · DASHBOARD: VITALS RING, SERVER PANEL, QR, OFFLINE BADGE');
  note('Uses its own server so it can be stopped and restarted mid-test (the "Server offline" badge).');
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-w3-'));
  const startSrv = () => spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', JHK_DATA: dataDir }, stdio: 'ignore',
  });
  const waitUp = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/ping`)).ok) return true; } catch { /* */ } await sleep(100); } return false; };
  let srv = startSrv();
  try {
    if (!(await waitUp())) { fail('second server starts', 'no answer'); return; }
    const { page, ok } = await openApp(chromeBin, base);
    check('app boots', ok, '', 'app did not boot', null, page.errors.join('\n'));
    if (!ok) return;
    await page.ev(`__jhk.loadSamples()`, 60000);
    await page.ev(`__jhk.start()`, 20000);
    await page.until(`__jhk.state.layer.value === 'L1'`, 10000);
    await page.ev(`__jhk.swap()`);           // single mode: dashboard over the video
    await sleep(500);
    await timed('Vitals Ring: 4 arcs (Power, CPU, Network, Server) with a reason each', async () => {
      const okR = await page.until(`document.querySelectorAll('.ring .arc').length === 4 && document.querySelector('.ring-legend .lv-good .ring-label')`, 8000);
      const r = await page.ev(`[...document.querySelectorAll('.ring-legend li')].map(li => li.querySelector('.ring-label').textContent + '=' + li.className + ':' + li.querySelector('.ring-reason').textContent)`);
      const server = r.find((x) => x.startsWith('Server='));
      return okR && r.length === 5 && server?.includes('lv-good') ? { detail: r.join(' | ') } : { ok: false, reason: JSON.stringify(r) };
    });
    await timed('server panel shows live vitals and a scannable QR image', async () => {
      await page.ev(TAB('System')); await sleep(300);
      const okP = await page.until(`/active/.test(document.querySelector('.server-card')?.textContent || '') && document.querySelector('.server-card .good')`, 8000);
      const q = await page.ev(`(async () => { const img = document.querySelector('.server-card img.qr'); if (!img) return null; await img.decode().catch(() => {});
        return { w: img.naturalWidth, h: img.naturalHeight, src: img.src, host: document.querySelector('.qr-url')?.textContent }; })()`);
      return okP && q && q.w > 0 && q.src.includes('/api/qr.svg') ? { detail: `QR ${q.w}×${q.h} for ${q.host}` } : { ok: false, reason: JSON.stringify({ okP, q }) };
    });
    await timed('Set Wi-Fi IP from the panel → QR address updates', async () => {
      await page.ev(`document.querySelector('.server-card .small-btn').click()`);
      await sleep(200);
      await page.ev(`(() => { const i = document.querySelector('.ip-form input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(i, '192.168.4.20'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(150);                                        // let Preact re-render with the typed value
      await page.ev(`document.querySelector('.ip-form button').click()`);
      const okI = await page.until(`document.querySelector('.qr-url')?.textContent === '192.168.4.20:${port}'`, 5000);
      return okI ? { detail: `QR now points at 192.168.4.20:${port}` } : { ok: false, reason: await page.ev(`document.querySelector('.qr-url')?.textContent`) };
    });
    // Screenshots for a human (and Claude) to look at: laptop-sized viewport, top of the dashboard and the server panel.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    for (const [name, tab, sel] of [['top', 'Home', '.cc-head'], ['server', 'System', '.server-card']]) {
      await page.ev(TAB(tab)); await sleep(300);
      await page.ev(`document.querySelector('${sel}')?.scrollIntoView({ block: 'start' })`);
      await sleep(300);
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      if (r.result?.data) { const f = path.join(ROOT, `test-shot-week3-${name}.png`); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); note(`screenshot: ${path.basename(f)}`); }
    }
    await timed('server stops → "Server offline" badge + red Server arc; video keeps playing', async () => {
      srv.kill(); await new Promise((r) => srv.once('exit', r));
      await page.ev(TAB('Home')); await sleep(200);
      const okO = await page.until(`!!document.querySelector('.offline-badge') && document.querySelector('.ring .arc.lv-bad')`, 12000);
      const playing = await page.ev(`__jhk.state.loopStats.value?.fps > 0 && !__jhk.state.loopStats.value?.paused`);
      return okO && playing ? { detail: 'badge shown, wallpaper unaffected' } : { ok: false, reason: JSON.stringify({ okO, playing }) };
    });
    await timed('server back → badge clears by itself (auto-reconnect)', async () => {
      srv = startSrv();
      await waitUp();
      const gone = await page.until(`!document.querySelector('.offline-badge')`, 20000);
      await page.ev(TAB('System')); await sleep(200);
      const okB = gone && await page.until(`/live/.test(document.querySelector('.server-card')?.textContent || '')`, 5000);
      return okB ? { detail: 'reconnected, badge gone' } : { ok: false, reason: 'still offline after 20 s' };
    });
    check('no uncaught page errors', page.errors.length === 0, 'none', page.errors.slice(0, 3).join(' | '));
  } finally { srv.kill(); }
}

// =============================================================================== Week 4
// The server trusts only 127.0.0.1 (inside Linux). Talking to it on the container's own network address makes the
// test look like a phone (a different source IP), so the real access rules apply.
function outsideIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}
async function startW4Server(extraEnv = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-w4-'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', JHK_DATA: dataDir, JHK_TRUSTED_IPS: '127.0.0.1,::ffff:127.0.0.1', JHK_ROOM_CODE: ROOM_CODE, JHK_NETGUARD_LOOKUP: '0', ...extraEnv }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break; } catch { /* */ } await sleep(100); }
  return { port, proc, owner: `http://127.0.0.1:${port}` };
}

/** A tiny cookie-keeping client that looks like one phone. */
function phone(base) {
  let cookie = '';
  const req = async (p, body, method) => {
    if (p === '/api/join' && body && !('k' in body)) body = { ...body, k: ROOM_CODE };
    const r = await fetch(base + p, {
      method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/150 Mobile' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /jhk_dev=([^;]*)/.exec(sc); cookie = m && m[1] ? `jhk_dev=${m[1]}` : ''; }
    let j = null; try { j = await r.clone().json(); } catch { /* html */ }
    return { status: r.status, j, setCookie: sc, text: j ? null : await r.text() };
  };
  const ws = () => new Promise((res) => {
    const w = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: cookie ? { cookie } : {} });
    const msgs = [];
    w.onmessage = (e) => msgs.push(JSON.parse(e.data));
    w.onclose = (e) => res({ closed: true, code: e.code, msgs });
    setTimeout(() => res({ closed: false, msgs, w }), 1200);
  });
  return { req, ws, get cookie() { return cookie; } };
}

async function week4ServerTests() {
  section('WEEK 4 · ACCESS SERVER: join, approve, roles, kill switch, quiet hours, audit, limits');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address to act as a phone from'); return; }
  note(`Phones are simulated by connecting to ${ip} (a non-trusted source address); the owner is 127.0.0.1 (inside Linux).`);
  const { inWindow, makeLimiter, parseCookies, shortUa } = await import(pathToFileURL(path.join(ROOT, 'server', 'access.mjs')).href);
  await timed('access helpers: quiet-hours window (wraps midnight), rate limiter, cookies, device names', async () => {
    const d = (h, m) => new Date(2026, 10, 18, h, m);
    const w = [inWindow(d(1, 0), '00:30', '07:00'), !inWindow(d(8, 0), '00:30', '07:00'), inWindow(d(23, 30), '23:00', '06:00'), inWindow(d(3, 0), '23:00', '06:00'), !inWindow(d(12, 0), '23:00', '06:00'), !inWindow(d(1, 0), '05:00', '05:00')];
    const lim = makeLimiter(3); const got = [1, 2, 3, 4].map(() => lim('k', 1000)); const later = lim('k', 1000 + 20000);
    const c = parseCookies('a=1; jhk_dev=abc%3D; b=2');
    const ok = w.every(Boolean) && got.join() === 'true,true,true,false' && later === true && c.jhk_dev === 'abc=' && shortUa('Mozilla/5.0 (Linux; Android 14) Chrome/150 Mobile') === 'Chrome · Android';
    return ok ? { detail: 'window ✓ · limiter 3/min → 4th refused, refills ✓ · cookie ✓ · UA ✓' } : { ok: false, reason: JSON.stringify({ w, got, later, c }) };
  });
  const S = await startW4Server();
  const P = `http://${ip}:${S.port}`;
  const own = (p, body) => fetch(S.owner + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
  try {
    const ph = phone(P);
    await timed('stranger: no vitals, no owner APIs, /ws refused (4401), owner-only actions 403', async () => {
      const me = await ph.req('/api/me');
      const v = await ph.req('/api/vitals');
      const acc = await ph.req('/api/access');
      const kill = await ph.req('/api/kill', { on: true });
      const lan = await ph.req('/api/lan-host', { host: '1.2.3.4' });
      const pn = await ph.req('/api/pair/new', {});
      const w = await ph.ws();
      const ok = me.j.status === 'none' && !me.j.owner && v.status === 403 && acc.status === 403 && kill.status === 403 && lan.status === 403 && pn.status === 403 && w.closed && w.code === 4401;
      return ok ? { detail: 'me=none · vitals/access/kill/lan-host/pair-new → 403 · ws closed 4401' } : { ok: false, reason: JSON.stringify({ me: me.j, v: v.status, acc: acc.status, kill: kill.status, lan: lan.status, pn: pn.status, w: [w.closed, w.code] }) };
    });
    await timed('/join page loads for a phone; QR now points at /join', async () => {
      const r = await ph.req('/join');
      const j = await own('/api/join');
      return r.status === 200 && /Ask to join/.test(r.text) && j.j.url.endsWith(`/join?k=${ROOM_CODE}`) ? { detail: `200 · QR → ${j.j.url}` } : { ok: false, reason: `${r.status} ${j.j?.url}` };
    });
    let id;
    await timed('phone asks to join → pending, HttpOnly SameSite=Strict 30-day cookie; owner sees it', async () => {
      const empty = await ph.req('/api/join', { name: '   ' });
      const r = await ph.req('/api/join', { name: 'Rahul <b>' });
      const again = await ph.req('/api/join', { name: 'Rahul' });
      const me = await ph.req('/api/me');
      const a = await own('/api/access');
      const d = a.j.devices.find((x) => x.status === 'pending');
      id = d?.id;
      const c = r.setCookie || '';
      const ok = empty.status === 400 && r.status === 200 && /HttpOnly/.test(c) && /SameSite=Strict/.test(c) && /Max-Age=2592000/.test(c) && again.status === 409
        && me.j.status === 'pending' && d?.name === 'Rahul b' && d.ua === 'Chrome · Android' && a.j.pending === 1;
      return ok ? { detail: `empty name → 400 · cookie "${c.replace(/jhk_dev=[^;]+/, 'jhk_dev=…')}" · 2nd ask → 409 · owner sees "${d.name}" (${d.ua}); "<>" stripped` } : { ok: false, reason: JSON.stringify({ empty: empty.status, r: r.status, c, again: again.status, me: me.j, d }) };
    });
    await timed('owner approves as collaborator → phone gets vitals and a live /ws', async () => {
      const bad = await own(`/api/devices/${id}/approve`, { role: 'admin' });
      const r = await own(`/api/devices/${id}/approve`, { role: 'collaborator' });
      const me = await ph.req('/api/me');
      const v = await ph.req('/api/vitals');
      const w = await ph.ws();
      const ok = bad.status === 400 && r.status === 200 && me.j.status === 'approved' && me.j.effectiveRole === 'collaborator' && v.status === 200 && !w.closed && w.msgs.some((m) => m.t === 'vitals') && !w.msgs.some((m) => m.t === 'access');
      w.w?.close();
      return ok ? { detail: 'bad role → 400 · approved · vitals 200 · ws live (vitals, no owner tray)' } : { ok: false, reason: JSON.stringify({ bad: bad.status, r: r.status, me: me.j, v: v.status, closed: w.closed, types: w.msgs.map((m) => m.t) }) };
    });
    await timed('quiet hours covering now → collaborator becomes read-only (viewer); off → back', async () => {
      const t = new Date(); const hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const bad = await own('/api/quiet', { start: '7pm' });
      await own('/api/quiet', { enabled: true, start: hh(new Date(t - 3600000)), end: hh(new Date(+t + 3600000)) });
      const q = await ph.req('/api/me');
      await own('/api/quiet', { enabled: false });
      const back = await ph.req('/api/me');
      return bad.status === 400 && q.j.quiet && q.j.effectiveRole === 'viewer' && back.j.effectiveRole === 'collaborator'
        ? { detail: 'bad time → 400 · quiet: viewer · after: collaborator' } : { ok: false, reason: JSON.stringify({ bad: bad.status, q: q.j, back: back.j }) };
    });
    await timed('kill switch: phone blocked (403, HTML page), its /ws dropped; owner unaffected; off → back', async () => {
      const w = await ph.ws();
      await own('/api/kill', { on: true });
      await sleep(300);
      const dropped = w.w ? w.w.readyState >= 2 : w.closed;
      const r = await fetch(`${P}/join`, { headers: { cookie: ph.cookie, accept: 'text/html' } });
      const html = await r.text();
      const j2 = await ph.req('/api/join', { name: 'X' });
      const o = await own('/api/vitals');
      await own('/api/kill', { on: false });
      const after = await ph.req('/api/vitals');
      const ok = dropped && r.status === 403 && /owner-only mode/.test(html) && j2.status === 403 && o.status === 200 && after.status === 200;
      return ok ? { detail: 'ws dropped · /join → 403 page · join → 403 · owner vitals 200 · after: phone 200' } : { ok: false, reason: JSON.stringify({ dropped, r: r.status, j2: j2.status, o: o.status, after: after.status }) };
    });
    await timed('owner removes the phone → its cookie stops working, /ws closed', async () => {
      const w = await ph.ws();
      await own(`/api/devices/${id}/revoke`, {});
      await sleep(300);
      const closed = w.w ? w.w.readyState >= 2 : w.closed;
      const me = await ph.req('/api/me');
      const v = await ph.req('/api/vitals');
      return closed && me.j.status === 'none' && v.status === 403 ? { detail: 'revoked · me=none · vitals 403 · ws closed' } : { ok: false, reason: JSON.stringify({ closed, me: me.j, v: v.status }) };
    });
    await timed('deny: a second phone is refused and can ask again later', async () => {
      const p2 = phone(P);
      await p2.req('/api/join', { name: 'Stranger' });
      const d = (await own('/api/access')).j.devices.find((x) => x.name === 'Stranger');
      await own(`/api/devices/${d.id}/deny`, {});
      const me = await p2.req('/api/me');
      return me.j.status === 'none' ? { detail: 'denied → me=none (the page offers "Ask again")' } : { ok: false, reason: JSON.stringify(me.j) };
    });
    await timed('pairing: one-time code from inside Linux makes a browser an owner; reuse and guesses fail', async () => {
      const lap = phone(P);
      const wrong = await lap.req('/api/pair', { code: 'deadbeef00' });
      const { j } = await own('/api/pair/new', {});
      const ok1 = await lap.req('/api/pair', { code: j.code, name: 'Laptop' });
      const me = await lap.req('/api/me');
      const reuse = await phone(P).req('/api/pair', { code: j.code });
      const acc = await lap.req('/api/access');
      const ok = wrong.status === 403 && ok1.status === 200 && me.j.owner && me.j.role === 'owner' && reuse.status === 403 && acc.status === 200 && j.url.includes('/app/?pair=');
      return ok ? { detail: 'wrong → 403 · code → owner · reuse → 403 · owner APIs open' } : { ok: false, reason: JSON.stringify({ wrong: wrong.status, ok1: ok1.status, me: me.j, reuse: reuse.status, acc: acc.status }) };
    });
    await timed('audit log records every decision', async () => {
      const a = (await own('/api/access')).j.audit.map((x) => x.action);
      const want = ['join-request', 'approve', 'quiet-hours', 'kill-switch ON', 'kill-switch off', 'revoke', 'deny', 'pair-code', 'paired as owner'];
      const miss = want.filter((w) => !a.includes(w));
      return miss.length ? { ok: false, reason: `missing: ${miss.join(', ')} · have ${a.join(', ')}` } : { detail: `${a.length} entries: ${[...new Set(a)].join(', ')}` };
    });
  } finally { S.proc.kill(); }

  // limits need their own server (fresh counters)
  const L = await startW4Server({ JHK_RATE_PER_MIN: '30', JHK_JOIN_PER_MIN: '100' });
  try {
    const PL = `http://${ip}:${L.port}`;
    await timed(`max ${20} devices: the 21st join is refused (429)`, async () => {
      const codes = [];
      for (let i = 0; i < 21; i++) codes.push((await phone(PL).req('/api/join', { name: `p${i}` })).status);
      return codes.slice(0, 20).every((c) => c === 200) && codes[20] === 429 ? { detail: '20 × 200, then 429 "room is full"' } : { ok: false, reason: codes.join(',') };
    });
    await timed('per-device rate limit: a burst from one phone gets 429s; the owner never does', async () => {
      const ph = phone(PL);
      const codes = [];
      for (let i = 0; i < 40; i++) codes.push((await ph.req('/ping')).status);
      const ownerCodes = [];
      for (let i = 0; i < 40; i++) ownerCodes.push((await fetch(`${L.owner}/ping`)).status);
      const n429 = codes.filter((c) => c === 429).length;
      return n429 > 0 && ownerCodes.every((c) => c === 200) ? { detail: `phone: ${40 - n429} ok then ${n429} × 429 · owner 40/40 ok` } : { ok: false, reason: `phone 429s ${n429}, owner ${ownerCodes.filter((c) => c !== 200).length} non-200` };
    });
  } finally { L.proc.kill(); }
}

async function week4BrowserTests(chromeBin) {
  await freeChromes();
  section('WEEK 4 · ACCESS: JOIN → APPROVE → ROLES (dashboard + phone page)');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const S = await startW4Server();
  const P = `http://${ip}:${S.port}`;
  try {
    // Dashboard opened on the container's address = an unpaired screen (not trusted).
    const { page: dash, ok } = await openApp(chromeBin, P, { secureOrigins: [P] });
    check('dashboard boots on an untrusted address', ok, '', 'did not boot', null, dash.errors.join('\n'));
    if (!ok) return;
    await dash.ev(`__jhk.loadSamples()`, 60000);
    await dash.ev(`__jhk.start()`, 20000);
    await dash.until(`__jhk.state.layer.value === 'L1'`, 10000);
    await dash.ev(`__jhk.swap()`);
    await timed('unpaired screen shows "Pair this screen", hides vitals and the Access card', async () => {
      const okP = await dash.until(`!!document.querySelector('.pair-card') && !document.querySelector('.access-card')`, 12000);
      return okP ? { detail: 'pair notice shown, owner tools hidden' } : { ok: false, reason: await dash.ev(`document.querySelector('.l2')?.innerText.slice(0, 200)`) };
    });
    await timed('`npm run pair` flow: /app/?pair=<code> → this screen becomes an owner, code removed from the URL', async () => {
      const { code } = await (await fetch(`${S.owner}/api/pair/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      await dash.send('Page.navigate', { url: `${P}/app/?debug&pair=${code}` });
      await sleep(800);
      await dash.until('!!window.__jhk', 15000);
      await dash.ev(`__jhk.start()`, 20000);
      await dash.until(`__jhk.state.layer.value === 'L1'`, 10000);
      await dash.ev(`__jhk.swap()`);
      await dash.until(`!document.querySelector('.pair-card')`, 15000);
      await dash.ev(TAB('Room')); await sleep(300);
      const okO = await dash.until(`!!document.querySelector('.access-card') && !document.querySelector('.pair-card')`, 15000);
      const url = await dash.ev('location.search');
      return okO && !url.includes('pair=') ? { detail: `owner tools visible · URL now "${url}"` } : { ok: false, reason: JSON.stringify({ okO, url }) };
    });
    // A "phone": a second Chrome with a phone-sized viewport on the join page.
    const c2 = await launch({ bin: chromeBin, port: await freePort(), origin: P });
    chromes.push(c2);
    const ph = await c2.attach((await c2.pageTargets())[0]);
    await ph.send('Page.enable');
    await ph.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await ph.send('Page.navigate', { url: `${P}/join?k=${ROOM_CODE}` });
    await timed('phone: type a name → "Waiting for approval"', async () => {
      await ph.until(`!document.getElementById('v-ask').hidden`, 8000);
      await ph.ev(`document.getElementById('name').value = 'Priya'; document.getElementById('v-ask').requestSubmit()`);
      const okW = await ph.until(`!document.getElementById('v-wait').hidden`, 8000);
      return okW ? { detail: 'pending screen shown' } : { ok: false, reason: await ph.ev(`document.body.innerText.slice(0, 200)`) };
    });
    const shot = async (pg, name) => {
      const r = await pg.send('Page.captureScreenshot', { format: 'png' });
      if (r.result?.data) { fs.writeFileSync(path.join(ROOT, `test-shot-week4-${name}.png`), Buffer.from(r.result.data, 'base64')); note(`screenshot: test-shot-week4-${name}.png`); }
    };
    await shot(ph, 'phone-wait');
    await timed('dashboard: approval tray pops up live; tap "✓ Collaborator"', async () => {
      await dash.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
      const okT = await dash.until(`/Priya/.test(document.querySelector('.tray')?.textContent || '')`, 6000);
      await shot(dash, 'tray');
      if (!okT) return { ok: false, reason: 'no tray' };
      await dash.ev(`document.querySelector('.tray .tray-btns .primary').click()`);
      const gone = await dash.until(`!document.querySelector('.tray') && /Priya/.test(document.querySelector('.access-card')?.textContent || '')`, 6000);
      return gone ? { detail: 'tray showed Priya; approved; she is listed in Access' } : { ok: false, reason: 'tray did not clear' };
    });
    await timed('phone flips to "You\'re in" as Collaborator by itself', async () => {
      const okI = await ph.until(`!document.getElementById('v-in').hidden && document.getElementById('i-role').textContent === 'Collaborator'`, 8000);
      await shot(ph, 'phone-in');
      return okI ? { detail: 'approved screen with role' } : { ok: false, reason: await ph.ev(`document.body.innerText.slice(0, 200)`) };
    });
    await timed('kill switch from the dashboard: phone page turns to "Owner-only mode"', async () => {
      await dash.ev(`document.querySelector('.kill').click()`);
      const on = await dash.until(`document.querySelector('.kill')?.classList.contains('on')`, 5000);
      await ph.send('Page.reload');
      const blocked = await ph.until(`/owner-only mode/.test(document.body.innerText)`, 8000);
      await dash.ev(`document.querySelector('.access-card')?.scrollIntoView({ block: 'center' })`); await sleep(300);
      await shot(dash, 'access');
      await dash.ev(`document.querySelector('.kill').click()`);
      const off = await dash.until(`!document.querySelector('.kill')?.classList.contains('on')`, 5000);
      return on && blocked && off ? { detail: 'on → phone blocked → off' } : { ok: false, reason: JSON.stringify({ on, blocked, off }) };
    });
    await timed('remove from the dashboard → phone shows "Removed from the room"', async () => {
      await ph.send('Page.navigate', { url: `${P}/join?k=${ROOM_CODE}` });
      await ph.until(`!document.getElementById('v-in').hidden`, 8000);
      const self = await dash.ev(`[...document.querySelectorAll('.dev-table tr')].find(tr => /Laptop/.test(tr.textContent))?.textContent || ''`);
      if (!/this screen/.test(self)) return { ok: false, reason: `own row should say "this screen": ${self}` };
      await dash.ev(`document.querySelector('.dev-table button.small-btn')?.click()`);
      const okR = await ph.until(`!document.getElementById('v-no').hidden && /Removed/.test(document.getElementById('no-title').textContent)`, 20000);
      return okR ? { detail: 'phone noticed within its 15 s refresh' } : { ok: false, reason: await ph.ev(`document.body.innerText.slice(0, 200)`) };
    });
    check('no uncaught page errors (dashboard + phone)', dash.errors.length === 0 && ph.errors.length === 0, 'none', [...dash.errors, ...ph.errors].slice(0, 3).join(' | '));
  } finally { S.proc.kill(); }
}

// =============================================================================== Week 5

/** A Yjs board client over /ws (what the app does), with an optional cookie (a phone) or none (owner from 127.0.0.1). */
function yclient(base, cookie, role = 'room') {
  const Y = Yjs();
  return new Promise((res) => {
    const doc = new Y.Doc();
    const msgs = [];
    const w = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: cookie ? { cookie } : {} });
    let ready = false;
    w.onmessage = (e) => {
      const m = JSON.parse(e.data);
      msgs.push(m);
      if (m.t === 'room-update') { Y.applyUpdate(doc, Buffer.from(m.u, 'base64'), 'server'); if (m.initial && !ready) { ready = true; res(api); } }
    };
    doc.on('update', (u, origin) => { if (origin !== 'server' && w.readyState === 1) w.send(JSON.stringify({ t: 'room-update', u: yb64(u) })); });
    w.onopen = () => { w.send(JSON.stringify({ t: 'iam', role })); w.send(JSON.stringify({ t: 'room-sync' })); };
    w.onclose = () => { if (!ready) res({ ...api, closed: true }); };
    const texts = () => doc.getArray('notes').toArray().map((m) => m.get('text')).sort();
    const add = (text) => { const m = new Y.Map(); doc.transact(() => { m.set('id', Math.random().toString(36).slice(2)); m.set('text', text); m.set('color', 'amber'); m.set('by', 't'); m.set('at', Date.now()); m.set('done', false); doc.getArray('notes').push([m]); }); };
    const api = { doc, w, msgs, texts, add, send: (m) => w.send(JSON.stringify(m)), close: () => w.close() };
  });
}

async function approvedPhone(base, owner, name, role) {
  const ph = phone(base);
  await ph.req('/api/join', { name });
  const a = await (await fetch(`${owner}/api/access`)).json();
  const d = a.devices.find((x) => x.name === name && x.status === 'pending');
  await fetch(`${owner}/api/devices/${d.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  return ph;
}

async function week5ServerTests() {
  section('WEEK 5 · ROOM SERVER: live board (Yjs), door sign, drop zone, owner remote');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-w5-'));
  let S = await startW4Server({ JHK_DATA: dataDir, JHK_DROP_QUOTA_MB: '1' });
  const P = () => `http://${ip}:${S.port}`;
  const ownPost = (p, body) => fetch(S.owner + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
  try {
    const collab = await approvedPhone(P(), S.owner, 'Asha', 'collaborator');
    const viewer = await approvedPhone(P(), S.owner, 'Vik', 'viewer');
    const ownerPhone = await approvedPhone(P(), S.owner, 'Me', 'owner');
    await timed('board: laptop + phone type at the same time → both notes everywhere (conflict-free)', async () => {
      const lap = await yclient(S.owner, null, 'A');
      const ph = await yclient(P(), collab.cookie);
      lap.add('buy milk'); ph.add('laundry at 6');
      await sleep(600);
      const late = await yclient(P(), viewer.cookie);          // joins later: gets the whole board
      await sleep(200);
      const ok = lap.texts().join() === 'buy milk,laundry at 6' && ph.texts().join() === lap.texts().join() && late.texts().join() === lap.texts().join();
      [lap, ph, late].forEach((c) => c.close());
      return ok ? { detail: `laptop ${JSON.stringify(lap.texts())} = phone = late joiner` } : { ok: false, reason: JSON.stringify({ lap: lap.texts(), ph: ph.texts(), late: late.texts() }) };
    });
    await timed('board: a viewer\'s edit is refused (room-readonly) and reaches nobody', async () => {
      const v = await yclient(P(), viewer.cookie);
      const lap = await yclient(S.owner, null, 'A');
      v.add('viewer graffiti');
      await sleep(500);
      const ro = v.msgs.some((m) => m.t === 'room-readonly');
      const leaked = lap.texts().includes('viewer graffiti');
      v.close(); lap.close();
      return ro && !leaked ? { detail: 'refused, laptop board unchanged' } : { ok: false, reason: JSON.stringify({ ro, leaked }) };
    });
    await timed('door sign: owner sets it → phones get it live; phones can\'t set it; bad status → 400', async () => {
      const ph = await yclient(P(), collab.cookie);
      const r = await ownPost('/api/door', { status: 'Studying', note: 'exam tomorrow' });
      const bad = await ownPost('/api/door', { status: 'Party' });
      const byPhone = await collab.req('/api/door', { status: 'Come in' });
      await sleep(300);
      const got = ph.msgs.filter((m) => m.t === 'door').at(-1)?.door;
      ph.close();
      return r.status === 200 && bad.status === 400 && byPhone.status === 403 && got?.status === 'Studying' && got.note === 'exam tomorrow'
        ? { detail: 'phone saw "Studying · exam tomorrow" · phone set → 403 · "Party" → 400' } : { ok: false, reason: JSON.stringify({ r: r.status, bad: bad.status, byPhone: byPhone.status, got }) };
    });
    let dropId;
    await timed('drop zone: collaborator uploads → listed → downloads byte-identical; viewer can\'t upload', async () => {
      const data = crypto.randomBytes(300 * 1024);
      const up = await fetch(`${P()}/api/drops?name=${encodeURIComponent('notes ch3.pdf')}&type=application/pdf`, { method: 'PUT', headers: { cookie: collab.cookie, 'content-type': 'application/octet-stream' }, body: data });
      const uj = await up.json();
      dropId = uj.id;
      const list = (await collab.req('/api/room')).j.drops;
      const dl = Buffer.from(await (await fetch(`${P()}/api/drops/${dropId}`, { headers: { cookie: viewer.cookie } })).arrayBuffer());
      const vUp = await fetch(`${P()}/api/drops?name=x`, { method: 'PUT', headers: { cookie: viewer.cookie, 'content-type': 'application/octet-stream' }, body: Buffer.from('hi') });
      const anon = await fetch(`${P()}/api/drops/${dropId}`);
      const ok = up.status === 200 && list[0]?.name === 'notes ch3.pdf' && list[0].byName === 'Asha' && dl.equals(data) && vUp.status === 403 && anon.status === 403;
      return ok ? { detail: `300 KB up, viewer downloads identical copy · viewer upload → 403 · stranger → 403` } : { ok: false, reason: JSON.stringify({ up: up.status, uj, list: list?.[0], same: dl.equals(data), vUp: vUp.status, anon: anon.status }) };
    });
    await timed('drop zone: per-device quota enforced while streaming (1 MB in this test) → 413, nothing left on disk', async () => {
      const before = fs.readdirSync(path.join(dataDir, 'drops')).length;
      const big = await fetch(`${P()}/api/drops?name=big.bin`, { method: 'PUT', headers: { cookie: collab.cookie, 'content-type': 'application/octet-stream' }, body: crypto.randomBytes(2 * 2 ** 20) });
      const after = fs.readdirSync(path.join(dataDir, 'drops')).length;
      return big.status === 413 && after === before ? { detail: `413 "${(await big.json()).error}", files on disk ${before} → ${after}` } : { ok: false, reason: `${big.status}, files ${before} → ${after}` };
    });
    await timed('drop zone: only the uploader or an owner can delete', async () => {
      const v = await fetch(`${P()}/api/drops/${dropId}`, { method: 'DELETE', headers: { cookie: viewer.cookie } });
      const o = await fetch(`${S.owner}/api/drops/${dropId}`, { method: 'DELETE' });
      const gone = await fetch(`${S.owner}/api/drops/${dropId}`);
      return v.status === 403 && o.status === 200 && gone.status === 404 ? { detail: 'viewer → 403 · owner → deleted · then 404' } : { ok: false, reason: `${v.status} ${o.status} ${gone.status}` };
    });
    await timed('remote: owner phone → dashboard window (W-A) gets the command; collaborators can\'t; screen state flows back', async () => {
      const dash = await yclient(S.owner, null, 'A');
      const op = await yclient(P(), ownerPhone.cookie);
      const cp = await yclient(P(), collab.cookie);
      dash.send({ t: 'screen-state', s: { mode: 'dual', layer: 'L2', cinema: false, night: false, currentId: 'w1', wallpapers: [{ id: 'w1', name: 'Rain' }], scene: 'Ambient' } });
      await sleep(200);
      op.send({ t: 'remote', cmd: 'cinema' });
      cp.send({ t: 'remote', cmd: 'swap' });
      op.send({ t: 'remote', cmd: 'rm -rf' });
      await sleep(400);
      const got = dash.msgs.filter((m) => m.t === 'remote').map((m) => m.cmd);
      const ack = op.msgs.find((m) => m.t === 'remote-ack');
      const scr = op.msgs.find((m) => m.t === 'screen')?.s;
      const cpScr = cp.msgs.some((m) => m.t === 'screen');
      [dash, op, cp].forEach((c) => c.close());
      const ok = got.join() === 'cinema' && ack?.delivered === 1 && scr?.scene === 'Ambient' && !cpScr;
      return ok ? { detail: 'dashboard got only "cinema" (collaborator swap + unknown cmd dropped) · ack delivered=1 · owner phone sees screen state, collaborator doesn\'t' } : { ok: false, reason: JSON.stringify({ got, ack, scr, cpScr }) };
    });
    await timed('board survives a server restart (saved to SQLite on stop)', async () => {
      S.proc.kill('SIGTERM'); await new Promise((r) => S.proc.once('exit', r));
      S = await startW4Server({ JHK_DATA: dataDir });
      const lap = await yclient(S.owner, null, 'A');
      const t = lap.texts(); lap.close();
      return t.join() === 'buy milk,laundry at 6' ? { detail: `after restart: ${JSON.stringify(t)}` } : { ok: false, reason: JSON.stringify(t) };
    });
  } finally { S.proc.kill(); }
}

async function week5BrowserTests(chromeBin) {
  await freeChromes();
  section('WEEK 5 · LAYER 2 REDESIGN + ROOM PAGE (laptop, wall monitor, phone)');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const S = await startW4Server();
  const L = `http://localhost:${S.port}`;           // the laptop: trusted, like ChromeOS Chrome via localhost
  const P = `http://${ip}:${S.port}`;               // phones
  const shot = async (pg, name) => {
    const r = await pg.send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) { fs.writeFileSync(path.join(ROOT, `test-shot-week5-${name}.png`), Buffer.from(r.result.data, 'base64')); note(`screenshot: test-shot-week5-${name}.png`); }
  };
  try {
    const { page: dash, ok } = await openApp(chromeBin, L);
    check('dashboard boots', ok, '', 'did not boot', null, dash.errors.join('\n'));
    if (!ok) return;
    await dash.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await dash.ev(`__jhk.loadSamples()`, 60000);
    await dash.ev(`__jhk.start()`, 20000);
    await dash.until(`__jhk.state.layer.value === 'L1'`, 10000);
    await dash.ev(`__jhk.swap()`);
    await timed('laptop control centre: header + tabs (Home · Wallpapers · Room · Fun · Tools · System); Home has vitals, now playing, door sign, people, board', async () => {
      const okH = await dash.until(`document.querySelectorAll('.tab').length === 6 && document.querySelector('.home .ring-card') && document.querySelector('.now-name') && document.querySelector('.door-picker') && document.querySelector('.board .note-form')`, 10000);
      const tabs = await dash.ev(`[...document.querySelectorAll('.tab')].map(t => t.textContent.trim())`);
      return okH ? { detail: `tabs: ${tabs.join(' · ')}` } : { ok: false, reason: await dash.ev(`document.querySelector('.panel')?.innerText.slice(0, 300)`) };
    });
    await timed('laptop: add a note on Home → it appears on the board', async () => {
      await dash.ev(`(() => { const i = document.querySelector('.note-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Pay electricity bill'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(150);
      await dash.ev(`document.querySelector('.note-form').requestSubmit()`);
      const okN = await dash.until(`/Pay electricity bill/.test(document.querySelector('.notes')?.textContent || '')`, 5000);
      return okN ? { detail: 'note shown' } : { ok: false, reason: 'note missing' };
    });
    await timed('door sign chip on the laptop → "Studying" in the header', async () => {
      await dash.ev(`[...document.querySelectorAll('.door-picker .chip')].find(c => c.textContent === 'Studying').click()`);
      const okD = await dash.until(`document.querySelector('.cc-head .door-status')?.textContent === 'Studying'`, 5000);
      return okD ? { detail: 'header badge updated live' } : { ok: false, reason: await dash.ev(`document.querySelector('.cc-head')?.innerText`) };
    });
    await shot(dash, 'laptop-home');
    // ---- phone: join, get approved as owner (so the remote is tested too), open the room page
    const c2 = await launch({ bin: chromeBin, port: await freePort(), origin: P });
    chromes.push(c2);
    const ph = await c2.attach((await c2.pageTargets())[0]);
    await ph.send('Page.enable');
    await ph.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await ph.send('Page.navigate', { url: `${P}/join?k=${ROOM_CODE}` });
    await ph.until(`!document.getElementById('v-ask').hidden`, 8000);
    await ph.ev(`document.getElementById('name').value = 'Priya'; document.getElementById('v-ask').requestSubmit()`);
    await dash.until(`/Priya/.test(document.querySelector('.tray')?.textContent || '')`, 8000);
    await dash.ev(`[...document.querySelectorAll('.tray button')].find(b => b.textContent.trim() === 'Owner').click()`);
    await timed('phone: approved → "Open the room" → room page shows the laptop\'s note and the door sign', async () => {
      await ph.until(`!document.getElementById('v-in').hidden`, 8000);
      await ph.ev(`document.querySelector('.go-room').click()`);
      const door = await ph.until(`!!document.querySelector('.door-picker, .door-badge')`, 12000);
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Board/.test(b.textContent)).click()`);
      const okR = door && await ph.until(`/Pay electricity bill/.test(document.querySelector('.notes')?.textContent || '')`, 8000);
      return okR ? { detail: 'board + door visible on the phone' } : { ok: false, reason: await ph.ev(`document.body.innerText.slice(0, 300)`) };
    });
    await timed('phone adds a note → laptop board shows it live', async () => {
      await ph.ev(`(() => { const i = document.querySelector('.note-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Movie night Friday?'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(150);
      await ph.ev(`document.querySelector('.note-form').requestSubmit()`);
      const okL = await dash.until(`/Movie night Friday/.test(document.querySelector('.notes')?.textContent || '')`, 6000);
      return okL ? { detail: 'arrived on the laptop' } : { ok: false, reason: 'not on laptop' };
    });
    await shot(ph, 'phone-board');
    await timed('phone uploads a file → laptop Room tab lists it in the Drop zone', async () => {
      await ph.ev(`fetch('/api/drops?name=' + encodeURIComponent('timetable.txt') + '&type=text/plain', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'Mon: maths' }).then(r => r.status)`);
      await dash.ev(TAB('Room')); await sleep(300);
      const okF = await dash.until(`/timetable\\.txt/.test(document.querySelector('.drop-list')?.textContent || '')`, 6000);
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Share/.test(b.textContent)).click()`);
      const okP = await ph.until(`/timetable\\.txt/.test(document.querySelector('.drop-list')?.textContent || '')`, 4000);
      return okF && okP ? { detail: 'listed on the laptop and the phone' } : { ok: false, reason: JSON.stringify({ okF, okP }) };
    });
    await timed('phone remote (owner): Cinema → the laptop goes into Cinema; tap again → back', async () => {
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Home/.test(b.textContent)).click()`);
      await ph.until(`!!document.querySelector('.remote-grid')`, 5000);
      await shot(ph, 'phone-remote');
      await ph.ev(`[...document.querySelectorAll('.rbtn')].find(b => /Cinema/.test(b.textContent)).click()`);
      const on = await dash.until(`__jhk.state.cinema.value`, 5000);
      const phOn = await ph.until(`[...document.querySelectorAll('.rbtn')].find(b => /Cinema/.test(b.textContent))?.classList.contains('on')`, 5000);
      await ph.ev(`[...document.querySelectorAll('.rbtn')].find(b => /Cinema/.test(b.textContent)).click()`);
      const off = await dash.until(`!__jhk.state.cinema.value`, 5000);
      return on && phOn && off ? { detail: 'cinema on (phone button lit) → off' } : { ok: false, reason: JSON.stringify({ on, phOn, off }) };
    });
    await timed('Connect-a-phone helper: big QR, steps, and "a phone reached this laptop" ticks once one has', async () => {
      await dash.ev(TAB('Home')); await sleep(300);
      await dash.ev(`[...document.querySelectorAll('button')].find(b => /Connect a phone/.test(b.textContent)).click()`);
      const okC = await dash.until(`document.querySelector('.modal .qr.big') && document.querySelectorAll('.modal .steps li').length === 4 && /yes/.test(document.querySelectorAll('.modal .steps li')[3].textContent)`, 8000);
      await shot(dash, 'connect');
      await dash.ev(`document.querySelector('.modal .modal-x').click()`);
      return okC ? { detail: 'modal with QR + 4 steps; step 4 = yes' } : { ok: false, reason: await dash.ev(`document.querySelector('.modal')?.innerText.slice(0, 300)`) };
    });
    await timed('wall layout on a 2560×1440 monitor: huge clock, big door sign, sticky notes, join QR', async () => {
      await dash.send('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false });
      const okW = await dash.until(`!!document.querySelector('.wall2') && document.querySelectorAll('.sticky').length >= 2 && document.querySelector('.w-time .door-status')?.textContent === 'Studying' && document.querySelector('.w-join img.qr')`, 6000);
      const clockPx = await dash.ev(`parseFloat(getComputedStyle(document.querySelector('.w-time .clock-time')).fontSize)`);
      const overflow = await dash.ev(`document.querySelector('.panel').scrollHeight > innerHeight + 4`);
      await shot(dash, 'wall');
      return okW && clockPx >= 200 && !overflow ? { detail: `clock ${clockPx}px, ${await dash.ev(`document.querySelectorAll('.sticky').length`)} sticky notes, fits one screen (no scroll)` }
        : { ok: false, reason: JSON.stringify({ okW, clockPx, overflow }) };
    });
    await timed('wall layout at 1920×1080 also fits without scrolling', async () => {
      await dash.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      const r = await dash.ev(`({ wall: !!document.querySelector('.wall2'), over: document.querySelector('.panel').scrollHeight - innerHeight })`);
      await shot(dash, 'wall-1080');
      return r.wall && r.over <= 4 ? { detail: 'fits' } : { ok: false, reason: JSON.stringify(r) };
    });
    check('no uncaught page errors (dashboard + phone)', dash.errors.length === 0 && ph.errors.length === 0, 'none', [...dash.errors, ...ph.errors].slice(0, 3).join(' | '));
  } finally { S.proc.kill(); }
}

// =============================================================================== internet share (tunnel)
async function tunnelTests() {
  section('INTERNET SHARE: Cloudflare quick tunnel (off by default, strangers only reach /join)');
  note('A stand-in cloudflared prints a trycloudflare URL; "internet" requests are simulated the way cloudflared delivers them:');
  note('from 127.0.0.1, Host = the public *.trycloudflare.com name, CF-Connecting-IP = the phone.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-tun-'));
  const fake = path.join(dir, 'cloudflared');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nsetTimeout(() => process.stderr.write('INF +----+\\nINF |  https://quiet-river-test.trycloudflare.com  |\\n'), 150);\nsetInterval(() => {}, 1e6);\nprocess.on('SIGTERM', () => process.exit(0));\n`);
  fs.chmodSync(fake, 0o755);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-tun-data-'));
  let S = await startW4Server({ JHK_DATA: dataDir, JHK_CLOUDFLARED: fake, JHK_LAPTOP_IP: '203.0.113.1' });
  const HOST = 'quiet-river-test.trycloudflare.com';
  const net = (method, p, body, extra = {}) => new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port: S.port, path: p, method, headers: { host: HOST, 'cf-connecting-ip': '203.0.113.9', accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...extra } }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } res({ status: r.statusCode, j, cookie: (r.headers['set-cookie'] || [])[0], location: r.headers.location }); });
    });
    rq.end(body ? JSON.stringify(body) : undefined);
  });
  const own = (p, body) => fetch(S.owner + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    await timed('off by default; owner turns it on → public URL, QR now points at https://…/join', async () => {
      const t0 = await own('/api/tunnel');
      await own('/api/tunnel', { on: true });
      let j = null;
      for (let i = 0; i < 30; i++) { j = await own('/api/join'); if (j.source === 'tunnel') break; await sleep(100); }
      const ok = t0.status === 'off' && t0.available && !t0.wanted && j.source === 'tunnel' && j.url === `https://${HOST}/join?k=${ROOM_CODE}`;
      return ok ? { detail: `was off · now ${j.url}` } : { ok: false, reason: JSON.stringify({ t0, j }) };
    });
    await timed('stranger over the internet: /join + phone page assets OK; vitals, health, owner APIs, samples → refused', async () => {
      const codes = {};
      for (const p of ['/join', '/api/me', '/app/room.html']) codes[p] = (await net('GET', p)).status;
      for (const p of ['/api/vitals', '/health', '/api/access', '/api/tunnel', '/samples/sample_720p30.mp4', '/api/room', '/']) codes[p] = (await net('GET', p)).status;
      const html = await net('GET', '/updates.html', null, { accept: 'text/html' });
      const pass1 = codes['/join'] === 200 && codes['/api/me'] === 200 && codes['/app/room.html'] === 200;
      const blocked = ['/api/vitals', '/health', '/api/access', '/api/tunnel', '/samples/sample_720p30.mp4', '/api/room', '/'].every((p) => codes[p] === 403);
      return pass1 && blocked && html.status === 302 && html.location === '/join' ? { detail: `${JSON.stringify(codes)} · html pages → redirect to /join` } : { ok: false, reason: JSON.stringify({ codes, html }) };
    });
    await timed('internet traffic is never treated as the laptop, even though cloudflared connects from 127.0.0.1', async () => {
      const r = await net('POST', '/api/kill', { on: true });
      const me = await net('GET', '/api/me');
      const k = await own('/api/access');
      return r.status === 403 && !me.j.owner && !k.kill ? { detail: 'kill switch from the internet → 403 · me.owner = false' } : { ok: false, reason: JSON.stringify({ r: r.status, me: me.j, kill: k.kill }) };
    });
    await timed('phone joins over the internet → owner sees "(internet)" → approved → full access', async () => {
      const j = await net('POST', '/api/join', { name: 'Kabir', k: ROOM_CODE });
      const cookie = (j.cookie || '').split(';')[0];
      const a = await own('/api/access');
      const d = a.devices.find((x) => x.name === 'Kabir');
      await own(`/api/devices/${d.id}/approve`, { role: 'collaborator' });
      const v = await net('GET', '/api/vitals', null, { cookie });
      const room = await net('GET', '/api/room', null, { cookie });
      const acc = await net('GET', '/api/access', null, { cookie });
      const ok = j.status === 200 && d.ip === '203.0.113.9 (internet)' && v.status === 200 && room.status === 200 && acc.status === 403;
      return ok ? { detail: `request shows ${d.ip} · approved → vitals/room 200, owner APIs still 403` } : { ok: false, reason: JSON.stringify({ j: j.status, ip: d?.ip, v: v.status, room: room.status, acc: acc.status }) };
    });
    await timed('stays on after a server restart (owner opted in); off → QR back to the Wi-Fi address', async () => {
      S.proc.kill('SIGTERM'); await new Promise((r) => S.proc.once('exit', r));
      S = await startW4Server({ JHK_DATA: dataDir, JHK_CLOUDFLARED: fake, JHK_LAPTOP_IP: '203.0.113.1' });
      let j = null;
      for (let i = 0; i < 30; i++) { j = await own('/api/join'); if (j.source === 'tunnel') break; await sleep(100); }
      await own('/api/tunnel', { on: false });
      const after = await own('/api/join');
      const audit = (await own('/api/access')).audit.map((x) => x.action);
      const ok = j.source === 'tunnel' && after.source !== 'tunnel' && after.tunnel.status === 'off' && audit.includes('internet sharing ON') && audit.includes('internet sharing off');
      return ok ? { detail: `back on after restart · off → ${after.source} (${after.url}) · audited` } : { ok: false, reason: JSON.stringify({ j: j?.source, after, audit }) };
    });
  } finally { S.proc.kill(); }
  await timed('without cloudflared installed the switch says "not installed" (no crash)', async () => {
    const T = await startW4Server({ JHK_CLOUDFLARED: path.join(dir, 'nope') });
    try {
      const r = await (await fetch(`${T.owner}/api/tunnel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true}' })).json();
      await sleep(300);
      const st = await (await fetch(`${T.owner}/api/tunnel`)).json();
      const up = (await fetch(`${T.owner}/ping`)).ok;
      return up && st.status !== 'on' ? { detail: `status "${st.status}" · server still up` } : { ok: false, reason: JSON.stringify({ r, st, up }) };
    } finally { T.proc.kill(); }
  });
}

// =============================================================================== Week 6
async function week6ServerTests() {
  section('WEEK 6 · FUN SERVER: watch queue, cast-to-wall, study-room timer, scoreboard');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-w6-'));
  let S = await startW4Server({ JHK_DATA: dataDir });
  const P = `http://${ip}:${S.port}`;
  const own = (p, body, method) => fetch(S.owner + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
  try {
    const col = await approvedPhone(P, S.owner, 'Asha', 'collaborator');
    const col2 = await approvedPhone(P, S.owner, 'Dev', 'collaborator');
    const vw = await approvedPhone(P, S.owner, 'Vik', 'viewer');
    await timed('queue: collaborator adds a YouTube link (classified), duplicates / javascript: refused, viewer can\'t vote', async () => {
      const a = await col.req('/api/fun/queue', { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Song' });
      const dup = await col2.req('/api/fun/queue', { url: 'https://youtu.be/dQw4w9WgXcQ' });
      const js = await col.req('/api/fun/queue', { url: 'javascript:alert(1)' });
      const b = await col2.req('/api/fun/queue', { url: 'https://www.netflix.com/title/81231974', title: 'Show' });
      const f = (await own('/api/fun')).j;
      const yt = f.queue.find((q) => q.title === 'Song');
      const nf = f.queue.find((q) => q.title === 'Show');
      const v = await vw.req(`/api/fun/queue/${nf.id}/vote`, {});
      const ok = a.status === 200 && dup.status === 400 && js.status === 400 && b.status === 200 && yt.kind === 'youtube' && yt.embed.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ') && nf.kind === 'drm' && v.status === 403;
      return ok ? { detail: 'youtube → embed, netflix → drm (link only) · dup/javascript → 400 · viewer vote → 403' } : { ok: false, reason: JSON.stringify({ a: a.status, dup: dup.status, js: js.status, b: b.status, yt, nf, v: v.status }) };
    });
    await timed('queue: votes reorder it; only the adder or an owner can remove', async () => {
      const f0 = (await own('/api/fun')).j;
      const nf = f0.queue.find((q) => q.title === 'Show');
      await col.req(`/api/fun/queue/${nf.id}/vote`, {});
      await own(`/api/fun/queue/${nf.id}/vote`, {});                  // Show: Dev + Asha + laptop = 3, Song: 1
      const f = (await own('/api/fun')).j;
      const order = [...f.queue].sort((a, b) => b.votes.length - a.votes.length || a.at - b.at).map((q) => `${q.title}:${q.votes.length}`);
      const song = f.queue.find((q) => q.title === 'Song');
      const byOther = await col2.req(`/api/fun/queue/${song.id}`, undefined, 'DELETE');
      const byOwner = await own(`/api/fun/queue/${song.id}`, undefined, 'DELETE');
      return order.join() === 'Show:3,Song:1' && byOther.status === 403 && byOwner.status === 200 ? { detail: `order ${order.join(' > ')} · other collaborator remove → 403 · owner → ok` } : { ok: false, reason: JSON.stringify({ order, byOther: byOther.status, byOwner: byOwner.status }) };
    });
    await timed('cast: a collaborator only asks; the owner approves → on the wall; stop clears it; viewer can\'t', async () => {
      const ask = await col.req('/api/fun/cast', { url: 'https://youtu.be/aqz-KE-bpKQ', title: 'Big Buck Bunny' });
      const f1 = (await own('/api/fun')).j;
      const vAsk = await vw.req('/api/fun/cast', { url: 'https://example.com' });
      const ap = await own(`/api/fun/cast/${f1.casts[0].id}/approve`, {});
      const f2 = (await own('/api/fun')).j;
      const otherStop = await col2.req('/api/fun/cast/stop', {});   // someone else's cast: no
      const phoneStop = await col.req('/api/fun/cast/stop', {});     // the person who asked: yes
      const f3 = (await own('/api/fun')).j;
      const ok = ask.j?.pending && f1.casting === null && f1.casts.length === 1 && vAsk.status === 403 && ap.status === 200 && f2.casting?.kind === 'youtube' && f2.casting.requestedBy === 'Asha' && f2.casts.length === 0 && otherStop.status === 403 && phoneStop.status === 200 && f3.casting === null;
      return ok ? { detail: 'ask → pending · approve → casting youtube (asked by Asha) · another phone stop → 403 · Asha stops her own → cleared' } : { ok: false, reason: JSON.stringify({ ask: ask.j, f1: [f1.casting, f1.casts.length], vAsk: vAsk.status, ap: ap.status, f2: f2.casting, ps: phoneStop.status, os: otherStop.status, f3: f3.casting }) };
    });
    await timed('study room: start → shared countdown; pause keeps the time; skip → break; lengths validated', async () => {
      const st = await col.req('/api/fun/pomo/start', {});
      const p1 = (await own('/api/fun')).j.pomo;
      await sleep(1100);
      await col2.req('/api/fun/pomo/pause', {});
      const p2 = (await own('/api/fun')).j.pomo;
      const bad = await col.req('/api/fun/pomo/set', { focusMin: 2, breakMin: 5 });
      await col.req('/api/fun/pomo/skip', {});
      const p3 = (await own('/api/fun')).j.pomo;
      const left1 = p1.endsAt - Date.now();
      const ok = st.status === 200 && p1.phase === 'focus' && p1.running && Math.abs(left1 - 25 * 60000) < 5000 && !p2.running && p2.leftMs < 25 * 60000 && p2.leftMs > 24 * 60000 && bad.status === 400 && p3.phase === 'break' && p3.leftMs === 5 * 60000;
      await own('/api/fun/pomo/reset', {});
      return ok ? { detail: `focus 25:00 running → paused at ${Math.round(p2.leftMs / 1000)} s · 2-min focus → 400 · skip → break 5:00` } : { ok: false, reason: JSON.stringify({ st: st.status, p1, p2, bad: bad.status, p3 }) };
    });
    await timed('scoreboard: add players, +/−, ranking; only an owner clears; viewers can\'t score', async () => {
      await col.req('/api/fun/game/add', { name: 'Asha' }); await col.req('/api/fun/game/add', { name: 'Dev' });
      const dupe = await col.req('/api/fun/game/add', { name: 'asha' });
      let g = (await own('/api/fun')).j.game;
      const a = g.players.find((p) => p.name === 'Asha'), d = g.players.find((p) => p.name === 'Dev');
      for (let i = 0; i < 3; i++) await col2.req('/api/fun/game/score', { id: d.id, delta: 1 });
      await col.req('/api/fun/game/score', { id: a.id, delta: 1 });
      const vs = await vw.req('/api/fun/game/score', { id: a.id, delta: 5 });
      const cClear = await col.req('/api/fun/game/clear', {});
      g = (await own('/api/fun')).j.game;
      const rank = [...g.players].sort((x, y) => y.score - x.score).map((p) => `${p.name}:${p.score}`).join();
      return dupe.status === 400 && vs.status === 403 && cClear.status === 403 && rank === 'Dev:3,Asha:1' ? { detail: `${rank} · duplicate name → 400 · viewer score → 403 · collaborator clear → 403` } : { ok: false, reason: JSON.stringify({ dupe: dupe.status, vs: vs.status, cClear: cClear.status, rank }) };
    });
    await timed('quiet hours: collaborators become read-only for fun too (no casts at night)', async () => {
      const t = new Date(); const hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      await own('/api/quiet', { enabled: true, start: hh(new Date(t - 3600000)), end: hh(new Date(+t + 3600000)) });
      const c = await col.req('/api/fun/cast', { url: 'https://example.com/x' });
      const q = await col.req('/api/fun/queue', { url: 'https://example.com/y' });
      await own('/api/quiet', { enabled: false });
      return c.status === 403 && q.status === 403 ? { detail: 'cast + queue → 403 during quiet hours' } : { ok: false, reason: `${c.status} ${q.status}` };
    });
    await timed('members get live "fun" updates over /ws; state survives a restart', async () => {
      const ws = await yclient(P, col.cookie);
      await own('/api/fun/game/add', { name: 'Laptop' });
      await sleep(300);
      const live = ws.msgs.filter((m) => m.t === 'fun').at(-1)?.fun.game.players.some((p) => p.name === 'Laptop');
      ws.close();
      S.proc.kill('SIGTERM'); await new Promise((r) => S.proc.once('exit', r));
      S = await startW4Server({ JHK_DATA: dataDir });
      const g = (await own('/api/fun')).j.game;
      return live && g.players.length === 3 ? { detail: `live update seen · after restart ${g.players.map((p) => p.name).join(', ')}` } : { ok: false, reason: JSON.stringify({ live, g }) };
    });
  } finally { S.proc.kill(); }
}

async function week6BrowserTests(chromeBin) {
  await freeChromes();
  section('WEEK 6 · FUN LAYER ON SCREEN (cast, study room, scoreboard, ink theme)');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const S = await startW4Server();
  const L = `http://localhost:${S.port}`, P = `http://${ip}:${S.port}`;
  const own = (p, body) => fetch(S.owner + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
  const shot = async (pg, name) => {
    const r = await pg.send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) { fs.writeFileSync(path.join(ROOT, `test-shot-week6-${name}.png`), Buffer.from(r.result.data, 'base64')); note(`screenshot: test-shot-week6-${name}.png`); }
  };
  const typeInto = (pg, sel, val) => pg.ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(val)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  try {
    const { page: dash, ok } = await openApp(chromeBin, L);
    check('dashboard boots', ok, '', 'did not boot', null, dash.errors.join('\n'));
    if (!ok) return;
    await dash.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await dash.ev(`__jhk.loadSamples()`, 60000);
    await dash.ev(`__jhk.start()`, 20000);
    await dash.until(`__jhk.state.layer.value === 'L1' && __jhk.state.loopStats.value?.fps > 0`, 10000);
    await dash.ev(`__jhk.swap()`);
    const ph = await approvedPhoneBrowser(chromeBin, P, S.owner, 'Asha', 'collaborator');
    await timed('laptop Fun tab: queue, cast, study room, game night cards', async () => {
      await dash.ev(TAB('Fun')); await sleep(300);
      const n = await dash.ev(`[...document.querySelectorAll('.tab-body .card h2')].map(h => h.textContent.trim())`);
      return ['Watch-party queue', 'Cast to wall', 'Study room', 'Game night'].every((t) => n.includes(t)) ? { detail: n.join(' · ') } : { ok: false, reason: JSON.stringify(n) };
    });
    await timed('phone adds a video + asks to cast it → laptop tray "wants to put … on the wall" → Show → wallpaper pauses, video on the wall', async () => {
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Share/.test(b.textContent)).click()`);
      await ph.until(`!!document.querySelector('.queue form input')`, 5000);
      await typeInto(ph, '.queue form input', 'https://youtu.be/aqz-KE-bpKQ');
      await sleep(150); await ph.ev(`document.querySelector('.queue form').requestSubmit()`);
      await typeInto(ph, '.cast form input', 'https://www.youtube.com/watch?v=ScMzIvxBSi4');
      await sleep(150); await ph.ev(`document.querySelector('.cast form').requestSubmit()`);
      const tray = await dash.until(`/wants to put/.test(document.querySelector('.tray')?.textContent || '')`, 6000);
      await shot(ph, 'phone-fun');
      if (!tray) return { ok: false, reason: 'no cast request in the tray' };
      await dash.ev(`[...document.querySelectorAll('.tray button')].find(b => /Show on wall/.test(b.textContent)).click()`);
      const on = await dash.until(`document.querySelector('.cast-overlay iframe')?.src.includes('youtube-nocookie.com/embed/ScMzIvxBSi4') && __jhk.state.loopStats.value?.paused`, 6000);
      const card = await dash.ev(`!!document.querySelector('.cast-loading') || !!document.querySelector('.cast-frame.in')`);
      await shot(dash, 'cast-start');
      const loaded = await dash.until(`!!document.querySelector('.cast-frame.in')`, 15000);
      await sleep(4000);
      await shot(dash, 'cast');
      note(`YouTube player ${loaded ? 'loaded' : 'did not load within 15 s (no internet?)'}`);
      if (!card) return { ok: false, reason: 'black screen while loading (no title card)' };
      return on ? { detail: 'tray → Show → YouTube embed full screen, wallpaper paused' } : { ok: false, reason: JSON.stringify(await dash.ev(`({ ov: !!document.querySelector('.cast-overlay'), paused: __jhk.state.loopStats.value?.paused })`)) };
    });
    await timed('stop the cast → overlay gone, wallpaper plays again', async () => {
      await dash.ev(`document.querySelector('.cast-bar button').click()`);
      const off = await dash.until(`!document.querySelector('.cast-overlay') && !__jhk.state.loopStats.value?.paused && __jhk.state.loopStats.value?.fps > 0`, 8000);
      return off ? { detail: 'back to the wallpaper' } : { ok: false, reason: 'still casting / paused' };
    });
    await timed('study room: phone starts the timer → laptop shows the same countdown (within 1 s)', async () => {
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Fun/.test(b.textContent)).click()`);
      await ph.until(`!!document.querySelector('.pomo button')`, 4000);
      await ph.ev(`[...document.querySelectorAll('.pomo button')].find(b => /Start focus/.test(b.textContent)).click()`);
      await sleep(1500);
      const a = await ph.ev(`document.querySelector('.pomo-time')?.textContent`);
      const b = await dash.ev(`document.querySelector('.tab-body .pomo-time')?.textContent`);
      const sec = (t) => { const [m, s2] = String(t).split(':').map(Number); return m * 60 + s2; };
      return a && b && Math.abs(sec(a) - sec(b)) <= 1 && sec(a) < 25 * 60 ? { detail: `phone ${a} · laptop ${b}` } : { ok: false, reason: JSON.stringify({ a, b }) };
    });
    await timed('game night from the phone → scoreboard on the wall display, leader highlighted', async () => {
      for (const n of ['Asha', 'Dev']) { await typeInto(ph, '.score form input', n); await sleep(120); await ph.ev(`document.querySelector('.score form').requestSubmit()`); await sleep(250); }
      await ph.ev(`[...document.querySelectorAll('.players li')].find(li => /Dev/.test(li.textContent)).querySelector('.pm.plus').click()`);
      await sleep(400);
      await dash.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      const okW = await dash.until(`document.querySelector('.score-wall li.lead .sw-name')?.textContent === 'Dev' && !!document.querySelector('.pomo-wall .pomo-time')`, 6000);
      const over = await dash.ev(`document.querySelector('.panel').scrollHeight - innerHeight`);
      await shot(dash, 'wall');
      return okW && over <= 4 ? { detail: 'scoreboard + study-room timer on the wall, still fits 1080p' } : { ok: false, reason: JSON.stringify({ okW, over }) };
    });
    await timed('ink theme: paper background, ink text, serif clock; mirrored to the wall view', async () => {
      await dash.ev(`__jhk.setTheme('ink')`); await sleep(500);
      const r = await dash.ev(`({ t: document.documentElement.dataset.theme, bg: getComputedStyle(document.querySelector('.panel')).backgroundColor, ink: getComputedStyle(document.body).color,
        clock: getComputedStyle(document.querySelector('.clock-time')).fontFamily })`);
      await shot(dash, 'ink-wall');
      await dash.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
      await dash.ev(TAB('Home')); await sleep(400);
      await shot(dash, 'ink-laptop');
      await dash.ev(`__jhk.setTheme('night')`);
      const [R, G, B] = (r.bg.match(/\d+/g) || []).map(Number);
      return r.t === 'ink' && R > 200 && G > 190 && B > 170 && /Fraunces/.test(r.clock) ? { detail: `panel ${r.bg}, clock ${r.clock.split(',')[0]}` } : { ok: false, reason: JSON.stringify(r) };
    });
    check('no uncaught page errors (dashboard + phone)', dash.errors.length === 0 && ph.errors.length === 0, 'none', [...dash.errors, ...ph.errors].slice(0, 3).join(' | '));
  } finally { S.proc.kill(); }
}

/** A phone-sized Chrome that has joined and been approved, sitting on the room page. */
async function approvedPhoneBrowser(chromeBin, P, owner, name, role) {
  const c2 = await launch({ bin: chromeBin, port: await freePort(), origin: P });
  chromes.push(c2);
  const ph = await c2.attach((await c2.pageTargets())[0]);
  await ph.send('Page.enable');
  await ph.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await ph.send('Page.navigate', { url: `${P}/join?k=${ROOM_CODE}` });
  await ph.until(`!document.getElementById('v-ask').hidden`, 8000);
  await ph.ev(`document.getElementById('name').value = ${JSON.stringify(name)}; document.getElementById('v-ask').requestSubmit()`);
  await sleep(500);
  const a = await (await fetch(`${owner}/api/access`)).json();
  const d = a.devices.find((x) => x.name === name && x.status === 'pending');
  await fetch(`${owner}/api/devices/${d.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  await ph.until(`!document.getElementById('v-in').hidden`, 8000);
  await ph.send('Page.navigate', { url: `${P}/app/room.html` });
  await ph.until(`!!document.querySelector('.rp-tabs')`, 10000);
  return ph;
}

// =============================================================================== refinements: same Wi-Fi only, room code, open files / play links
async function sameWifiTests() {
  section('SAME WI-FI ONLY + ROOM CODE (internet link)');
  note('The laptop\'s public address is fixed to 203.0.113.1 for the test: phones from 203.0.113.x = same Wi-Fi,');
  note('198.51.100.7 = a phone on mobile data. Requests arrive the way cloudflared delivers them (127.0.0.1 + public Host + CF-Connecting-IP).');
  const { createNetGuard, prefixOf } = await import(pathToFileURL(path.join(ROOT, 'server', 'netguard.mjs')).href);
  await timed('room code rotates every 10 min; the previous code still works for 10 min, older ones don\'t', async () => {
    let t = 1_000_000; const kv = new Map();
    const g = createNetGuard({ kvGet: (k) => kv.get(k), kvSet: (k, v) => kv.set(k, v), lookup: false, now: () => t });
    const c1 = g.code(); t += 10 * 60000 + 1; g.rotate(); const c2 = g.code();
    const a = [g.codeOk(c1), g.codeOk(c2), g.codeOk('nope'), g.codeOk('')];
    t += 10 * 60000 + 1; g.rotate();
    const b = [g.codeOk(c1), g.codeOk(c2), g.codeOk(g.code())];
    const pf = [prefixOf('139.5.199.72') === prefixOf('139.5.199.70'), prefixOf('139.5.199.7') !== prefixOf('139.5.200.7'), prefixOf('2401:4900:1c2a:5::1') === prefixOf('2401:4900:1c2a:ffff::9')];
    return c1 !== c2 && a.join() === 'true,true,false,false' && b.join() === 'false,true,true' && pf.every(Boolean)
      ? { detail: 'old code valid one more period, then refused · /24 and /48 matching' } : { ok: false, reason: JSON.stringify({ a, b, pf }) };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-wifi-'));
  const fake = path.join(dir, 'cloudflared');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nsetTimeout(() => process.stderr.write('INF |  https://room-wifi-test.trycloudflare.com  |\\n'), 100);\nsetInterval(() => {}, 1e6);\nprocess.on('SIGTERM', () => process.exit(0));\n`);
  fs.chmodSync(fake, 0o755);
  const S = await startW4Server({ JHK_CLOUDFLARED: fake, JHK_LAPTOP_IP: '203.0.113.1' });
  const own = (p, body) => fetch(S.owner + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const net = (ip, method, p, body, extra = {}) => new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port: S.port, path: p, method, headers: { host: 'room-wifi-test.trycloudflare.com', 'cf-connecting-ip': ip, accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Linux; Android 14)', ...(body ? { 'content-type': 'application/json' } : {}), ...extra } }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* html */ } res({ status: r.statusCode, j, text: j ? null : d, cookie: (r.headers['set-cookie'] || [])[0]?.split(';')[0] }); });
    });
    rq.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    await own('/api/tunnel', { on: true });
    for (let i = 0; i < 30; i++) { if ((await own('/api/join')).source === 'tunnel') break; await sleep(100); }
    const WIFI = '203.0.113.42', CELL = '198.51.100.7';
    let cookie = '';
    await timed('joining needs the code from the QR: none / wrong → 403 "scan the QR"; with it → asked', async () => {
      const none = await net(WIFI, 'POST', '/api/join', { name: 'Ria' });
      const wrong = await net(WIFI, 'POST', '/api/join', { name: 'Ria', k: 'guess1' });
      const ok = await net(WIFI, 'POST', '/api/join', { name: 'Ria', k: ROOM_CODE });
      cookie = ok.cookie;
      const qr = (await own('/api/join')).url;
      return none.status === 403 && none.j.code === 'room-code' && wrong.status === 403 && ok.status === 200 && qr.endsWith(`/join?k=${ROOM_CODE}`)
        ? { detail: `no code → 403 · wrong → 403 · QR link (${qr.replace(/^https:\/\//, '')}) → join request` } : { ok: false, reason: JSON.stringify({ none, wrong: wrong.status, ok: ok.status, qr }) };
    });
    const id = (await own('/api/access')).devices.find((d) => d.name === 'Ria').id;
    await own(`/api/devices/${id}/approve`, { role: 'collaborator' });
    await timed('"Same Wi-Fi only" (default): phone on the room\'s network works; the same phone on mobile data is refused', async () => {
      const onWifi = await net(WIFI, 'GET', '/api/vitals', null, { cookie });
      const onCell = await net(CELL, 'GET', '/api/vitals', null, { cookie });
      const page = await net(CELL, 'GET', '/join', null, { accept: 'text/html' });
      const stranger = await net(CELL, 'POST', '/api/join', { name: 'X', k: ROOM_CODE });
      const st = (await own('/api/access')).net;
      const ok = st.mode === 'wifi' && onWifi.status === 200 && onCell.status === 403 && onCell.j.error === 'not-on-room-wifi' && page.status === 403 && /room's Wi-Fi/.test(page.text)
        && stranger.status === 403 && st.blocked[0]?.ip === CELL && st.blocked[0].prefix === '198.51.100.0/24' && st.room.includes('203.0.113.0/24');
      return ok ? { detail: `Wi-Fi 200 · mobile data 403 (+ friendly page) · owner sees refused ${CELL} (${st.blocked[0].prefix})` } : { ok: false, reason: JSON.stringify({ onWifi: onWifi.status, onCell, page: page.status, stranger: stranger.status, st }) };
    });
    await timed('"Trust this network" lets that network in; removing it locks it out again', async () => {
      await own('/api/netguard', { trust: '198.51.100.0/24' });
      const a = await net(CELL, 'GET', '/api/vitals', null, { cookie });
      await own('/api/netguard', { untrust: '198.51.100.0/24' });
      const b = await net(CELL, 'GET', '/api/vitals', null, { cookie });
      const bad = await fetch(`${S.owner}/api/netguard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trust: 'everything' }) });
      return a.status === 200 && b.status === 403 && bad.status === 400 ? { detail: 'trusted → 200 · removed → 403 · junk prefix → 400' } : { ok: false, reason: `${a.status} ${b.status} ${bad.status}` };
    });
    await timed('"Anywhere": approved people work from mobile data; strangers still need the QR code; only owners can switch', async () => {
      const notOwner = await net(WIFI, 'POST', '/api/netguard', { mode: 'anywhere' }, { cookie });
      await own('/api/netguard', { mode: 'anywhere' });
      const member = await net(CELL, 'GET', '/api/vitals', null, { cookie });
      const strangerNoCode = await net('192.0.2.5', 'POST', '/api/join', { name: 'Far' });
      const page = await net('192.0.2.5', 'GET', '/join', null, { accept: 'text/html' });
      await own('/api/netguard', { mode: 'wifi' });
      const back = await net(CELL, 'GET', '/api/vitals', null, { cookie });
      const audit = (await own('/api/access')).audit.filter((a) => a.action === 'who-can-connect').length;
      return notOwner.status === 403 && member.status === 200 && strangerNoCode.status === 403 && page.status === 200 && back.status === 403 && audit >= 2
        ? { detail: 'member on mobile data 200 · stranger without code 403 · back to Wi-Fi only → 403 · audited' } : { ok: false, reason: JSON.stringify({ notOwner: notOwner.status, member: member.status, strangerNoCode: strangerNoCode.status, page: page.status, back: back.status, audit }) };
    });
    await timed('the laptop itself is never affected (localhost)', async () => {
      const r = await fetch(`${S.owner}/api/vitals`);
      return r.ok ? { detail: '200' } : { ok: false, reason: String(r.status) };
    });
  } finally { S.proc.kill(); }
}

async function openOnLaptopTests(chromeBin) {
  section('REFINEMENTS · OPEN FILES + PLAY LINKS ON THE LAPTOP');
  await freeChromes();
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const S = await startW4Server();
  const L = `http://localhost:${S.port}`, P = `http://${ip}:${S.port}`;
  const shot = async (pg, name) => {
    const r = await pg.send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) { fs.writeFileSync(path.join(ROOT, `test-shot-open-${name}.png`), Buffer.from(r.result.data, 'base64')); note(`screenshot: test-shot-open-${name}.png`); }
  };
  try {
    // A friend's phone uploads a picture, a PDF, a note and a video, and queues a YouTube link.
    const friend = await approvedPhone(P, S.owner, 'Asha', 'collaborator');
    const put = (name, type, body) => fetch(`${P}/api/drops?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { method: 'PUT', headers: { cookie: friend.cookie, 'content-type': 'application/octet-stream' }, body }).then((r) => r.status);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 60 Td (Hostel notes) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    const codes = [
      await put('room-photo.png', 'image/png', fs.readFileSync(path.join(APP, 'public', 'icon-512.png'))),
      await put('notes.pdf', 'application/pdf', pdf),
      await put('shopping.txt', 'text/plain', 'milk\neggs\nbread'),
      await put('clip.mp4', 'video/mp4', fs.readFileSync(path.join(ROOT, 'samples', 'sample_720p30.mp4'))),
      await put('page.html', 'text/html', '<script>alert(1)</script>'),
      (await friend.req('/api/fun/queue', { url: 'https://youtu.be/aqz-KE-bpKQ' })).status,
    ];
    check('friend uploads 5 files + queues a video', codes.every((c) => c === 200), codes.join(','), codes.join(','));
    await timed('server: safe types open inline (sandboxed); HTML never inline; video supports seeking (Range)', async () => {
      const list = (await (await fetch(`${S.owner}/api/room`)).json()).drops;
      const by = (n) => list.find((d) => d.name === n).id;
      const h = async (n, extra = {}) => { const r = await fetch(`${S.owner}/api/drops/${by(n)}?inline=1`, { headers: extra }); await r.arrayBuffer(); return r; };
      const img = await h('room-photo.png'), html = await h('page.html'), vid = await h('clip.mp4', { range: 'bytes=0-99' }), pdfR = await h('notes.pdf');
      const ok = /^inline/.test(img.headers.get('content-disposition')) && /sandbox/.test(img.headers.get('content-security-policy') || '')
        && /^attachment/.test(html.headers.get('content-disposition')) && vid.status === 206 && /^bytes 0-99\//.test(vid.headers.get('content-range'))
        && /^inline/.test(pdfR.headers.get('content-disposition'));
      return ok ? { detail: 'png inline+sandbox · pdf inline · html → attachment · mp4 Range → 206' } : { ok: false, reason: JSON.stringify({ img: img.headers.get('content-disposition'), html: html.headers.get('content-disposition'), vid: [vid.status, vid.headers.get('content-range')] }) };
    });
    const { page: dash, ok } = await openApp(chromeBin, L);
    if (!ok) { fail('dashboard boots', 'did not boot'); return; }
    await dash.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await dash.ev(`__jhk.loadSamples()`, 60000);
    await dash.ev(`__jhk.start()`, 20000);
    await dash.until(`__jhk.state.layer.value === 'L1'`, 10000);
    await dash.ev(`__jhk.swap()`);
    await dash.ev(TAB('Room')); await sleep(400);
    const openFile = async (name) => {
      await dash.ev(`[...document.querySelectorAll('.drop-name')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
      await sleep(300);
    };
    const closeModal = () => dash.ev(`document.querySelector('.modal-x')?.click()`);
    await timed('click a picture → it opens on the laptop', async () => {
      await openFile('room-photo.png');
      const r = await dash.until(`document.querySelector('.viewer-body img')?.naturalWidth > 0`, 6000);
      await shot(dash, 'picture');
      await closeModal();
      return r ? { detail: 'image shown in the viewer' } : { ok: false, reason: 'no image' };
    });
    await timed('click a video → it plays on the laptop', async () => {
      await openFile('clip.mp4');
      const r = await dash.until(`(() => { const v = document.querySelector('.viewer-body video'); return v && v.readyState >= 2 && v.currentTime > 0.2; })()`, 8000);
      await closeModal();
      return r ? { detail: 'video playing in the viewer' } : { ok: false, reason: JSON.stringify(await dash.ev(`(() => { const v = document.querySelector('.viewer-body video'); return v && { rs: v.readyState, t: v.currentTime, err: v.error?.code }; })()`)) };
    });
    await timed('click a PDF → shown in the viewer; a text note → its contents', async () => {
      await openFile('notes.pdf');
      const pdfOk = await dash.until(`!!document.querySelector('.viewer-body iframe[src*="inline=1"]')`, 4000);
      await closeModal(); await sleep(200);
      await openFile('shopping.txt');
      const txt = await dash.until(`/milk\\neggs/.test(document.querySelector('.viewer-body pre')?.textContent || '')`, 4000);
      await closeModal();
      return pdfOk && txt ? { detail: 'pdf frame + text contents' } : { ok: false, reason: JSON.stringify({ pdfOk, txt }) };
    });
    await timed('owner taps "Wall" on the picture → it fills the wall screen', async () => {
      await dash.ev(`[...document.querySelectorAll('.drop-list li')].find(li => /room-photo/.test(li.textContent)).querySelector('.small-btn').click()`);
      const r = await dash.until(`document.querySelector('.cast-overlay img')?.naturalWidth > 0`, 6000);
      await dash.ev(`document.querySelector('.cast-bar button')?.click()`);
      await dash.until(`!document.querySelector('.cast-overlay')`, 4000);
      return r ? { detail: 'picture on the wall, then stopped' } : { ok: false, reason: 'not shown' };
    });
    await timed('queued YouTube link: click it → plays right on the laptop (not the wall)', async () => {
      await dash.ev(TAB('Fun')); await sleep(400);
      await dash.until(`/Big Buck Bunny|YouTube/.test(document.querySelector('.q-list')?.textContent || '')`, 6000);
      await dash.ev(`document.querySelector('.q-list .q-title').click()`);
      const r = await dash.until(`document.querySelector('.modal .viewer-body iframe')?.src.includes('youtube-nocookie.com/embed/aqz-KE-bpKQ')`, 5000);
      const notOnWall = await dash.ev(`!document.querySelector('.cast-overlay')`);
      await sleep(4000);
      await shot(dash, 'play-here');
      await closeModal();
      return r && notOnWall ? { detail: 'YouTube player in a window on the laptop' } : { ok: false, reason: JSON.stringify({ r, notOnWall }) };
    });
    check('no uncaught page errors', dash.errors.length === 0, 'none', dash.errors.slice(0, 3).join(' | '));
  } finally { S.proc.kill(); }
}

// =============================================================================== secure storage, roles, media remote
/** A tiny real JPEG with an EXIF block that contains a GPS tag (what phone cameras write). */
function jpegWithGps() {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')]);
  const exifBody = Buffer.from('Exif\0\0MM\0*GPSLatitude=12.9716N;GPSLongitude=77.5946E;Model=PhoneX', 'latin1');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exifBody.length + 2) >> 8, (exifBody.length + 2) & 0xff]), exifBody]);
  const rest = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x01]), Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.from('IMAGEDATA', 'latin1'), Buffer.from([0xff, 0xd9])]);
  return { file: Buffer.concat([soi, app0, app1, rest]), withoutExif: Buffer.concat([soi, app0, rest]) };
}

async function secureChainTests() {
  section('SECURE FILE CHAIN + ROLES + MEDIA REMOTE (server)');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-sec-'));
  // A stand-in for garcon-url-handler that only records which URLs it was asked to open.
  const openerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-open-'));
  const openerLog = path.join(openerDir, 'opened.txt');
  const opener = path.join(openerDir, 'opener');
  fs.writeFileSync(opener, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(openerLog)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  fs.chmodSync(opener, 0o755);
  const S = await startW4Server({ JHK_DATA: dataDir, JHK_OPENER: opener });
  const P = `http://${ip}:${S.port}`;
  const own = (p, body, method) => fetch(S.owner + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
  try {
    const asha = await approvedPhone(P, S.owner, 'Asha', 'collaborator');
    const dev = await approvedPhone(P, S.owner, 'Dev', 'collaborator');
    const put = (ph, name, type, body) => fetch(`${P}/api/drops?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { method: 'PUT', headers: { cookie: ph.cookie, 'content-type': 'application/octet-stream' }, body }).then((r) => r.json());
    await timed('photo upload: GPS / phone-model metadata removed before storing; picture data kept byte-for-byte', async () => {
      const { file, withoutExif } = jpegWithGps();
      const r = await put(asha, 'IMG_2041.jpg', 'image/jpeg', file);
      const back = Buffer.from(await (await fetch(`${S.owner}/api/drops/${r.id}`)).arrayBuffer());
      const ok = r.mime === 'image/jpeg' && r.scrubbed > 0 && !back.includes(Buffer.from('GPSLatitude')) && !back.includes(Buffer.from('Exif')) && back.equals(withoutExif);
      return ok ? { detail: `${r.scrubbed} bytes of EXIF removed (GPS, model); rest identical` } : { ok: false, reason: JSON.stringify({ r, hasGps: back.includes(Buffer.from('GPSLatitude')), same: back.equals(withoutExif) }) };
    });
    await timed('on disk: encrypted (AES-256), files 0600, folders 0700, key 0600; download decrypts exactly; Range works', async () => {
      const data = crypto.randomBytes(256 * 1024);
      data.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');            // looks like an MP4 → video/mp4
      const r = await put(dev, 'clip.mp4', 'video/mp4', data);
      const file = path.join(dataDir, 'drops', r.id);
      const disk = fs.readFileSync(file);
      const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
      const full = Buffer.from(await (await fetch(`${S.owner}/api/drops/${r.id}`)).arrayBuffer());
      const part = await fetch(`${S.owner}/api/drops/${r.id}?inline=1`, { headers: { range: 'bytes=1000-1999' } });
      const pb = Buffer.from(await part.arrayBuffer());
      const ok = !disk.includes(data.subarray(1000, 1064)) && disk.length === data.length && full.equals(data) && part.status === 206 && pb.equals(data.subarray(1000, 2000))
        && mode(file) === '600' && mode(path.join(dataDir, 'drops')) === '700' && mode(path.join(dataDir, 'keys')) === '700' && mode(path.join(dataDir, 'keys', 'drops.key')) === '600' && r.mime === 'video/mp4';
      return ok ? { detail: 'ciphertext on disk · 600/700/700/600 · full + Range(1000-1999) decrypt exactly · type from bytes: video/mp4' }
        : { ok: false, reason: JSON.stringify({ plainOnDisk: disk.includes(data.subarray(1000, 1064)), same: full.equals(data), part: part.status, modes: [mode(file), mode(path.join(dataDir, 'drops')), mode(path.join(dataDir, 'keys', 'drops.key'))], mime: r.mime }) };
    });
    await timed('type comes from the bytes: an HTML page uploaded as "image/png" is stored download-only', async () => {
      const r = await put(asha, 'cat.png', 'image/png', Buffer.from('<!doctype html><script>steal()</script>'));
      const h = await fetch(`${S.owner}/api/drops/${r.id}?inline=1`);
      await h.arrayBuffer();
      return r.mime === 'application/octet-stream' && /^attachment/.test(h.headers.get('content-disposition')) && h.headers.get('content-type') === 'application/octet-stream'
        ? { detail: 'stored as application/octet-stream → attachment, never shown inside the app' } : { ok: false, reason: JSON.stringify({ mime: r.mime, cd: h.headers.get('content-disposition') }) };
    });
    await timed('roles: owner promotes / demotes / kicks; their rights change at once', async () => {
      const idOf = async (n) => (await own('/api/access')).j.devices.find((d) => d.name === n).id;
      await own(`/api/devices/${await idOf('Dev')}/role`, { role: 'viewer' });
      const ro = await dev.req('/api/fun/game/add', { name: 'x' });
      await own(`/api/devices/${await idOf('Dev')}/role`, { role: 'owner' });
      const ownerNow = await dev.req('/api/access');
      const bad = await own(`/api/devices/${await idOf('Dev')}/role`, { role: 'king' });
      await own(`/api/devices/${await idOf('Dev')}/role`, { role: 'collaborator' });
      const kick = await own(`/api/devices/${await idOf('Asha')}/revoke`, {});
      const gone = await asha.req('/api/me');
      const audit = (await own('/api/access')).j.audit.map((a) => a.action);
      const ok = ro.status === 403 && ownerNow.status === 200 && bad.status === 400 && kick.status === 200 && gone.j.status === 'none' && audit.includes('role → viewer') && audit.includes('role → owner');
      return ok ? { detail: 'viewer → can\'t edit · owner → owner APIs · bad role → 400 · kicked → signed out · audited' } : { ok: false, reason: JSON.stringify({ ro: ro.status, ownerNow: ownerNow.status, bad: bad.status, kick: kick.status, gone: gone.j, audit }) };
    });
    await timed('anyone can step down (never up) or leave', async () => {
      const ria = await approvedPhone(P, S.owner, 'Ria', 'owner');
      const down = await ria.req('/api/me/role', { role: 'collaborator' });
      const me1 = await ria.req('/api/me');
      const up = await ria.req('/api/me/role', { role: 'owner' });
      const down2 = await ria.req('/api/me/role', { role: 'viewer' });
      const leave = await ria.req('/api/leave', {});
      const me2 = await ria.req('/api/me');
      const ok = down.status === 200 && me1.j.role === 'collaborator' && !me1.j.owner && up.status === 403 && down2.status === 200 && leave.status === 200 && me2.j.status === 'none';
      return ok ? { detail: 'owner → collaborator → viewer · raise self → 403 · leave → signed out' } : { ok: false, reason: JSON.stringify({ down: down.status, me1: me1.j, up: up.status, down2: down2.status, me2: me2.j }) };
    });
    await timed('cast from a phone: collaborator\'s video → request; approved → they (and owners) control it; others can\'t', async () => {
      const data = Buffer.alloc(4096); data.write('\x00\x00\x00\x18ftypmp42', 0, 'latin1');
      const up = await put(dev, 'party.mp4', 'video/mp4', data);
      const req = await dev.req(`/api/fun/cast/drop/${up.id}`, {});
      const f = (await own('/api/fun')).j;
      await own(`/api/fun/cast/${f.casts[0].id}/approve`, {});
      const wall = await yclient(S.owner, null, 'A');
      const devWs = await yclient(P, dev.cookie);
      const other = await approvedPhone(P, S.owner, 'Sam', 'collaborator');
      const otherWs = await yclient(P, other.cookie);
      devWs.send({ t: 'media', cmd: 'pause' }); devWs.send({ t: 'media', cmd: 'volume', arg: 30 });
      otherWs.send({ t: 'media', cmd: 'play' });
      wall.send({ t: 'media-state', s: { playing: false, t: 3.2, d: 60, vol: 30, muted: false, kind: 'video' } });
      await sleep(400);
      const got = wall.msgs.filter((m) => m.t === 'media').map((m) => `${m.cmd}${m.arg != null ? ':' + m.arg : ''}`);
      const st = devWs.msgs.filter((m) => m.t === 'media-state').at(-1)?.s;
      const casting = (await own('/api/fun')).j.casting;
      const otherStop = await other.req('/api/fun/cast/stop', {});
      const devStop = await dev.req('/api/fun/cast/stop', {});
      [wall, devWs, otherWs].forEach((c) => c.close());
      const ok = req.j.pending && casting?.kind === 'video' && casting.requestedBy === 'Dev' && got.join() === 'pause,volume:30' && st?.vol === 30 && st.t === 3.2 && otherStop.status === 403 && devStop.status === 200;
      return ok ? { detail: `wall got ${got.join(', ')} from the caster (Sam's "play" ignored) · state relayed · Sam can't stop, Dev can` } : { ok: false, reason: JSON.stringify({ req: req.j, casting, got, st, otherStop: otherStop.status, devStop: devStop.status }) };
    });
    await timed('"Open on PC": Netflix opens straight in Chrome on the laptop (no tap); other links ask the laptop; javascript: dropped', async () => {
      const lap = await yclient(S.owner, null, 'A');
      const ph = await yclient(P, dev.cookie);
      ph.send({ t: 'open-request', url: 'https://www.netflix.com/browse', title: 'Netflix' });
      ph.send({ t: 'open-request', url: 'https://example.com/page', title: 'Example' });
      ph.send({ t: 'open-request', url: 'javascript:alert(1)', title: 'x' });
      ph.send({ t: 'open-request', url: 'https://netflix.com.evil.example/x', title: 'fake' });
      await sleep(800);
      const openedNow = fs.existsSync(openerLog) ? fs.readFileSync(openerLog, 'utf8').trim().split('\n') : [];
      const notes = lap.msgs.filter((m) => m.t === 'opened');
      const asks = lap.msgs.filter((m) => m.t === 'open-request').map((m) => m.url);
      const acks = ph.msgs.filter((m) => m.t === 'remote-ack' && m.cmd === 'open');
      lap.close(); ph.close();
      const ok = openedNow.join() === 'https://www.netflix.com/browse' && notes.length === 1 && notes[0].by === 'Dev'
        && asks.join() === 'https://example.com/page,https://netflix.com.evil.example/x' && acks[0]?.direct === true && !acks[1]?.direct;
      return ok ? { detail: 'Netflix → opened in Chrome + laptop told · example.com and a look-alike host → one-tap prompt · javascript: dropped' } : { ok: false, reason: JSON.stringify({ openedNow, notes, asks, acks }) };
    });
  } finally { S.proc.kill(); }
  await timed('cookies over the https internet link are marked Secure (and HttpOnly, SameSite=Strict)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-sc-'));
    const fake = path.join(dir, 'cloudflared');
    fs.writeFileSync(fake, `#!/usr/bin/env node\nsetTimeout(() => process.stderr.write('https://secure-cookie-test.trycloudflare.com\\n'), 50);\nsetInterval(() => {}, 1e6);\nprocess.on('SIGTERM', () => process.exit(0));\n`);
    fs.chmodSync(fake, 0o755);
    const T = await startW4Server({ JHK_CLOUDFLARED: fake, JHK_LAPTOP_IP: '203.0.113.1' });
    try {
      const sc = await new Promise((res) => {
        const rq = http.request({ host: '127.0.0.1', port: T.port, path: '/api/join', method: 'POST', headers: { host: 'secure-cookie-test.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' } }, (r) => { r.resume(); res((r.headers['set-cookie'] || [])[0] || ''); });
        rq.end(JSON.stringify({ name: 'Net', k: ROOM_CODE }));
      });
      const lan = (await phone(`http://${outsideIp()}:${T.port}`).req('/api/join', { name: 'Lan' })).setCookie || '';
      return /; Secure/.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && !/Secure/.test(lan) ? { detail: 'https → Secure · plain Wi-Fi http → not (it would be dropped)' } : { ok: false, reason: JSON.stringify({ sc, lan }) };
    } finally { T.proc.kill(); }
  });
}

async function phoneCastTests(chromeBin) {
  section('PHONE: CAST FROM PHONE, MEDIA REMOTE, APPS, PEOPLE (new phone UI)');
  await freeChromes();
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const S = await startW4Server();
  const L = `http://localhost:${S.port}`, P = `http://${ip}:${S.port}`;
  const shot = async (pg, name) => {
    const r = await pg.send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) { fs.writeFileSync(path.join(ROOT, `test-shot-phone-${name}.png`), Buffer.from(r.result.data, 'base64')); note(`screenshot: test-shot-phone-${name}.png`); }
  };
  try {
    const { page: dash, ok } = await openApp(chromeBin, L);
    if (!ok) { fail('dashboard boots', 'did not boot'); return; }
    await dash.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await dash.ev(`__jhk.loadSamples()`, 60000);
    await dash.ev(`__jhk.start()`, 20000);
    await dash.until(`__jhk.state.layer.value === 'L1'`, 10000);
    await dash.ev(`__jhk.swap()`);
    const ph = await approvedPhoneBrowser(chromeBin, P, S.owner, 'Priya', 'owner');
    await sleep(800);
    await shot(ph, 'home');
    await timed('new phone home: header with name + role, cast card, door, apps, screen controls, 6-tab bar', async () => {
      const r = await ph.ev(`({ name: document.querySelector('.rp-name')?.textContent, role: document.querySelector('.rp-role .role-tag')?.textContent,
        tabs: [...document.querySelectorAll('.rp-tabs button')].map(b => b.textContent.trim()), cast: !!document.querySelector('.cfp-big'),
        apps: document.querySelectorAll('.apps .app').length, screens: !!document.querySelector('.remote-grid'), door: !!document.querySelector('.door-picker') })`);
      return r.name === 'Priya' && r.role === 'owner' && r.tabs.join() === 'Home,Share,Board,Fun,Tools,People' && r.cast && r.apps === 4 && r.screens && r.door ? { detail: `tabs ${r.tabs.join(' · ')}` } : { ok: false, reason: JSON.stringify(r) };
    });
    await timed('pick a video on the phone → it plays on the PC', async () => {
      const doc = await ph.send('DOM.getDocument', { depth: -1, pierce: true });
      const q = await ph.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.cfp input[type=file]' });
      await ph.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path.join(ROOT, 'samples', 'sample_720p30.mp4')] });
      const on = await dash.until(`(() => { const v = document.querySelector('.cast-overlay video'); return v && v.readyState >= 2 && !v.paused; })()`, 15000);
      const paused = await dash.ev(`__jhk.state.loopStats.value?.paused`);
      return on && paused ? { detail: 'phone video playing on the PC, wallpaper paused' } : { ok: false, reason: JSON.stringify({ on, paused }) };
    });
    await timed('phone remote: pause, volume 30 %, jump to 0:02, mute → the PC follows; the phone shows the state', async () => {
      await ph.until(`!!document.querySelector('.mremote .mr-b.big')`, 6000);
      await ph.until(`!/Waiting for the wall/.test(document.querySelector('.mremote')?.textContent || '')`, 6000);
      await ph.ev(`document.querySelector('.mr-b.big').click()`);
      const paused = await dash.until(`document.querySelector('.cast-overlay video')?.paused`, 4000);
      await ph.ev(`(() => { const r = document.querySelector('.mr-vol input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, '30'); r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await ph.ev(`(() => { const r = document.querySelector('.mr-time input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, '2'); r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(700);
      const v = await dash.ev(`(() => { const v = document.querySelector('.cast-overlay video'); return { vol: v.volume, t: v.currentTime }; })()`);
      await ph.ev(`document.querySelector('.mr-vol .icon-btn').click()`);
      const muted = await dash.until(`document.querySelector('.cast-overlay video')?.muted`, 3000);
      const phoneSees = await ph.until(`/muted/.test(document.querySelector('.mr-vol')?.textContent || '')`, 4000);
      await shot(ph, 'remote');
      return paused && Math.abs(v.vol - 0.3) < 0.01 && Math.abs(v.t - 2) < 0.6 && muted && phoneSees ? { detail: `paused · volume ${v.vol} · at ${v.t.toFixed(1)} s · muted (phone shows "muted")` } : { ok: false, reason: JSON.stringify({ paused, v, muted, phoneSees }) };
    });
    await timed('phone: Stop casting → the PC goes back to the wallpaper', async () => {
      await ph.ev(`document.querySelector('.mr-stop').click()`);
      const back = await dash.until(`!document.querySelector('.cast-overlay') && !__jhk.state.loopStats.value?.paused`, 6000);
      return back ? { detail: 'wallpaper playing again' } : { ok: false, reason: 'still casting' };
    });
    await timed('Apps: 1st phone request → one tap "Open" on the laptop opens the apps window; 2nd request opens there by itself', async () => {
      const dc = chromes[0];   // the dashboard's Chrome (first one launched in this section)
      const targets = async () => (await dc.pageTargets()).map((t) => t.url);
      await ph.ev(`[...document.querySelectorAll('button.app-main')].find(b => /Netflix/.test(b.textContent)).click()`);
      const banner = await dash.until(`/wants to open/.test(document.querySelector('.open-req')?.textContent || '')`, 5000);
      await dash.ev(`[...document.querySelectorAll('.open-req button')].find(b => b.textContent === 'Open').click()`);
      let t1 = [];
      for (let i = 0; i < 30; i++) { t1 = await targets(); if (t1.some((u) => u.includes('netflix.com'))) break; await sleep(300); }
      // second request: no tap on the laptop
      await ph.ev(`[...document.querySelectorAll('button.app-main')].find(b => /YouTube/.test(b.textContent)).click()`);
      let t2 = [];
      for (let i = 0; i < 40; i++) { t2 = await targets(); if (t2.some((u) => u.includes('youtube.com'))) break; await sleep(300); }
      const noBanner = await dash.ev(`!document.querySelector('.open-req')`);
      const sameWindow = t2.filter((u) => /netflix|youtube/.test(u)).length === 1;
      await dash.ev(TAB('Home')); await sleep(300);
      const tiles = await dash.ev(`[...document.querySelectorAll('.apps .app')].map(a => a.textContent.trim())`);
      await shot(dash, 'laptop-apps');
      return banner && t1.some((u) => u.includes('netflix.com')) && t2.some((u) => u.includes('youtube.com')) && noBanner && sameWindow && tiles.length === 4
        ? { detail: 'Netflix: prompt → tap → apps window · YouTube: opened in the same window with no tap · 4 tiles on Home' }
        : { ok: false, reason: JSON.stringify({ banner, t1, t2, noBanner, sameWindow, tiles }) };
    });
    await timed('reels: an Instagram reel link → upright player on the PC; the phone explains how to unmute', async () => {
      const r = await fetch(`${S.owner}/api/fun/cast`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.instagram.com/reel/C9xYz12AbCd/?igsh=MWxyZ' }) }).then((x) => x.json());
      const wall = await dash.until(`document.querySelector('.cast-reel iframe')?.src === 'https://www.instagram.com/reel/C9xYz12AbCd/embed/'`, 6000);
      const note = await ph.until(`/can't be paused from a phone/.test(document.querySelector('.mremote')?.textContent || '')`, 6000);
      await sleep(2500);
      await shot(dash, 'reel');
      await fetch(`${S.owner}/api/fun/cast/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return r.casting?.kind === 'reel' && r.casting.url === 'https://www.instagram.com/reel/C9xYz12AbCd/' && wall && note
        ? { detail: 'tracking (?igsh) removed · embed shown upright · phone shows the reel note' } : { ok: false, reason: JSON.stringify({ c: r.casting, wall, note }) };
    });
    await timed('phone: "How to cast a reel" help + Paste button; the build check sees no update needed', async () => {
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Home/.test(b.textContent)).click()`);
      await ph.until(`!!document.querySelector('.reel-help')`, 5000);
      const r = await ph.ev(`({ paste: [...document.querySelectorAll('.cfp button')].some(b => b.textContent === 'Paste'), help: /Copy link/.test(document.querySelector('.reel-help').textContent) })`);
      const builds = await dash.ev(`(async () => { const s = document.querySelector('script[type=module][src*="assets/"]').getAttribute('src'); return s; })()`);
      const pill = await dash.ev(`!!document.querySelector('.update-pill')`);
      return r.paste && r.help && !pill ? { detail: `Paste + help shown · laptop on the current build (${builds.split('/').pop()})` } : { ok: false, reason: JSON.stringify({ ...r, pill }) };
    });
    await timed('People tab: owner sees members; changes Sam to viewer; kicks him out', async () => {
      const sam = await approvedPhone(P, S.owner, 'Sam', 'collaborator');
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /People/.test(b.textContent)).click()`);
      await ph.until(`[...document.querySelectorAll('.person')].some(p => /Sam/.test(p.textContent))`, 6000);
      await shot(ph, 'people');
      await ph.ev(`(() => { const sel = [...document.querySelectorAll('.person')].find(p => /Sam/.test(p.textContent)).querySelector('select'); sel.value = 'viewer'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(500);
      const role = (await sam.req('/api/me')).j.role;
      await ph.ev(`[...document.querySelectorAll('.person')].find(p => /Sam/.test(p.textContent)).querySelector('.icon-btn.danger').click()`);
      await sleep(500);
      const st = (await sam.req('/api/me')).j.status;
      return role === 'viewer' && st === 'none' ? { detail: 'Sam → viewer → kicked out' } : { ok: false, reason: JSON.stringify({ role, st }) };
    });
    await timed('People tab: the owner steps down to collaborator (owner tools disappear), then leaves', async () => {
      await ph.ev(`[...document.querySelectorAll('.me-actions button')].find(b => /collaborator/.test(b.textContent)).click()`);
      const down = await ph.until(`document.querySelector('.rp-role .role-tag')?.textContent === 'collaborator' && !document.querySelector('.person')`, 15000);
      await ph.ev(`[...document.querySelectorAll('.me-actions button')].find(b => /Leave/.test(b.textContent)).click()`);
      await ph.ev(`[...document.querySelectorAll('.me-actions button')].find(b => /Yes, leave/.test(b.textContent)).click()`);
      const left = await ph.until(`location.pathname === '/join'`, 8000);
      return down && left ? { detail: 'stepped down → member list gone → left → back on /join' } : { ok: false, reason: JSON.stringify({ down, left, role: await ph.ev(`document.querySelector('.rp-role')?.textContent`).catch(() => '?') }) };
    });
    check('no uncaught page errors (laptop + phone)', dash.errors.length === 0 && ph.errors.length === 0, 'none', [...dash.errors, ...ph.errors].slice(0, 3).join(' | '));
  } finally { S.proc.kill(); }
}

// =============================================================================== phone remote for Netflix / YouTube (extension)
// A real Chromium loads extension/ (Jharokha Remote). "www.youtube.com" is mapped to a local https stand-in page, so the
// content script and the page helper run exactly as they would on the real site. A phone drives it through the server.
async function appRemoteTests(chromeBin) {
  section('PHONE REMOTE FOR STREAMING TABS (Jharokha Remote extension, fake YouTube over https)');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-ext-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(work, 'k.pem'), '-out', path.join(work, 'c.pem'), '-days', '2', '-subj', '/CN=www.youtube.com'], { stdio: 'ignore' });
  const https = await import('node:https');
  const mp4 = fs.readFileSync(path.join(ROOT, 'samples', 'sample_720p30.mp4'));
  const HOME = `<!doctype html><title>Fake Tube - YouTube</title><style>body{margin:0;font:16px sans-serif;background:#fff}.row{display:flex;gap:20px;padding:20px}button{width:160px;height:90px}input{margin:20px;width:300px;height:30px}</style>
    <form action="/results"><input id="q" name="search_query" type="search" aria-label="Search"></form>
    <div class="row"><button id="b1" onclick="hits.push('b1')">One</button><button id="b2" onclick="hits.push('b2')">Two</button><button id="b3" onclick="hits.push('b3')">Three</button></div>
    <script>window.hits = [];</script>`;
  const WATCH = `<!doctype html><title>Cat video - YouTube</title><style>body{margin:0;background:#000}video{position:fixed;inset:0;width:100vw;height:100vh}.ytp-skip-ad-button{position:fixed;right:30px;bottom:90px;z-index:5;width:140px;height:50px}</style>
    <div id="movie_player"></div><video id="v" src="/v.mp4" loop muted autoplay playsinline></video>
    <button class="ytp-skip-ad-button" onclick="hits.push('skip'); this.remove()">Skip ad</button>
    <script>window.hits = []; window.ytCalls = []; const v = document.getElementById('v'), p = document.getElementById('movie_player');
      p.playVideo = () => { ytCalls.push('play'); v.play(); }; p.pauseVideo = () => { ytCalls.push('pause'); v.pause(); };
      p.seekTo = (s) => { ytCalls.push('seek'); v.currentTime = s; }; p.setVolume = (x) => { ytCalls.push('vol:' + x); v.volume = x / 100; };
      p.mute = () => { v.muted = true; }; p.unMute = () => { v.muted = false; };</script>`;
  const fake = https.createServer({ key: fs.readFileSync(path.join(work, 'k.pem')), cert: fs.readFileSync(path.join(work, 'c.pem')) }, (rq, rs) => {
    const u = new URL(rq.url, 'https://www.youtube.com');
    if (u.pathname === '/v.mp4') { rs.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4.length }); return rs.end(mp4); }
    rs.writeHead(200, { 'content-type': 'text/html' });
    rs.end(u.pathname === '/watch' ? WATCH : u.pathname === '/results' ? `<!doctype html><title>${u.searchParams.get('search_query')} - YouTube</title><p>results</p>` : HOME);
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = fake.address().port;
  const S = await startW4Server({});
  const ext = path.join(work, 'ext');
  fs.cpSync(path.join(ROOT, 'extension'), ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'config.json'), JSON.stringify({ server: `ws://localhost:${S.port}/ws` }));
  const P = `http://${ip}:${S.port}`;
  let ph = null;
  try {
    const dev = await approvedPhone(P, S.owner, 'Dev', 'collaborator');
    const view = await approvedPhone(P, S.owner, 'Vee', 'viewer');
    const ws = await yclient(P, dev.cookie);
    const c = await launch({ bin: chromeBin, port: await freePort(), origin: S.owner, extraArgs: [
      `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${fakePort}`, '--ignore-certificate-errors'] });
    chromes.push(c);
    const lastState = () => ws.msgs.filter((m) => m.t === 'app-state').at(-1)?.s;
    const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(100); } return null; };
    let tab = null;
    const page = async () => {
      if (tab) return tab;
      const t = await waitForTarget(c, "www.youtube.com");
      tab = await c.attach(t);
      return tab;
    };

    await timed('the extension connects to the server by itself (phones see "remote helper on")', async () => {
      const on = await waitFor(() => ws.msgs.some((m) => m.t === 'app-helper' && m.on), 10000);
      return on ? { detail: 'app-helper: on' } : { ok: false, reason: JSON.stringify(ws.msgs.filter((m) => m.t === 'app-helper')) };
    });
    await timed('phone taps YouTube → it opens in its own full-screen window on the PC; the tab reports back', async () => {
      ws.send({ t: 'open-request', url: 'https://www.youtube.com/', title: 'YouTube' });
      const s = await waitFor(() => lastState()?.site === 'youtube.com' && lastState());
      const ack = ws.msgs.find((m) => m.t === 'remote-ack' && m.cmd === 'open');
      const wins = await (await page()).ev(`({ w: innerWidth, h: innerHeight })`);
      return s && ack?.direct && s.tv ? { detail: `"${s.title}" · ack direct · tv tab · ${wins.w}×${wins.h}` } : { ok: false, reason: JSON.stringify({ s, ack }) };
    });
    await timed('touchpad: move the pointer onto a button and tap → the real button is clicked', async () => {
      const t = await page();
      const r = await t.ev(`(() => { const b = document.getElementById('b1').getBoundingClientRect(); return { x: b.left + b.width / 2 - innerWidth / 2, y: b.top + b.height / 2 - innerHeight / 2 }; })()`);
      ws.send({ t: 'app', cmd: 'move', arg: { dx: r.x, dy: r.y } });
      await sleep(200);
      ws.send({ t: 'app', cmd: 'click' });
      const ok = await t.until(`hits.join() === 'b1'`, 4000);
      return ok ? { detail: 'pointer moved by the phone, button "One" clicked' } : { ok: false, reason: await t.ev('hits.join()') };
    });
    await timed('D-pad: ▶ moves the highlight to the next button, OK presses it (twice)', async () => {
      const t = await page();
      for (const _ of [1, 2]) { ws.send({ t: 'app', cmd: 'nav', arg: 'right' }); await sleep(150); ws.send({ t: 'app', cmd: 'ok' }); await sleep(250); }
      const ok = await t.until(`hits.join() === 'b1,b2,b3'`, 4000);
      return ok ? { detail: 'One → Two → Three' } : { ok: false, reason: await t.ev('hits.join()') };
    });
    await timed('typing: select the search box with the pointer, type on the phone → text appears in the box', async () => {
      const t = await page();
      const r = await t.ev(`(() => { const b = document.getElementById('q').getBoundingClientRect(); const c = document.getElementById('b3').getBoundingClientRect(); return { x: (b.left + 40) - (c.left + c.width / 2), y: (b.top + b.height / 2) - (c.top + c.height / 2) }; })()`);
      ws.send({ t: 'app', cmd: 'move', arg: { dx: r.x, dy: r.y } }); await sleep(150);
      ws.send({ t: 'app', cmd: 'click' }); await sleep(300);
      ws.send({ t: 'app', cmd: 'type', arg: { text: 'lofi beats', enter: false } });
      const ok = await t.until(`document.getElementById('q').value === 'lofi beats'`, 4000);
      const typing = await waitFor(() => lastState()?.typing, 4000);
      return ok && typing ? { detail: 'box shows "lofi beats" · phone told a text box is focused' } : { ok: false, reason: JSON.stringify({ v: await t.ev(`document.getElementById('q').value`), typing: lastState()?.typing }) };
    });
    await timed('"Search YouTube" from the phone opens the results page', async () => {
      const t = await page();
      ws.send({ t: 'app', cmd: 'search', arg: 'cat videos' });
      const ok = await t.until(`location.pathname === '/results' && new URLSearchParams(location.search).get('search_query') === 'cat videos'`, 6000);
      return ok ? { detail: '/results?search_query=cat videos' } : { ok: false, reason: await t.ev('location.href') };
    });
    await timed('player: play/pause, volume, seek go through the site\'s own player; state comes back to the phone', async () => {
      ws.send({ t: 'open-request', url: 'https://www.youtube.com/watch?v=abc', title: 'YouTube' });
      const t = await page();
      await t.until(`location.pathname === '/watch' && !!window.ytCalls && document.getElementById('v').readyState > 2`, 8000);
      const st0 = await waitFor(() => lastState()?.player && lastState()?.v?.playing && lastState(), 6000);
      ws.send({ t: 'app', cmd: 'toggle' }); await sleep(400);
      ws.send({ t: 'app', cmd: 'volume', arg: 30 }); await sleep(200);
      ws.send({ t: 'app', cmd: 'seek', arg: 2 }); await sleep(200);
      ws.send({ t: 'app', cmd: 'nav', arg: 'up' }); await sleep(300);      // on the player: ▲ = volume up
      const calls = await t.ev('ytCalls.join()');
      const st = await waitFor(() => lastState()?.v && !lastState().v.playing && lastState().v.vol === 40 && lastState(), 4000);
      const ok = st0 && calls === 'pause,vol:30,seek,vol:40' && st;
      return ok ? { detail: `calls ${calls} · phone sees paused, volume 40` } : { ok: false, reason: JSON.stringify({ st0: !!st0, calls, s: lastState() }) };
    });
    await timed('"Skip ad" shows on the phone when the page has one, and the phone can press it', async () => {
      const t = await page();
      const s = await waitFor(() => lastState()?.skip && lastState(), 4000);
      ws.send({ t: 'app', cmd: 'skip' });
      const ok = await t.until(`hits.includes('skip')`, 3000);
      const gone = await waitFor(() => !lastState()?.skip, 4000);
      return s && ok && gone ? { detail: `phone saw "${s.skip}" → pressed → gone` } : { ok: false, reason: JSON.stringify({ s: lastState(), ok }) };
    });
    await timed('safety: a viewer can\'t control it; bad commands and fake helpers are ignored', async () => {
      const t = await page();
      const before = await t.ev('ytCalls.length');
      const vws = await yclient(P, view.cookie);
      vws.send({ t: 'app', cmd: 'toggle' });
      ws.send({ t: 'app', cmd: 'nav', arg: 'sideways' });
      ws.send({ t: 'app', cmd: 'eval', arg: 'alert(1)' });
      ws.send({ t: 'iam', role: 'X' });                                    // a phone pretending to be the extension
      ws.send({ t: 'app-state', s: { site: 'evil.example', title: 'fake' } });
      await sleep(600);
      const after = await t.ev('ytCalls.length');
      const vAck = vws.msgs.find((m) => m.t === 'remote-ack' && m.cmd === 'app');
      const fooled = vws.msgs.some((m) => m.t === 'app-state' && m.s?.site === 'evil.example');
      vws.close();
      return before === after && vAck?.error === 'read-only' && !fooled ? { detail: 'viewer → read-only · unknown commands dropped · phone can\'t pose as the helper' } : { ok: false, reason: JSON.stringify({ before, after, vAck, fooled }) };
    });
    await timed('phone page: the Remote card shows what\'s playing; its buttons drive the PC', async () => {
      ph = await approvedPhoneBrowser(chromeBin, P, S.owner, 'Pia', 'collaborator');
      const shown = await ph.until(`/Cat video/.test(document.querySelector('.aremote')?.textContent || '')`, 8000);
      const t = await page();
      const n0 = await t.ev('ytCalls.length');
      await ph.ev(`document.querySelector('.aremote .mr-b.big').click()`);
      const played = await t.until(`ytCalls.length > ${n0} && ytCalls.at(-1) === 'play'`, 4000);
      await shotPng(ph, 'remote-phone');
      await ph.ev(`[...document.querySelectorAll('.ar-modes button')].find(b => /Touchpad/.test(b.textContent)).click()`);
      await sleep(200);
      const pad = await ph.ev(`!!document.querySelector('.tpad')`);
      await shotPng(ph, 'remote-touchpad');
      await shotPng(t, 'remote-pc');
      return shown && played && pad ? { detail: 'title shown · ▶ on the phone → play on the PC · touchpad mode' } : { ok: false, reason: JSON.stringify({ shown, played, pad }) };
    });
    await timed('close from the phone: the PC window closes and the Remote card goes away', async () => {
      ws.send({ t: 'app', cmd: 'close' });
      const gone = await waitFor(() => ws.msgs.filter((m) => m.t === 'app-state').at(-1)?.s === null, 5000);
      const left = (await c.pageTargets()).filter((x) => /youtube/.test(x.url)).length;
      const card = ph ? await ph.until(`!document.querySelector('.aremote')`, 4000) : false;
      return gone && left === 0 && card ? { detail: 'window closed · state cleared on every phone' } : { ok: false, reason: JSON.stringify({ gone: !!gone, left, card }) };
    });
    ws.close();
  } finally { S.proc.kill(); fake.close(); }
}
async function waitForTarget(c, host, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = (await c.pageTargets()).find((x) => x.url.includes(host)); if (t) return t; await sleep(150); }
  throw new Error(`no tab for ${host}`);
}
async function shotPng(pg, name) {
  const r = await pg.send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { fs.writeFileSync(path.join(ROOT, `test-shot-${name}.png`), Buffer.from(r.result.data, 'base64')); note(`screenshot: test-shot-${name}.png`); }
}

// =============================================================================== Week 7 · utilities
async function week7ServerTests() {
  section('WEEK 7 · UTILITIES SERVER: polls, laundry timers, Split & Settle (UPI), sunrise alarm');
  const T = await import(pathToFileURL(path.join(ROOT, 'server', 'tools.mjs')).href);
  await timed('money maths: equal split adds up to the paisa; fewest transfers; rupee parsing; UPI link', async () => {
    const sp = T.splitEqual(1000, 3);
    const st = T.settleUp({ a: 200, b: -100, c: -100 });
    const st2 = T.settleUp({ a: 150, b: 50, c: -120, d: -80 });
    const ok2 = st2.reduce((x, t) => x + t.amount, 0) === 200 && st2.length <= 3;
    const pz = [T.toPaise('240'), T.toPaise('99.5'), T.toPaise('1,250.75'), T.toPaise('0'), T.toPaise('abc'), T.toPaise('1.234'), T.toPaise('20000000')];
    const link = T.upiLink('asha.k@okaxis', 'Asha K', 12050, 'Room split');
    const u = new URL(link.replace('upi://', 'https://x/'));
    const vpas = ['asha.k@okaxis', 'name@ybl', 'bad', 'a@b', 'x y@okaxis'].map((v) => T.VPA.test(v));
    const ok = sp.join() === '334,333,333' && st.length === 2 && st.every((t) => t.to === 'a' && t.amount === 100) && ok2
      && pz.join() === '24000,9950,125075,,,,' && link.startsWith('upi://pay?') && u.searchParams.get('pa') === 'asha.k@okaxis' && u.searchParams.get('am') === '120.50' && u.searchParams.get('cu') === 'INR' && !link.includes('+')
      && vpas.join() === 'true,true,false,false,false';
    return ok ? { detail: `₹10 ÷ 3 = ${sp.join('/')} paise · ${link}` } : { ok: false, reason: JSON.stringify({ sp, st, st2, pz, link, vpas }) };
  });
  const ip = outsideIp();
  if (!ip) { skip('API checks', 'no non-loopback IPv4 address'); return; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-w7-'));
  let S = await startW4Server({ JHK_DATA: dataDir, JHK_MINUTE_MS: '400', JHK_TOOLS_TICK_MS: '100' });     // a "minute" is 0.4 s here
  const P = () => `http://${ip}:${S.port}`;
  const own = (p, body, method) => fetch(S.owner + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
  try {
    const asha = await approvedPhone(P(), S.owner, 'Asha', 'collaborator');
    const dev = await approvedPhone(P(), S.owner, 'Dev', 'collaborator');
    const vik = await approvedPhone(P(), S.owner, 'Vik', 'viewer');
    const key = async (ph) => (await ph.req('/api/room')).j.you;
    const A = await key(asha), D = await key(dev), V = await key(vik);
    await timed('polls: ask, vote (one each, tap again to undo), viewer can\'t vote, only the asker closes, auto-close', async () => {
      const mk = await asha.req('/api/tools/poll', { q: 'Dinner?', options: ['Maggi', 'Biryani', 'Maggi', ''] });
      const one = await asha.req('/api/tools/poll', { q: 'x', options: ['only'] });
      const pid = mk.j.poll.id, [o1, o2] = mk.j.poll.options.map((o) => o.id);
      await asha.req(`/api/tools/poll/${pid}/vote`, { option: o1 });
      await dev.req(`/api/tools/poll/${pid}/vote`, { option: o1 });
      await dev.req(`/api/tools/poll/${pid}/vote`, { option: o2 });              // changes Dev's vote
      const vv = await vik.req(`/api/tools/poll/${pid}/vote`, { option: o2 });
      const cl = await dev.req(`/api/tools/poll/${pid}/close`, {});
      const p1 = (await own('/api/tools')).j.polls.find((p) => p.id === pid);
      const auto = await asha.req('/api/tools/poll', { q: 'Movie?', options: ['A', 'B'], minutes: 1 });
      await sleep(900);
      const p2 = (await own('/api/tools')).j.polls.find((p) => p.id === auto.j.poll.id);
      const ok = mk.status === 200 && mk.j.poll.options.length === 2 && one.status === 400 && vv.status === 403 && cl.status === 403
        && p1.options[0].votes.join() === A && p1.options[1].votes.join() === D && p2.closed;
      return ok ? { detail: 'duplicate/empty choices dropped · 1 vote each · viewer 403 · Dev can\'t close Asha\'s poll · closes on time' } : { ok: false, reason: JSON.stringify({ mk: mk.status, one: one.status, vv: vv.status, cl: cl.status, p1, p2 }) };
    });
    await timed('laundry timer: everyone gets a "done" ding when it ends; only the starter cancels a running one', async () => {
      const ws = await yclient(P(), vik.cookie);
      const t1 = await asha.req('/api/tools/timer', { label: 'Washer', minutes: 1 });
      const t2 = await asha.req('/api/tools/timer', { label: 'Dryer', minutes: 60 });
      const bad = await asha.req('/api/tools/timer', { label: 'x', minutes: 999 });
      const devCancel = await dev.req(`/api/tools/timer/${t2.j.timer.id}`, undefined, 'DELETE');
      await sleep(900);
      const d = ws.msgs.find((m) => m.t === 'tools-ding');
      const tm = (await own('/api/tools')).j.timers;
      const mine = await asha.req(`/api/tools/timer/${t2.j.timer.id}`, undefined, 'DELETE');
      ws.close();
      const ok = t1.status === 200 && bad.status === 400 && devCancel.status === 403 && d?.label === 'Washer' && d.by === 'Asha' && tm.find((x) => x.label === 'Washer')?.done && mine.status === 200;
      return ok ? { detail: 'Washer → ding to a viewer\'s phone · 999 min refused · Dev can\'t cancel Asha\'s Dryer, Asha can' } : { ok: false, reason: JSON.stringify({ t1: t1.status, bad: bad.status, devCancel: devCancel.status, d, tm }) };
    });
    await timed('Split & Settle: ₹300 split 3 ways → Dev and Vik owe Asha ₹100 each, with a UPI pay link', async () => {
      const badUpi = await asha.req('/api/tools/upi', { vpa: 'not-an-id' });
      const up = await asha.req('/api/tools/upi', { vpa: 'asha.k@okaxis' });
      const ex = await asha.req('/api/tools/expense', { what: 'Groceries', amount: '300', split: [A, D, V] });
      const badAmt = await asha.req('/api/tools/expense', { what: 'x', amount: '-5' });
      const stranger = await asha.req('/api/tools/expense', { what: 'x', amount: '5', paidBy: 'nobody' });
      const m = (await dev.req('/api/tools')).j.money;
      const devT = m.transfers.find((t) => t.from === D);
      const ok = badUpi.status === 400 && up.status === 200 && ex.status === 200 && badAmt.status === 400 && stranger.status === 400
        && m.total === 30000 && m.transfers.length === 2 && devT.to === A && devT.amount === 10000 && /^upi:\/\/pay\?pa=asha\.k%40okaxis&pn=Asha&am=100\.00&cu=INR/.test(devT.upi);
      return ok ? { detail: `${devT.fromName} → ${devT.toName} ₹100 · ${devT.upi}` } : { ok: false, reason: JSON.stringify({ badUpi: badUpi.status, up: up.status, ex: ex.status, badAmt: badAmt.status, stranger: stranger.status, m }) };
    });
    await timed('Split & Settle: Dev pays → "I paid" settles him; Vik (viewer) can\'t add; Dev can\'t delete Asha\'s entry', async () => {
      const paid = await dev.req('/api/tools/settle', { to: A, amount: '100' });
      const forge = await dev.req('/api/tools/settle', { from: V, to: A, amount: '100' });  // Dev can't say Vik paid
      const vAdd = await vik.req('/api/tools/expense', { what: 'x', amount: '10' });
      const t = (await own('/api/tools')).j;
      const exp = t.expenses.find((e) => e.kind === 'expense');
      const del = await dev.req(`/api/tools/expense/${exp.id}`, undefined, 'DELETE');
      const clr = await own('/api/tools/clear', {});
      const ok = paid.status === 200 && forge.status === 403 && vAdd.status === 403 && del.status === 403 && t.money.transfers.length === 1 && t.money.transfers[0].from === V && t.money.net[D] === 0 && clr.status === 400;
      return ok ? { detail: 'Dev square · only Vik → Asha ₹100 left · forged settle 403 · clear refused while someone owes' } : { ok: false, reason: JSON.stringify({ paid: paid.status, forge: forge.status, vAdd: vAdd.status, del: del.status, clr: clr.status, money: t.money }) };
    });
    await timed('sunrise alarm: only owners set it (time/days checked); any member can press "I\'m up"', async () => {
      const no = await asha.req('/api/tools/alarm', { on: true, time: '06:30' });
      const yes = await own('/api/tools/alarm', { on: true, time: '06:30', days: [1, 2, 9], rampMin: 20 });
      const badT = await own('/api/tools/alarm', { time: '25:99' });
      const up = await vik.req('/api/tools/alarm/dismiss', {});
      const a = (await own('/api/tools')).j.alarm;
      const ok = no.status === 403 && yes.status === 200 && a.time === '06:30' && a.days.join() === '1,2' && a.rampMin === 20 && badT.j.alarm.time === '06:30' && up.status === 200 && a.dismissedAt > 0;
      return ok ? { detail: 'collaborator 403 · 06:30 Mon+Tue, 20-min sunrise · bad time ignored · viewer dismissed' } : { ok: false, reason: JSON.stringify({ no: no.status, yes: yes.status, a }) };
    });
    await timed('utilities survive a server restart (saved to SQLite on shutdown)', async () => {
      const before = (await own('/api/tools')).j;
      S.proc.kill('SIGTERM');
      await new Promise((r) => S.proc.once('exit', r));
      S = await startW4Server({ JHK_DATA: dataDir, JHK_MINUTE_MS: '400', JHK_TOOLS_TICK_MS: '100' });
      const after = (await own('/api/tools')).j;
      const ok = after.polls.length === before.polls.length && after.upi[A] === 'asha.k@okaxis' && after.expenses.length === before.expenses.length && after.alarm.time === '06:30';
      return ok ? { detail: `${after.polls.length} polls · ${after.expenses.length} split entries · UPI ID · alarm kept` } : { ok: false, reason: JSON.stringify({ before: before.polls.length, after }) };
    });
  } finally { S.proc.kill(); }
}

async function week7BrowserTests(chromeBin) {
  await freeChromes();
  section('WEEK 7 · UTILITIES ON SCREEN (Tools tab, phone, wall timers + poll, sunrise, showcase)');
  const ip = outsideIp();
  if (!ip) { skip('whole section', 'no non-loopback IPv4 address'); return; }
  const S = await startW4Server({ JHK_MINUTE_MS: '1000', JHK_TOOLS_TICK_MS: '200' });
  const L = `http://localhost:${S.port}`, P = `http://${ip}:${S.port}`;
  const own = (p, body) => fetch(S.owner + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
  const typeInto = (pg, sel, val) => pg.ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(val)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  try {
    const { page: dash, ok } = await openApp(chromeBin, L, { extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    check('dashboard boots', ok, '', 'did not boot', null, dash.errors.join('\n'));
    if (!ok) return;
    await dash.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await dash.ev(`__jhk.loadSamples()`, 60000);
    await dash.ev(`__jhk.start()`, 20000);
    await dash.until(`__jhk.state.layer.value === 'L1' && __jhk.state.loopStats.value?.fps > 0`, 10000);
    await shotPng(dash, 'week7-layer1-swap');
    await timed('Layer 1 (one screen): the bottom button opens the dashboard', async () => {
      const t = await dash.ev(`document.querySelector('.l1-swap')?.textContent`);
      await dash.ev(`document.querySelector('.l1-swap').click()`);
      const open = await dash.until(`__jhk.state.overlayOpen.value === true`, 3000);
      return t && open ? { detail: `"${t}" → dashboard over the wallpaper` } : { ok: false, reason: JSON.stringify({ t, open }) };
    });
    const ph = await approvedPhoneBrowser(chromeBin, P, S.owner, 'Asha', 'collaborator');
    await timed('phone Tools tab: ask a poll → the laptop Tools tab shows it; a vote from the laptop updates the phone', async () => {
      await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Tools/.test(b.textContent)).click()`);
      await ph.until(`!!document.querySelector('.tools-polls')`, 5000);
      await ph.ev(`[...document.querySelectorAll('.tools-polls button')].find(b => /New poll/.test(b.textContent)).click()`);
      await sleep(150);
      const ins = '.poll-new input';
      await ph.ev(`(() => { const i = document.querySelectorAll(${JSON.stringify(ins)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        [['Dinner tonight?', 0], ['Maggi', 1], ['Biryani', 2]].forEach(([v, n]) => { set.call(i[n], v); i[n].dispatchEvent(new Event('input', { bubbles: true })); }); })()`);
      await sleep(150);
      await ph.ev(`document.querySelector('.poll-new').requestSubmit()`);
      await dash.ev(TAB('Tools'));
      const seen = await dash.until(`/Dinner tonight\\?/.test(document.querySelector('.tools-polls')?.textContent || '')`, 5000);
      await dash.ev(`[...document.querySelectorAll('.poll-opt')].find(b => /Biryani/.test(b.textContent)).click()`);
      const voted = await ph.until(`/1 vote/.test(document.querySelector('.poll .poll-q')?.textContent || '')`, 5000);
      return seen && voted ? { detail: 'poll on the laptop · laptop vote counted on the phone' } : { ok: false, reason: JSON.stringify({ seen, voted }) };
    });
    await timed('phone: start a laundry timer → wall shows it counting down → done → chime banner on the phone', async () => {
      await ph.ev(`[...document.querySelectorAll('.tools-timers form input')][0].focus()`);
      await typeInto(ph, '.tools-timers form input', 'Washer 2');
      await typeInto(ph, '.tools-timers form input.num', '2');
      await ph.ev(`document.querySelector('.tools-timers form').requestSubmit()`);
      const row = await dash.until(`/Washer 2/.test(document.querySelector('.tools-timers')?.textContent || '')`, 4000);
      const done = await ph.until(`/Washer 2.*is done/.test(document.querySelector('.banner.ding')?.textContent || '')`, 6000);
      return row && done ? { detail: 'running on the laptop · "Washer 2 is done" on the phone' } : { ok: false, reason: JSON.stringify({ row, done }) };
    });
    await timed('phone: add an expense in Split & Settle (new member appears live) → laptop sees who owes what', async () => {
      await approvedPhone(P, S.owner, 'Dev', 'collaborator');
      const devChip = await ph.until(`[...document.querySelectorAll('.split-add .chip')].some(c => c.textContent === 'Dev')`, 4000);
      await typeInto(ph, '.split-add input', 'Groceries');
      await typeInto(ph, '.split-add input.num', '240');
      await ph.ev(`document.querySelector('.split-add').requestSubmit()`);
      const seen = await dash.until(`/₹240/.test(document.querySelector('.tools-split')?.textContent || '')`, 4000);
      const owe = await dash.ev(`document.querySelector('.settle-list')?.textContent || ''`);
      await sleep(300);
      await shotPng(ph, 'week7-phone-tools');
      await dash.ev(`document.querySelector('.tab-body').scrollTop = 0`);
      await shotPng(dash, 'week7-laptop-tools');
      const phoneOwe = await ph.ev(`document.querySelector('.split-sum .get')?.textContent || ''`);
      return devChip && seen && /Dev.*Asha.*₹120/.test(owe) && /get ₹120/.test(phoneOwe) ? { detail: `laptop: "${owe}" · Asha's phone: "${phoneOwe}"` } : { ok: false, reason: JSON.stringify({ devChip, seen, owe, phoneOwe }) };
    });
    await timed('sunrise alarm "Test now": the wall slowly lights up, then rings; "I\'m up" ends it', async () => {
      await own('/api/tools/alarm/test', {});
      const on = await dash.until(`!!document.querySelector('.sunrise')`, 4000);
      await sleep(7000);
      const f1 = await dash.ev(`+getComputedStyle(document.querySelector('.sunrise')).getPropertyValue('--f')`);
      await shotPng(dash, 'week7-sunrise');
      const phoneCard = await ph.ev(`[...document.querySelectorAll('.rp-tabs button')].find(b => /Home/.test(b.textContent)).click(), true`).then(() => ph.until(`/Sunrise on the wall|Ringing/.test(document.querySelector('.alarm-live')?.textContent || '')`, 4000));
      const ring = await dash.until(`/Good morning/.test(document.querySelector('.sunrise')?.textContent || '')`, 20000);
      await dash.ev(`[...document.querySelectorAll('.sunrise button')].find(b => /I'm up/.test(b.textContent)).click()`);
      const gone = await dash.until(`!document.querySelector('.sunrise')`, 4000);
      return on && f1 > 0.2 && f1 < 0.7 && phoneCard && ring && gone ? { detail: `brightness ${Math.round(f1 * 100)}% after 7 s · phone shows the alarm · rang · dismissed` } : { ok: false, reason: JSON.stringify({ on, f1, phoneCard, ring, gone }) };
    });
    await timed('Showcase (V): audio-reactive canvas from the microphone; the wallpaper pauses; V again exits', async () => {
      await dash.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }))`);
      const on = await dash.until(`document.querySelector('.showcase')?.dataset.src === 'mic'`, 6000);
      await sleep(1500);
      const lit = await dash.ev(`(() => { const c = document.querySelector('.showcase canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 400) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; })()`);
      const paused = await dash.until(`__jhk.state.loopStats.value?.paused !== false`, 4000);
      await shotPng(dash, 'week7-showcase');
      await dash.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }))`);
      const off = await dash.until(`!document.querySelector('.showcase')`, 3000);
      return on && lit > 20 && paused && off ? { detail: `mic connected · ${lit} lit samples · wallpaper paused · exited` } : { ok: false, reason: JSON.stringify({ on, lit, paused, off, src: await dash.ev(`document.querySelector('.showcase')?.dataset.src`) }) };
    });
    check('no uncaught page errors (laptop + phone)', dash.errors.length === 0 && ph.errors.length === 0, 'none', [...dash.errors, ...ph.errors].slice(0, 3).join(' | '));
  } finally { S.proc.kill(); }
}
