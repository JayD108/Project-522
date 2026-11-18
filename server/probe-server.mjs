#!/usr/bin/env node
// Jharokha local server (Week 0-1): zero dependencies, Node >= 22.13.
// Run:  npm start   (or: node server/probe-server.mjs)   PORT=8080 HOST=0.0.0.0 by default, .env honoured.
// Serves the built app at /app/, sample clips at /samples/, the Week 0 probe at /,
// plus /health /ping /speed /clips /api/samples.  The real Fastify server replaces this in Week 3.
// Meant to run inside Crostini; Chrome on ChromeOS reaches it at http://localhost:8080,
// other LAN devices at http://<chromeos-wifi-ip>:8080 once port forwarding is on.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(HERE, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);   // optional local overrides, see .env.example
const ROOT = path.resolve(HERE, '..', 'probe');
const APP_ROOT = path.resolve(HERE, '..', 'app', 'dist'); // built PWA (npm run build)
const SAMPLES = path.resolve(HERE, '..', 'samples');
const CLIPS = path.join(ROOT, 'clips');
const DATA_DIR = process.env.JHK_DATA || path.resolve(HERE, '..', 'data');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const STARTED = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon',
};

// ---- SQLite WAL check (node:sqlite, Node >= 22.13) -------------------------
let db = null;
let sqliteInfo = { ok: false, reason: 'not initialised' };
try {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'probe.sqlite'));
  const mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('CREATE TABLE IF NOT EXISTS boots (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)');
  db.prepare('INSERT INTO boots (at) VALUES (?)').run(STARTED);
  const boots = db.prepare('SELECT COUNT(*) AS n FROM boots').get().n;
  sqliteInfo = { ok: mode === 'wal', journal_mode: mode, boots };
} catch (e) {
  sqliteInfo = { ok: false, reason: String(e?.message || e) };
}

// ---- stats ------------------------------------------------------------------
let requests = 0;
const clientsSeen = new Map(); // ip -> last seen ms (in RAM only)

function lanAddrs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, addr: a.address });
  }
  return out;
}

function readProcMem() {
  // Linux/Crostini: exact VM memory from /proc/meminfo. Elsewhere: os.* fallback.
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    return { totalMB: Math.round(kb('MemTotal') / 1024), availMB: Math.round(kb('MemAvailable') / 1024), source: '/proc/meminfo' };
  } catch {
    return { totalMB: Math.round(os.totalmem() / 2 ** 20), availMB: Math.round(os.freemem() / 2 ** 20), source: 'os' };
  }
}

function health(req) {
  const now = Date.now();
  for (const [ip, t] of clientsSeen) if (now - t > 60_000) clientsSeen.delete(ip);
  return {
    app: 'jharokha-probe', ok: true,
    uptimeS: Math.round((now - STARTED) / 1000),
    node: process.version, platform: `${os.platform()} ${os.release()}`, hostname: os.hostname(),
    inCrostini: fs.existsSync('/dev/.cros_milestone') || os.hostname() === 'penguin',
    lan: lanAddrs(), port: PORT,
    youAre: clientIp(req), reachedVia: req.headers.host,
    activeClients60s: clientsSeen.size, requests,
    load: os.loadavg().map((x) => +x.toFixed(2)), cpus: os.cpus().length,
    mem: readProcMem(), rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
    sqlite: sqliteInfo,
  };
}

function clientIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'content-type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function listVideos(dir, prefix) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(mp4|webm)$/i.test(f))
      .sort()
      .map((f) => ({ name: f, url: `${prefix}/${encodeURIComponent(f)}`, bytes: fs.statSync(path.join(dir, f)).size }));
  } catch { return []; }
}
const listClips = () => listVideos(CLIPS, '/clips');

// 1 MiB of incompressible-ish bytes, generated once and reused for /speed.
const SPEED_CHUNK = Buffer.alloc(1 << 20);
for (let i = 0; i < SPEED_CHUNK.length; i++) SPEED_CHUNK[i] = (i * 2654435761) >>> 24;

function serveStatic(req, res, urlPath, root = ROOT) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return send(res, 400, 'bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      // The service worker script must never be cached by the browser's HTTP cache.
      'cache-control': path.basename(file) === 'sw.js' ? 'no-store' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  requests++;
  clientsSeen.set(clientIp(req), Date.now());
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/ping') return send(res, 200, { t: Date.now() });
  if (p === '/health') return send(res, 200, health(req));
  if (p === '/clips') return send(res, 200, listClips());
  if (p === '/api/samples') return send(res, 200, listVideos(SAMPLES, '/samples'));
  if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/samples/')) return serveStatic(req, res, p.slice(8), SAMPLES);
  if (p === '/speed') {
    const mb = Math.min(Math.max(Number(url.searchParams.get('mb')) || 5, 1), 100);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': mb << 20, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    let left = mb;
    const pump = () => { while (left > 0) { left--; if (!res.write(SPEED_CHUNK)) return res.once('drain', pump); } res.end(); };
    return pump();
  }
  if (p === '/app') { res.writeHead(301, { location: '/app/' }); return res.end(); }
  if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/app/')) {
    if (!fs.existsSync(path.join(APP_ROOT, 'index.html'))) return send(res, 503, 'App not built yet: run `npm run build` (or `npm start`, which builds it).');
    return serveStatic(req, res, p.slice(4), APP_ROOT);
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  send(res, 405, 'method not allowed');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other server or set PORT=<free port> (see .env.example).`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`jharokha-probe listening on http://${HOST}:${PORT}  (node ${process.version})`);
  console.log(`  on this machine : http://localhost:${PORT}/app/   (probe: /)`);
  if (HOST === '0.0.0.0') {
    for (const a of lanAddrs()) console.log(`  ${a.iface.padEnd(15)} : http://${a.addr}:${PORT}/lan.html`);
    console.log('  (inside Crostini these are VM addresses; phones use the ChromeOS Wi-Fi IP after port forwarding)');
  }
  console.log(`  sqlite: ${JSON.stringify(sqliteInfo)}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { db?.close(); } catch {} server.close(); process.exit(0); });
