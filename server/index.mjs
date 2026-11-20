#!/usr/bin/env node
// Jharokha server (Week 3): Fastify + WebSocket + node:sqlite (WAL). Node >= 22.13.
// Runs inside Crostini as a systemd --user service. Never plays video.
// Run:  npm start   (or: node server/index.mjs)   PORT=8080 HOST=0.0.0.0 by default, .env honoured.
//
//   /app/            built PWA (app/dist), sw.js no-store        /samples/  sample clips
//   /                Week 0 probe + updates.html                 /clips     probe clips list
//   /health /ping /speed /api/samples                            (kept from Week 0)
//   /api/vitals      server vitals snapshot                      /ws        live vitals every 2 s
//   /api/join        best phone address + how we know it          /api/qr.svg QR of that address
//   POST /api/lan-host {host}  set the laptop's Wi-Fi IP by hand (owners only)
//   Week 4 access: /join (phone page) · /api/me · POST /api/join · POST /api/leave · POST /api/pair · POST /api/pair/new
//                  GET /api/access · POST /api/devices/:id/(approve|deny|revoke) · POST /api/kill · POST /api/quiet

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWs from '@fastify/websocket';
import QRCode from 'qrcode';
import { COOKIE, createAccess, makeLimiter } from './access.mjs';
import { DOOR, DROP_QUOTA, createRoom } from './room.mjs';
import { createTunnel } from './tunnel.mjs';
import { createFun, expandLink, youtubeTitle } from './fun.mjs';
import { createNetGuard } from './netguard.mjs';
import { createTools } from './tools.mjs';
import { createLogRing, createSnapshots } from './harden.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
if (fs.existsSync(path.join(REPO, '.env'))) process.loadEnvFile(path.join(REPO, '.env'));
const PROBE = path.join(REPO, 'probe');
const APP_DIST = path.join(REPO, 'app', 'dist');
const SAMPLES = path.join(REPO, 'samples');
const CLIPS = path.join(PROBE, 'clips');
const DATA_DIR = process.env.JHK_DATA || path.join(REPO, 'data');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const STARTED = Date.now();
const CHECKPOINT_MS = 5 * 60 * 1000;
const VITALS_MS = 2000;
const API_VERSION = 1;                         // bump when a route or WebSocket message changes shape (Android app checks it)
const SERVER_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const CROSTINI_NET = /^100\.115\.92\./;          // ChromeOS ↔ Linux container bridge: phones can't use it

// ------------------------------------------------------------------ SQLite (WAL, checkpoint every 5 min)
fs.mkdirSync(DATA_DIR, { recursive: true });
// Week 8: every console line also goes to a RAM ring (System tab) + a rotating file (≤ 4 MB on disk).
const logs = createLogRing({ dir: path.join(DATA_DIR, 'logs'), max: Number(process.env.JHK_LOG_RING || 1000), fileMax: Number(process.env.JHK_LOG_FILE_MAX || 1 << 20) });
logs.capture();
const DB_FILE = path.join(DATA_DIR, 'jharokha.sqlite');
let db = null;
let sqliteInfo = { ok: false, reason: 'not initialised' };
let lastCheckpoint = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(DB_FILE);
  const mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS boots (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
           CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);`);
  db.prepare('INSERT INTO boots (at) VALUES (?)').run(STARTED);
  sqliteInfo = { ok: mode === 'wal', journal_mode: mode, boots: db.prepare('SELECT COUNT(*) AS n FROM boots').get().n };
} catch (e) {
  sqliteInfo = { ok: false, reason: String(e?.message || e) };
}

function checkpoint() {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); lastCheckpoint = Date.now(); } catch { /* busy: next time */ }
}
setInterval(checkpoint, CHECKPOINT_MS).unref();
// Week 8: nightly snapshot (VACUUM INTO) at 03:30 laptop time, newest 7 kept. Crostini runs UTC, so W-A reports its offset.
let tzOffsetMin = 0;
const snapshots = createSnapshots({ db, dir: path.join(DATA_DIR, 'backups'), keep: Number(process.env.JHK_SNAP_KEEP || 7), at: process.env.JHK_SNAP_AT || '03:30', log: (m) => console.log(m), tzOffset: () => tzOffsetMin });
snapshots.schedule();
// Week 8: thermal guard. The laptop's Chrome reports Compute Pressure; the server keeps the last report for every screen.
let thermal = { state: 'n/a', at: 0, since: 0, guard: false };

const kvGet = (k) => { try { const r = db?.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : null; } catch { return null; } };
const kvSet = (k, v) => { try { db?.prepare('INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at').run(k, JSON.stringify(v), Date.now()); } catch { /* read-only disk etc. */ } };

// ------------------------------------------------------------------ access (Week 4)
// Trusted = requests from inside Linux itself (scripts, tests, curl). Tests set JHK_TRUSTED_IPS='' to act as a phone.
const TRUSTED = (process.env.JHK_TRUSTED_IPS ?? '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map((x) => x.trim()).filter(Boolean);
const access = db ? createAccess(db, { kvGet, kvSet, trustedIps: TRUSTED }) : null;
const NOBODY = { loopback: false, dev: null };
const room = db ? createRoom(db, { dataDir: DATA_DIR }) : null;
// Week 6 fun layer (queue, cast, pomodoro, scoreboard): pushed live to every member.
const fun = createFun({ kvGet, kvSet, fetchTitle: process.env.JHK_OFFLINE ? null : youtubeTitle, onChange: (v) => { try { toMembers(JSON.stringify({ t: 'fun', fun: v })); } catch { /* app not up yet */ } } });
// Week 7 utilities: polls, laundry timers, Split & Settle, sunrise alarm (see tools.mjs).
const tools = createTools({
  kvGet, kvSet, minuteMs: Number(process.env.JHK_MINUTE_MS) || 60000,
  people: () => (access ? access.state().devices.filter((d) => d.status === 'approved').map((d) => ({ key: d.id, name: d.name })) : []),
  onChange: (v) => { try { toMembers(JSON.stringify({ t: 'tools', tools: v })); } catch { /* app not up yet */ } },
  onDing: (d) => { try { toMembers(JSON.stringify({ t: 'tools-ding', ...d })); } catch { /* */ } },
});
setInterval(() => tools.tick(), Number(process.env.JHK_TOOLS_TICK_MS) || 5000).unref();
// "Same Wi-Fi only" + the room code in the QR (see netguard.mjs).
const guard = createNetGuard({
  kvGet, kvSet, log: (m) => console.log(m), onChange: () => { try { broadcastAccess(); } catch { /* app not up yet */ } },
  lookup: !process.env.JHK_LAPTOP_IP && process.env.JHK_NETGUARD_LOOKUP !== '0',
  laptopIp: process.env.JHK_LAPTOP_IP || null, fixedCode: process.env.JHK_ROOM_CODE || null,
});
// Internet tunnel (off by default; an owner switches it on when the Wi-Fi won't let phones in).
const tunnel = createTunnel({ port: PORT, kvGet, kvSet, log: (m) => console.log(m), onChange: () => { try { broadcastAccess(); } catch { /* app not up yet */ } } });
/** Came through the Cloudflare tunnel: cloudflared connects from 127.0.0.1 with the public *.trycloudflare.com Host. */
const isTunnelReq = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip) && /\.trycloudflare\.com$/i.test(hostName(req.headers.host || ''));
// Strangers arriving over the internet may only reach the join flow (and the files the phone page needs).
const TUNNEL_OPEN = [/^\/join$/, /^\/api\/(me|join|leave|pair)$/, /^\/app\/(room\.html|manifest\.webmanifest|registerSW\.js|sw\.js|workbox-[\w-]+\.js|icon-\d+\.png)$/, /^\/app\/assets\//];
/** Phones: has any device outside Linux ever reached us? (the "QR does nothing" diagnosis) */
let lastOutside = kvGet('lastOutside');   // { ip, host, at, ua }
const limitApi = makeLimiter(Number(process.env.JHK_RATE_PER_MIN || 240));   // per device (or IP) for non-owners
const limitJoin = makeLimiter(Number(process.env.JHK_JOIN_PER_MIN || 6));        // join / pair attempts per IP

// ------------------------------------------------------------------ stats (RAM only)
let requests = 0, errors = 0;
const recent = [];                    // request timestamps, last 10 s
const clientsSeen = new Map();        // ip -> last seen ms
let seenLanHost = kvGet('seenLanHost');   // "192.168.1.23:8080": learned from a phone's Host header

function lanAddrs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, addr: a.address });
  }
  return out;
}

function readProcMem() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    return { totalMB: Math.round(kb('MemTotal') / 1024), availMB: Math.round(kb('MemAvailable') / 1024), source: '/proc/meminfo' };
  } catch {
    return { totalMB: Math.round(os.totalmem() / 2 ** 20), availMB: Math.round(os.freemem() / 2 ** 20), source: 'os' };
  }
}

const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
function diskFree() {
  try { const s = fs.statfsSync(DATA_DIR); return { freeGB: +((s.bavail * s.bsize) / 2 ** 30).toFixed(1), totalGB: +((s.blocks * s.bsize) / 2 ** 30).toFixed(1) }; }
  catch { return null; }
}

const hostName = (h = '') => h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1'].includes(hostName(h));
const isPrivateV4 = (h) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostName(h));

function vitals() {
  const now = Date.now();
  while (recent.length && now - recent[0] > 10_000) recent.shift();
  for (const [ip, t] of clientsSeen) if (now - t > 60_000) clientsSeen.delete(ip);
  return {
    ok: true, at: now,
    uptimeS: Math.round((now - STARTED) / 1000),
    reqPerS: +(recent.length / 10).toFixed(1), requests, errors,
    activeClients60s: clientsSeen.size,
    wsClients: app.websocketServer?.clients.size ?? 0,
    dbBytes: fileSize(DB_FILE) + fileSize(DB_FILE + '-wal'),
    lastCheckpoint,
    disk: diskFree(),
    load: os.loadavg().map((x) => +x.toFixed(2)), cpus: os.cpus().length,
    mem: readProcMem(), rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
    node: process.version,
    sqlite: sqliteInfo,
    thermal: thermal.state, thermalGuard: thermal.guard,
    lastSnapshot: snapshots.status().list[0] ?? null,
    logLines: logs.size(),
  };
}

/** Where a phone should go. Manual > learned from a phone's request > container address (won't work from Wi-Fi). */
function joinInfo() {
  const manual = kvGet('lanHost');
  const crostini = lanAddrs()[0]?.addr;
  const reach = { lastOutside };
  const tun = tunnel.status();
  if (tun.status === 'on' && tun.url) return { url: `${tun.url}/join?k=${guard.code()}`, host: new URL(tun.url).host, source: 'tunnel', reach, tunnel: tun };
  if (manual) return { url: `http://${manual}/join?k=${guard.code()}`, host: manual, source: 'manual', reach, tunnel: tun };
  if (seenLanHost) return { url: `http://${seenLanHost}/join?k=${guard.code()}`, host: seenLanHost, source: 'seen', reach, tunnel: tun };
  const host = `${crostini || 'localhost'}:${PORT}`;
  return { url: `http://${host}/join?k=${guard.code()}`, host, source: crostini && CROSTINI_NET.test(crostini) ? 'crostini' : 'lan', reach, tunnel: tun };
}

// The app build that's on disk now (its hashed script name). Open screens compare it with theirs after a deploy.
let buildCache = { m: 0, id: null };
function appBuild() {
  try {
    const f = path.join(APP_DIST, 'index.html');
    const m = fs.statSync(f).mtimeMs;
    if (m !== buildCache.m) buildCache = { m, id: (/assets\/(main-[\w-]+\.js)/.exec(fs.readFileSync(f, 'utf8')) || [])[1] || null };
  } catch { return null; }
  return buildCache.id;
}

// ------------------------------------------------------------------ guards
const isOwner = (who) => (access ? access.isOwner(who) : !!who?.loopback);
const isMember = (who) => (access ? access.isMember(who) : !!who?.loopback);
async function needOwner(req, reply) {
  if (!isOwner(req.who || NOBODY)) return reply.code(403).send({ error: 'owners only: pair this laptop with `npm run pair`' });
  if (!access && req.routeOptions?.url?.startsWith('/api/') && !req.routeOptions.url.includes('lan-host')) return reply.code(503).send({ error: 'access database unavailable' });
}
async function needMember(req, reply) {
  if (!isMember(req.who || NOBODY)) return reply.code(403).send({ error: 'not approved yet' });
}
const WIFI_ONLY_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jharokha</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0d0c0b;color:#f1e9dc;font:18px system-ui;text-align:center;padding:24px">
<div><h1 style="font-weight:300">Jharokha</h1><p>This room only works on the <b>room's Wi-Fi</b>.</p>
<p style="color:#9a9083">Turn off mobile data, connect to the hostel Wi-Fi, then scan the QR again.</p></div>`;
const OWNER_ONLY_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jharokha</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0d0c0b;color:#f1e9dc;font:18px system-ui;text-align:center;padding:24px">
<div><h1 style="font-weight:300">Jharokha</h1><p>The room is in <b>owner-only mode</b> right now.</p><p style="color:#9a9083">Try again later.</p></div>`;

// ------------------------------------------------------------------ app
const app = Fastify({ logger: false });
await app.register(fastifyWs);

app.addHook('onRequest', async (req, reply) => {
  requests++;
  recent.push(Date.now());
  req.viaTunnel = isTunnelReq(req);
  // The real phone address: from cloudflared's header for tunnel requests (trusted only on that path), else the socket.
  req.clientIp = req.viaTunnel ? String(req.headers['cf-connecting-ip'] || 'internet').slice(0, 64) : req.ip;
  if (!isLocalHost(req.headers.host || '') && (!lastOutside || Date.now() - lastOutside.at > 60000 || lastOutside.ip !== req.clientIp)) {
    lastOutside = { ip: req.clientIp, host: req.headers.host || '', at: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 80), via: req.viaTunnel ? 'internet' : 'wifi' };
    kvSet('lastOutside', lastOutside);
  }
  if (!clientsSeen.has(req.clientIp) && !isLocalHost(req.headers.host || '')) {
    // Diagnostics for "the phone can't reach it": every new non-laptop device shows up in journalctl.
    console.log(`device ${req.clientIp} via ${req.headers.host}${req.viaTunnel ? ' (internet)' : ''} → ${req.method} ${req.url.slice(0, 80)} · ${String(req.headers['user-agent'] || '').slice(0, 60)}`);
  }
  clientsSeen.set(req.clientIp, Date.now());
  const who = (req.who = access ? access.identify(req) : { loopback: TRUSTED.includes(req.ip), dev: null });
  const owner = isOwner(who);
  // Kill switch: everyone but owners is turned away (ChromeOS port forwarding itself can only be closed in Settings).
  if (access?.settings().kill && !owner) {
    reply.code(403).header('cache-control', 'no-store');
    if ((req.headers.accept || '').includes('text/html')) reply.type('text/html; charset=utf-8').send(OWNER_ONLY_HTML);
    else reply.send({ error: 'owner-only mode' });
    return reply;
  }
  if (!owner && !limitApi(who.dev?.id || req.clientIp)) { reply.code(429).send({ error: 'too many requests, slow down' }); return reply; }
  if (req.viaTunnel && !owner && !guard.allows(req.clientIp)) {
    guard.noteBlocked(req.clientIp, req.headers['user-agent'], req.url);
    reply.code(403).header('cache-control', 'no-store');
    if ((req.headers.accept || '').includes('text/html')) reply.type('text/html; charset=utf-8').send(WIFI_ONLY_HTML);
    else reply.send({ error: 'not-on-room-wifi' });
    return reply;
  }
  if (req.viaTunnel && !isMember(who) && !TUNNEL_OPEN.some((r) => r.test(req.url.split('?')[0]))) {
    reply.header('cache-control', 'no-store');
    if ((req.headers.accept || '').includes('text/html')) reply.redirect('/join', 302);   // browsers: straight to the join page
    else reply.code(403).send({ error: 'ask to join first (/join)' });
    return reply;
  }
  const h = req.headers.host || '';
  // An approved phone reached us by the laptop's Wi-Fi address: remember it for the QR (ChromeOS hides it from Linux).
  // Only members count, so a stranger can't point the QR somewhere else by faking the Host header.
  if (!who.loopback && isMember(who) && isPrivateV4(h) && !CROSTINI_NET.test(hostName(h)) && h !== seenLanHost) { seenLanHost = h; kvSet('seenLanHost', h); }
  if (req.url.startsWith('/app/') && !fs.existsSync(path.join(APP_DIST, 'index.html'))) {
    reply.code(503).type('text/plain; charset=utf-8').send('App not built yet: run `npm run build` (or `npm start`, which builds it).');
    return reply;
  }
});
app.addHook('onResponse', async (req, reply) => { if (reply.statusCode >= 500) errors++; });
// Cache policy: API → no-store; static files → no-cache (revalidate); the service worker script → never cached.
app.addHook('onSend', async (req, reply, payload) => {
  if (!reply.getHeader('cache-control')) {
    const p = req.url.split('?')[0];
    const file = reply.statusCode === 200 && (p.endsWith('/') || /\.[a-z0-9]+$/i.test(p)) && !p.startsWith('/api/');
    reply.header('cache-control', file && !p.endsWith('/sw.js') ? 'no-cache' : 'no-store');
  }
  return payload;
});

fs.mkdirSync(APP_DIST, { recursive: true });
await app.register(fastifyStatic, { root: PROBE, prefix: '/', cacheControl: false });
await app.register(fastifyStatic, { root: APP_DIST, prefix: '/app/', decorateReply: false, cacheControl: false, redirect: true });
await app.register(fastifyStatic, { root: SAMPLES, prefix: '/samples/', decorateReply: false, cacheControl: false });

function listVideos(dir, prefix) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(mp4|webm)$/i.test(f)).sort()
      .map((f) => ({ name: f, url: `${prefix}/${encodeURIComponent(f)}`, bytes: fs.statSync(path.join(dir, f)).size }));
  } catch { return []; }
}

const cors = { 'access-control-allow-origin': '*' };
app.get('/ping', async (req, reply) => { reply.headers(cors); return { t: Date.now() }; });
app.get('/health', async (req, reply) => {
  reply.headers(cors);
  const v = vitals();
  return {
    app: 'jharokha', ok: true, uptimeS: v.uptimeS, node: process.version, platform: `${os.platform()} ${os.release()}`,
    hostname: os.hostname(), inCrostini: fs.existsSync('/dev/.cros_milestone') || os.hostname() === 'penguin',
    lan: lanAddrs(), port: PORT, youAre: req.ip, reachedVia: req.headers.host,
    activeClients60s: v.activeClients60s, requests, load: v.load, cpus: v.cpus, mem: v.mem, rssMB: v.rssMB, sqlite: sqliteInfo,
  };
});
app.get('/clips', async () => listVideos(CLIPS, '/clips'));
app.get('/api/samples', async () => listVideos(SAMPLES, '/samples'));
app.get('/api/vitals', { preHandler: needMember }, async () => vitals());
app.get('/api/join', async () => joinInfo());
// Week 8 · System: logs (RAM ring + rotating file), snapshots, thermal. Owners only.
app.get('/api/system/logs', { preHandler: needOwner }, async (req) => ({
  lines: logs.tail({ n: Number(req.query?.n) || 200, level: ['info', 'warn', 'error'].includes(req.query?.level) ? req.query.level : null, after: Number(req.query?.after) || 0 }),
  files: logs.files(), ring: logs.size(),
}));
app.get('/api/system/backups', { preHandler: needOwner }, async () => snapshots.status());
app.post('/api/system/backups', { preHandler: needOwner }, async (req, reply) => {
  checkpoint();
  const r = snapshots.take('owner');
  access?.log(access.actorName(req.who), 'snapshot', r.name, r.ok ? `${Math.round(r.bytes / 1024)} KB` : r.error);
  return r.ok ? { ok: true, snapshot: r, status: snapshots.status() } : reply.code(500).send({ error: r.error });
});
app.get('/api/system/thermal', { preHandler: needMember }, async () => thermal);
app.get('/api/qr.svg', async (req, reply) => {
  const svg = await QRCode.toString(joinInfo().url, { type: 'svg', margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  reply.type('image/svg+xml').header('cache-control', 'no-store');
  return svg;
});
app.post('/api/lan-host', { preHandler: needOwner }, async (req, reply) => {
  const raw = String(req.body?.host ?? '').trim();
  if (!raw) { kvSet('lanHost', null); return joinInfo(); }
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(raw);
  if (!m || m[1].split('.').some((x) => +x > 255)) return reply.code(400).send({ error: 'use an IP like 192.168.1.23 (optionally :8080)' });
  kvSet('lanHost', `${m[1]}:${m[2] || PORT}`);
  access?.log(access.actorName(req.who), 'wifi-ip', m[1]);
  return joinInfo();
});

const SPEED_CHUNK = Buffer.alloc(1 << 20);
for (let i = 0; i < SPEED_CHUNK.length; i++) SPEED_CHUNK[i] = (i * 2654435761) >>> 24;
app.get('/speed', async (req, reply) => {
  const mb = Math.min(Math.max(Number(req.query.mb) || 5, 1), 100);
  let left = mb;
  const stream = new Readable({ read() { this.push(left-- > 0 ? SPEED_CHUNK : null); } });
  reply.headers({ ...cors, 'content-type': 'application/octet-stream', 'content-length': mb << 20 });
  return reply.send(stream);
});
app.get('/app', async (req, reply) => reply.redirect('/app/', 301));

// ------------------------------------------------------------------ Week 4 · access routes
const setCookie = (reply, c) => reply.header('set-cookie', c);
const clearCookie = (reply) => reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
const noAccess = (reply) => reply.code(503).send({ error: 'access database unavailable' });

app.get('/join', async (req, reply) => reply.sendFile('join.html', PROBE));
app.get('/api/me', async (req) => (access ? access.me(req.who) : { status: req.who.loopback ? 'owner' : 'none', owner: req.who.loopback }));
app.post('/api/join', async (req, reply) => {
  if (!access) return noAccess(reply);
  if (!limitJoin('join:' + req.clientIp)) return reply.code(429).send({ error: 'Too many tries: wait a minute' });
  if (req.who.dev) return reply.code(409).send({ error: 'This phone already asked', me: access.me(req.who) });
  if (!req.who.loopback && !guard.codeOk(String(req.body?.k || ''))) {
    return reply.code(403).send({ error: 'Scan the QR code on the room\'s screen to join (the code in it changes every 10 minutes).', code: 'room-code' });
  }
  const r = access.requestJoin({ name: req.body?.name, ip: req.viaTunnel ? `${req.clientIp} (internet)` : req.clientIp, ua: req.headers['user-agent'], secure: req.viaTunnel });
  if (r.error) return reply.code(r.code).send({ error: r.error });
  setCookie(reply, r.cookie);
  broadcastAccess();
  return { ok: true, status: 'pending' };
});
app.post('/api/me/role', async (req, reply) => {
  if (!access) return noAccess(reply);
  const r = access.selfRole(req.who, req.body?.role);
  if (r.error) return reply.code(r.code).send({ error: r.error });
  broadcastAccess();
  // Their live link keeps the old owner flag: close it so they reconnect with the new role.
  if (req.who.dev) kickDevice(req.who.dev.id, 4000);
  return r;
});
app.post('/api/leave', async (req, reply) => {
  if (!access) return noAccess(reply);
  access.leave(req.who);
  clearCookie(reply);
  broadcastAccess();
  return { ok: true };
});
app.post('/api/pair/new', { preHandler: needOwner }, async (req) => {
  const code = access.newPairCode(req.who);
  return { code, url: `http://localhost:${PORT}/app/?pair=${code}`, expiresInS: 600 };
});
// The owner's Android controller app: a QR with this server's address + a one-time 32-hex code (10 min).
// The app trades it for an owner token via POST /api/pair (open over the internet link; same-Wi-Fi rule still applies).
app.post('/api/pair/phone', { preHandler: needOwner }, async (req) => {
  const code = access.newPairCode(req.who, { phone: true });
  const j = joinInfo();
  const base = j.source === 'tunnel' ? new URL(j.url).origin : `http://${j.host}`;
  const payload = `jharokha://pair?u=${encodeURIComponent(base)}&c=${code}`;
  const svg = await QRCode.toString(payload, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' });
  return { code, base, payload, svg, source: j.source, expiresInS: 600 };
});
// For the Android app: which API it is talking to (it warns when it is older or newer than the server).
app.get('/api/version', { preHandler: needMember }, async () => ({ api: API_VERSION, build: appBuild(), server: SERVER_VERSION }));
app.post('/api/pair', async (req, reply) => {
  if (!access) return noAccess(reply);
  if (!limitJoin('pair:' + req.clientIp)) return reply.code(429).send({ error: 'Too many tries: wait a minute' });
  const r = access.pair({ code: req.body?.code, name: req.body?.name, ip: req.ip, ua: req.headers['user-agent'], secure: req.viaTunnel });
  if (r.error) return reply.code(r.code).send({ error: r.error });
  setCookie(reply, r.cookie);
  broadcastAccess();
  return { ok: true };
});
app.post('/api/netguard', { preHandler: needOwner }, async (req, reply) => {
  const b = req.body || {};
  let r = { ok: true };
  if (b.mode) r = guard.setMode(b.mode);
  if (!r.error && b.trust) r = guard.trust(b.trust);
  if (!r.error && b.untrust) r = guard.untrust(b.untrust);
  if (r.error) return reply.code(r.code).send({ error: r.error });
  access?.log(access.actorName(req.who), 'who-can-connect', null, b.mode || (b.trust ? `trust ${b.trust}` : `untrust ${b.untrust}`));
  if (b.mode === 'wifi' || b.untrust) {
    // Drop live links from phones that are now outside the allowed networks.
    for (const c of app.websocketServer?.clients || []) if (c.jhkTunnelIp && !c.jhkOwner && !guard.allows(c.jhkTunnelIp)) c.close(4403, 'not on the room Wi-Fi');
  }
  broadcastAccess();
  return guard.status();
});
app.get('/api/tunnel', { preHandler: needOwner }, async () => tunnel.status());
app.post('/api/tunnel', { preHandler: needOwner }, async (req) => {
  const on = !!req.body?.on;
  const st = tunnel.setWanted(on);
  access?.log(access.actorName(req.who), on ? 'internet sharing ON' : 'internet sharing off');
  return st;
});
app.get('/api/access', { preHandler: needOwner }, async () => ({ ...access.state(), audit: access.audit(30), net: guard.status() }));
app.post('/api/devices/:id/:action', { preHandler: needOwner }, async (req, reply) => {
  const r = access.decide(req.who, req.params.id, req.params.action, req.body?.role);
  if (r.error) return reply.code(r.code).send({ error: r.error });
  // Removed, denied, or role changed: close their live link (they reconnect with the new rights, or not at all).
  if (req.params.action === 'role') kickDevice(req.params.id, 4000);
  else if (req.params.action !== 'approve') kickDevice(req.params.id);
  broadcastAccess();
  return r;
});
app.post('/api/kill', { preHandler: needOwner }, async (req) => {
  const on = !!req.body?.on;
  access.setKill(req.who, on);
  if (on) for (const c of app.websocketServer?.clients || []) if (!c.jhkOwner) c.close(4403, 'owner-only mode');
  broadcastAccess();
  return { ok: true, kill: on };
});
app.post('/api/quiet', { preHandler: needOwner }, async (req, reply) => {
  const r = access.setQuiet(req.who, req.body || {});
  if (r.error) return reply.code(r.code).send({ error: r.error });
  broadcastAccess();
  return r;
});

function accessMsg() { return access ? JSON.stringify({ t: 'access', a: { ...access.state(), audit: access.audit(30), net: guard.status() } }) : null; }
function broadcastAccess() {
  try { toMembers(JSON.stringify({ t: 'tools', tools: tools.view() })); } catch { /* not up yet */ }   // people list for Split
  const msg = accessMsg();
  if (!msg) return;
  for (const c of app.websocketServer?.clients || []) if (c.jhkOwner && c.readyState === 1) c.send(msg);
}
function kickDevice(id, code = 4401) {
  for (const c of app.websocketServer?.clients || []) if (c.jhkDevice === id) c.close(code, code === 4401 ? 'access removed' : 'role changed');
}

// Live vitals for the dashboard windows and approved phones. Owners also get the access tray.
app.get('/ws', { websocket: true }, (socket, req) => {
  const who = req.who || NOBODY;
  if (!isMember(who)) {
    socket.send(JSON.stringify({ t: 'denied', me: access ? access.me(who) : null }));
    socket.close(4401, 'not approved');
    return;
  }
  socket.jhkOwner = isOwner(who);
  socket.jhkDevice = who.dev?.id || null;
  socket.send(JSON.stringify({ t: 'hello', me: access ? access.me(who) : { owner: true, status: 'owner' }, build: appBuild() }));
  socket.send(JSON.stringify({ t: 'vitals', v: vitals(), join: joinInfo() }));
  if (socket.jhkOwner) { const m = accessMsg(); if (m) socket.send(m); }
  socket.jhkWho = who;
  socket.jhkTunnelIp = req.viaTunnel ? req.clientIp : null;
  if (room) {
    socket.send(JSON.stringify({ t: 'door', door: room.getDoor() }));
    socket.send(JSON.stringify({ t: 'drops', drops: room.listDrops() }));
    socket.send(JSON.stringify({ t: 'fun', fun: fun.view() }));
    socket.send(JSON.stringify({ t: 'tools', tools: tools.view() }));
    if (lastScreen && socket.jhkOwner) socket.send(JSON.stringify({ t: 'screen', s: lastScreen }));
    socket.send(helperMsg());
    if (lastApp) socket.send(JSON.stringify({ t: 'app-state', s: lastApp }));
  }
  socket.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t === 'ping') return socket.send(JSON.stringify({ t: 'pong', ts: m.ts }));
    if (m.t === 'iam' && ['A', 'B', 'room'].includes(m.role)) { socket.jhkRole = m.role; return; }
    // The "Jharokha Remote" Chrome extension on this laptop (only from inside this machine, never over the tunnel).
    if (m.t === 'iam' && m.role === 'X' && who.loopback && !req.viaTunnel) {
      socket.jhkRole = 'X';
      socket.on('close', () => { if (!helperOn()) { lastApp = null; toMembers(JSON.stringify({ t: 'app-state', s: null })); } toMembers(helperMsg()); });
      toMembers(helperMsg());
      return;
    }
    if (socket.jhkRole === 'X') {
      if (m.t === 'app-state') {
        lastApp = sanitizeAppState(m.s);
        toMembers(JSON.stringify({ t: 'app-state', s: lastApp }), socket);
      }
      return;                                       // the extension can't do anything else
    }
    // Phone → the streaming tab on the laptop (pointer, arrows, typing, player). Owners and collaborators.
    if (m.t === 'app' && APP_CMDS.has(m.cmd)) {
      if (!canWrite(who)) return socket.send(JSON.stringify({ t: 'remote-ack', cmd: 'app', delivered: 0, error: 'read-only' }));
      const arg = appArg(m.cmd, m.arg);
      if (arg === undefined) return;
      const n = toHelpers({ t: 'app', cmd: m.cmd, arg });
      if (!['move', 'scroll'].includes(m.cmd)) {
        if (['type', 'search'].includes(m.cmd)) access?.log(access.actorName(who), `app ${m.cmd}`, null, null);   // never log what was typed
        return socket.send(JSON.stringify({ t: 'remote-ack', cmd: 'app', delivered: n }));
      }
      return;
    }
    if (!room) return;
    if (m.t === 'room-sync') return socket.send(JSON.stringify({ t: 'room-update', u: room.diffFor(m.sv), initial: true, canWrite: canWrite(who) }));
    if (m.t === 'room-update') {
      if (!canWrite(who)) return socket.send(JSON.stringify({ t: 'room-readonly' }));
      if (!room.applyFrom(m.u, socket)) socket.send(JSON.stringify({ t: 'room-error' }));
      return;
    }
    // Owner remote: a phone (or the other screen) asks the dashboard window (W-A) to act.
    if (m.t === 'remote' && socket.jhkOwner && REMOTE_CMDS.includes(m.cmd)) {
      const by = access ? access.actorName(who) : 'owner';
      let n = 0;
      for (const c of app.websocketServer.clients) if (c.jhkRole === 'A' && c.readyState === 1) { c.send(JSON.stringify({ t: 'remote', cmd: m.cmd, arg: m.arg ?? null, by })); n++; }
      if (m.cmd !== 'ping') access?.log(by, `remote ${m.cmd}`, null, m.arg ?? null);
      return socket.send(JSON.stringify({ t: 'remote-ack', cmd: m.cmd, delivered: n }));
    }
    // Media remote: play / pause / seek / volume for what's on the wall (owners, or whoever cast it).
    if (m.t === 'media' && MEDIA_CMDS.includes(m.cmd) && fun.canControl(devKey(who), socket.jhkOwner)) {
      let n = 0;
      for (const c of app.websocketServer.clients) if ((c.jhkRole === 'A' || c.jhkRole === 'B') && c.jhkOwner && c.readyState === 1) { c.send(JSON.stringify({ t: 'media', cmd: m.cmd, arg: typeof m.arg === 'number' ? m.arg : null })); n++; }
      return socket.send(JSON.stringify({ t: 'remote-ack', cmd: m.cmd, delivered: n }));
    }
    // The wall window reports playback state; everyone sees it (title, playing, time, volume).
    if (m.t === 'media-state' && socket.jhkOwner && (socket.jhkRole === 'A' || socket.jhkRole === 'B') && m.s && typeof m.s === 'object') {
      const s2 = { playing: !!m.s.playing, t: +m.s.t || 0, d: +m.s.d || 0, vol: Math.max(0, Math.min(100, +m.s.vol || 0)), muted: !!m.s.muted, kind: String(m.s.kind || '').slice(0, 10), at: Date.now() };
      return toMembers(JSON.stringify({ t: 'media-state', s: s2 }), socket);
    }
    // "Open on PC": a phone asks the laptop to open a link (Netflix etc.). The laptop shows a one-tap prompt.
    if (m.t === 'open-request' && canWrite(who) && typeof m.url === 'string' && /^https:\/\//.test(m.url) && m.url.length < 500) {
      const title = String(m.title || '').slice(0, 60);
      access?.log(access.actorName(who), 'open on PC', null, m.url.slice(0, 120));
      // Known streaming/web apps open straight in ChromeOS Chrome (no tap needed on the laptop).
      // Any other link still needs the owner's one tap on the laptop prompt.
      if (isAppUrl(m.url) && (toHelpers({ t: 'open', url: m.url }) > 0 || openOnLaptop(m.url))) {
        const note = JSON.stringify({ t: 'opened', url: m.url, title, by: byName(who) });
        for (const c of app.websocketServer.clients) if (c.jhkRole === 'A' && c.jhkOwner && c.readyState === 1) c.send(note);
        return socket.send(JSON.stringify({ t: 'remote-ack', cmd: 'open', delivered: 1, direct: true }));
      }
      const msg = JSON.stringify({ t: 'open-request', url: m.url, title, by: byName(who) });
      let n = 0;
      for (const c of app.websocketServer.clients) if (c.jhkRole === 'A' && c.jhkOwner && c.readyState === 1) { c.send(msg); n++; }
      return socket.send(JSON.stringify({ t: 'remote-ack', cmd: 'open', delivered: n }));
    }
    // W-A reports what the screens are doing, for the owner remote.
    if (m.t === 'screen-state' && socket.jhkOwner && socket.jhkRole === 'A' && m.s && typeof m.s === 'object') {
      lastScreen = { ...m.s, at: Date.now() };
      if (Number.isFinite(m.s.tz) && Math.abs(m.s.tz) <= 14 * 60 && m.s.tz !== tzOffsetMin) { tzOffsetMin = m.s.tz; snapshots.schedule(); }
      if (m.s.thermal && typeof m.s.thermal.state === 'string') {
        const st = String(m.s.thermal.state).slice(0, 12);
        if (st !== thermal.state) { thermal = { state: st, at: Date.now(), since: Date.now(), guard: !!m.s.thermal.guard }; console.log(`thermal: ${st}${thermal.guard ? ' (guard on: wallpaper paused)' : ''}`); }
        else thermal = { ...thermal, at: Date.now(), guard: !!m.s.thermal.guard };
      }
      const msg = JSON.stringify({ t: 'screen', s: lastScreen });
      for (const c of app.websocketServer.clients) if (c.jhkOwner && c !== socket && c.readyState === 1) c.send(msg);
    }
  });
});

// ------------------------------------------------------------------ "Open on PC" without a tap
// Inside Crostini, garcon-url-handler opens a URL as a tab in ChromeOS Chrome (no browser pop-up rule applies).
// JHK_OPENER: path of the opener program, or "none" to turn this off (tests). Only these app hosts open directly.
// Exact hosts: Google is only www.google.com (not mail/drive), Spotify only the web player.
const APP_HOSTS = /(^|\.)(netflix\.com|primevideo\.com|youtube\.com|hotstar\.com|jiocinema\.com|sonyliv\.com|zee5\.com|disneyplus\.com)$|^www\.google\.com$|^open\.spotify\.com$/;
const OPENER = process.env.JHK_OPENER ?? (fs.existsSync('/usr/bin/garcon-url-handler') ? '/usr/bin/garcon-url-handler' : 'none');
function isAppUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && !x.port && APP_HOSTS.test(x.hostname); } catch { return false; }
}
// ------------------------------------------------------------------ phone remote for streaming tabs (via the extension)
let lastApp = null;
const APP_CMDS = new Set(['move', 'click', 'scroll', 'nav', 'ok', 'back', 'browse', 'home', 'reload', 'type', 'key', 'search',
  'toggle', 'play', 'pause', 'seek', 'seekTo', 'volume', 'mute', 'fullscreen', 'skip', 'close', 'focus']);
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
/** The only argument shapes the extension ever gets (undefined = drop the message). */
function appArg(cmd, a) {
  switch (cmd) {
    case 'move': case 'scroll': {
      const dx = num(a?.dx, -3000, 3000) ?? 0, dy = num(a?.dy, -3000, 3000) ?? 0;
      return { dx: Math.round(dx), dy: Math.round(dy) };
    }
    case 'nav': return ['up', 'down', 'left', 'right'].includes(a) ? a : undefined;
    case 'key': return ['enter', 'backspace', 'escape', 'space', 'tab'].includes(a) ? a : undefined;
    case 'type': return typeof a?.text === 'string' ? { text: a.text.slice(0, 200), enter: !!a.enter } : undefined;
    case 'search': return typeof a === 'string' && a.trim() ? a.trim().slice(0, 100) : undefined;
    case 'seek': return num(a, -600, 600);
    case 'seekTo': return num(a, 0, 86400);
    case 'volume': return num(a, 0, 100);
    default: return null;
  }
}
function sanitizeAppState(s) {
  if (!s || typeof s !== 'object') return null;
  const str = (v, n) => String(v ?? '').slice(0, n);
  const v = s.v && typeof s.v === 'object'
    ? { playing: !!s.v.playing, t: num(s.v.t, 0, 86400) ?? 0, d: num(s.v.d, 0, 86400) ?? 0, vol: num(s.v.vol, 0, 100) ?? 0, muted: !!s.v.muted }
    : null;
  return { site: str(s.site, 40), title: str(s.title, 120), v, player: !!s.player, skip: s.skip ? str(s.skip, 40) : null, typing: !!s.typing, blocked: !!s.blocked, tv: !!s.tv, at: Date.now() };
}
function toHelpers(m) {
  const msg = JSON.stringify(m);
  let n = 0;
  for (const c of app.websocketServer?.clients || []) if (c.jhkRole === 'X' && c.readyState === 1) { c.send(msg); n++; }
  return n;
}
const helperOn = () => [...(app.websocketServer?.clients || [])].some((c) => c.jhkRole === 'X' && c.readyState === 1);
const helperMsg = () => JSON.stringify({ t: 'app-helper', on: helperOn() });

function openOnLaptop(url) {
  if (OPENER === 'none') return false;
  execFile(OPENER, [url], { timeout: 10000 }, (err) => { if (err) app.log.warn(`open on laptop failed: ${err.message}`); });
  return true;
}

// ------------------------------------------------------------------ Week 5 · room: board, door sign, drops, remote
const REMOTE_CMDS = ['swap', 'cinema', 'night', 'showcase', 'scene', 'wallpaper', 'stack', 'ping'];
const MEDIA_CMDS = ['toggle', 'play', 'pause', 'seek', 'seekTo', 'volume', 'mute', 'unmute', 'stop'];
let lastScreen = null;
function canWrite(who) {
  if (!who) return false;
  if (who.loopback) return true;
  const r = access?.effectiveRole(who.dev);
  return r === 'owner' || r === 'collaborator';
}
function toMembers(msg, except) {
  for (const c of app.websocketServer?.clients || []) if (c !== except && c.readyState === 1 && c.jhkWho && isMember(c.jhkWho)) c.send(msg);
}
room?.onUpdate((u, origin) => toMembers(JSON.stringify({ t: 'room-update', u }), origin));
const devKey = (who) => who.dev?.id || 'laptop';
const byName = (who) => who.dev?.name || 'Laptop';

app.get('/api/room', { preHandler: needMember }, async (req) => ({
  door: room.getDoor(), doorOptions: DOOR, drops: room.listDrops(), quota: DROP_QUOTA, used: room.usedBy(devKey(req.who)),
  canWrite: canWrite(req.who), owner: isOwner(req.who), you: devKey(req.who),
}));
app.post('/api/door', { preHandler: needOwner }, async (req, reply) => {
  const r = room.setDoor(req.body || {}, byName(req.who));
  if (r.error) return reply.code(r.code).send({ error: r.error });
  access?.log(access.actorName(req.who), 'door', null, `${r.door.status}${r.door.note ? ` · ${r.door.note}` : ''}`);
  toMembers(JSON.stringify({ t: 'door', door: r.door }));
  return r;
});
// ------------------------------------------------------------------ Week 6 · fun layer routes
const funWho = (req) => ({ name: byName(req.who), key: devKey(req.who) });
const funReply = (reply, r) => (r.error ? reply.code(r.code || 400).send({ error: r.error }) : r);
async function needWriter(req, reply) {
  if (!isMember(req.who || NOBODY)) return reply.code(403).send({ error: 'not approved yet' });
  if (!canWrite(req.who)) return reply.code(403).send({ error: 'Read-only right now (viewer, or quiet hours)' });
}
const audit = (req, what, detail) => access?.log(access.actorName(req.who), what, null, detail ?? null);
app.get('/api/fun', { preHandler: needMember }, async () => fun.view());
// ------------------------------------------------------------------ Week 7 · utilities
const isOwn = (req) => isOwner(req.who);
app.get('/api/tools', { preHandler: needMember }, async () => tools.view());
app.post('/api/tools/poll', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.createPoll(req.body || {}, funWho(req))));
app.post('/api/tools/poll/:id/vote', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.votePoll(req.params.id, String(req.body?.option || ''), funWho(req))));
app.post('/api/tools/poll/:id/close', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.closePoll(req.params.id, funWho(req), isOwn(req))));
app.delete('/api/tools/poll/:id', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.deletePoll(req.params.id, funWho(req), isOwn(req))));
app.post('/api/tools/timer', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.startTimer(req.body || {}, funWho(req))));
app.delete('/api/tools/timer/:id', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.cancelTimer(req.params.id, funWho(req), isOwn(req))));
app.post('/api/tools/expense', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.addExpense(req.body || {}, funWho(req))));
app.delete('/api/tools/expense/:id', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.deleteExpense(req.params.id, funWho(req), isOwn(req))));
app.post('/api/tools/settle', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.settle(req.body || {}, funWho(req), isOwn(req))));
app.post('/api/tools/clear', { preHandler: needOwner }, async (req, reply) => { const r = tools.clearSettled(true); if (!r.error) audit(req, 'split: cleared'); return funReply(reply, r); });
app.post('/api/tools/upi', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.setUpi(req.body || {}, funWho(req))));
app.post('/api/tools/event', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.addEvent(req.body || {}, funWho(req))));
app.delete('/api/tools/event/:id', { preHandler: needWriter }, async (req, reply) => funReply(reply, tools.deleteEvent(req.params.id, funWho(req), isOwn(req))));
app.post('/api/tools/alarm', { preHandler: needOwner }, async (req, reply) => { const r = tools.setAlarm(req.body || {}, funWho(req)); if (!r.error) audit(req, 'alarm', `${r.alarm.on ? 'on' : 'off'} ${r.alarm.time}`); return funReply(reply, r); });
app.post('/api/tools/alarm/:action', { preHandler: needMember }, async (req, reply) => funReply(reply, tools.alarmAction(req.params.action)));
const expanded = async (b) => ({ ...(b || {}), url: process.env.JHK_OFFLINE ? b?.url : await expandLink(b?.url) });
app.post('/api/fun/queue', { preHandler: needWriter }, async (req, reply) => funReply(reply, fun.addToQueue(await expanded(req.body), funWho(req))));
app.post('/api/fun/queue/:id/vote', { preHandler: needWriter }, async (req, reply) => funReply(reply, fun.vote(req.params.id, funWho(req))));
app.delete('/api/fun/queue/:id', { preHandler: needWriter }, async (req, reply) => funReply(reply, fun.removeFromQueue(req.params.id, funWho(req), isOwner(req.who))));
// Owners put things on the wall straight away; everyone else asks, and an owner approves (v2 §3.3: big-screen control is owner-only).
app.post('/api/fun/cast', { preHandler: needWriter }, async (req, reply) => {
  const body = await expanded(req.body);
  if (isOwner(req.who)) { const r = fun.castNow(body, funWho(req)); if (!r.error) audit(req, 'cast', r.casting.url); return funReply(reply, r); }
  const r = fun.requestCast(body, funWho(req));
  if (!r.error) { audit(req, 'cast request', String(req.body?.url || '').slice(0, 120)); broadcastAccess(); }
  return funReply(reply, r);
});
app.post('/api/fun/cast/queue/:id', { preHandler: needOwner }, async (req, reply) => {
  const r = fun.castNow({ fromQueue: req.params.id }, funWho(req));
  if (!r.error) audit(req, 'cast', r.casting.url);
  return funReply(reply, r);
});
app.post('/api/fun/cast/stop', { preHandler: needMember }, async (req, reply) => {
  if (!fun.canControl(devKey(req.who), isOwner(req.who))) return reply.code(403).send({ error: 'only an owner, or whoever cast it' });
  audit(req, 'cast stopped');
  return fun.stopCast();
});
app.post('/api/fun/cast/:id/:action', { preHandler: needOwner }, async (req, reply) => {
  if (!['approve', 'deny'].includes(req.params.action)) return reply.code(400).send({ error: 'approve or deny' });
  const r = fun.decideCast(req.params.id, req.params.action === 'approve', funWho(req));
  if (!r.error) audit(req, `cast ${req.params.action}`, r.casting?.url);
  return funReply(reply, r);
});
app.post('/api/fun/pomo/:action', { preHandler: needWriter }, async (req, reply) => funReply(reply, fun.pomo(req.params.action, req.body || {}, funWho(req))));
app.post('/api/fun/game/:action', { preHandler: needWriter }, async (req, reply) => {
  if (req.params.action === 'clear' && !isOwner(req.who)) return reply.code(403).send({ error: 'only an owner can clear the game' });
  return funReply(reply, fun.game(req.params.action, req.body || {}));
});

app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
app.put('/api/drops', { preHandler: needMember, bodyLimit: DROP_QUOTA + 1 }, async (req, reply) => {
  if (!canWrite(req.who)) { req.body?.resume?.(); return reply.code(403).send({ error: 'Read-only right now (viewer or quiet hours)' }); }
  if (!req.body || typeof req.body.pipe !== 'function') return reply.code(415).send({ error: 'send the file as application/octet-stream' });
  const free = vitals().disk?.freeGB;
  if (free != null && free < 1) { req.body.resume(); return reply.code(507).send({ error: 'The laptop is almost out of disk space' }); }
  const len = Number(req.headers['content-length']);
  const r = await room.saveDrop(req.body, {
    name: req.query.name, devKey: devKey(req.who), byName: byName(req.who), declared: Number.isFinite(len) ? len : null,
  });
  if (r.error) return reply.code(r.code).send({ error: r.error });
  access?.log(access.actorName(req.who), 'drop', r.name, `${Math.round(r.bytes / 1024)} KB`);
  toMembers(JSON.stringify({ t: 'drops', drops: room.listDrops() }));
  return r;
});
// Types that are safe to show inside the app (never HTML/SVG/JS: those always download).
const INLINE_OK = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|application\/pdf|text\/plain)$/;
app.get('/api/drops/:id', { preHandler: needMember }, async (req, reply) => {
  const d = room.getDrop(req.params.id);
  if (!d) return reply.code(404).send({ error: 'gone (drops last 7 days)' });
  const mime = d.mime || 'application/octet-stream';
  const inline = req.query.inline === '1' && INLINE_OK.test(mime);
  reply.header('content-type', mime)
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`)
    .header('x-content-type-options', 'nosniff')
    .header('accept-ranges', 'bytes');
  if (inline && mime !== 'application/pdf') reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  // Range requests: lets the video player seek without downloading the whole file first.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? +m[1] : Math.max(0, d.bytes - +m[2]);
    let end = m[1] && m[2] ? Math.min(+m[2], d.bytes - 1) : d.bytes - 1;
    if (start >= d.bytes || start > end) return reply.code(416).header('content-range', `bytes */${d.bytes}`).send();
    reply.code(206).header('content-range', `bytes ${start}-${end}/${d.bytes}`).header('content-length', end - start + 1);
    return reply.send(room.readDrop(d, start, end));
  }
  reply.header('content-length', d.bytes);
  return reply.send(room.readDrop(d));
});
// Put a dropped picture / video / song on the wall: owners straight away, everyone else asks (owner approves).
app.post('/api/fun/cast/drop/:id', { preHandler: needWriter }, async (req, reply) => {
  const d = room.getDrop(req.params.id);
  if (!d) return reply.code(404).send({ error: 'gone (drops last 7 days)' });
  const kind = /^image\/(png|jpeg|gif|webp|avif)$/.test(d.mime) ? 'image' : /^video\/(mp4|webm|quicktime)$/.test(d.mime) ? 'video' : /^audio\//.test(d.mime) ? 'audio' : null;
  if (!kind) return reply.code(400).send({ error: 'Only pictures, videos and audio can go on the wall' });
  const link = { kind, url: `/api/drops/${d.id}?inline=1`, site: 'from a phone', title: d.name };
  if (isOwner(req.who)) { audit(req, 'cast', d.name); return fun.castRaw(link, funWho(req)); }
  const r = fun.requestRaw(link, funWho(req));
  audit(req, 'cast request', d.name);
  broadcastAccess();
  return r;
});
app.delete('/api/drops/:id', { preHandler: needMember }, async (req, reply) => {
  const d = room.getDrop(req.params.id);
  if (!d) return reply.code(404).send({ error: 'not found' });
  if (!isOwner(req.who) && d.by_dev !== devKey(req.who)) return reply.code(403).send({ error: 'only the uploader or an owner can delete it' });
  room.deleteDrop(d.id);
  access?.log(access.actorName(req.who), 'drop deleted', d.name);
  toMembers(JSON.stringify({ t: 'drops', drops: room.listDrops() }));
  return { ok: true };
});
setInterval(() => {
  const clients = app.websocketServer?.clients;
  if (!clients?.size) return;
  const msg = JSON.stringify({ t: 'vitals', v: vitals(), join: joinInfo() });
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}, VITALS_MS).unref();

// Quiet-hours rollover: owners' tray shows "quiet now" without anyone clicking.
let lastQuiet = null;
setInterval(() => { const q = access?.settings().quiet; const nowQ = access ? access.state().quiet.now : false; if (q && nowQ !== lastQuiet) { lastQuiet = nowQ; broadcastAccess(); } }, 30000).unref();

app.setErrorHandler((err, req, reply) => { reply.code(err.statusCode || 500).send({ error: err.message }); });
process.on('uncaughtException', (e) => { errors++; console.error('uncaught', e); });
process.on('unhandledRejection', (e) => { errors++; console.error('unhandled rejection', e); });

// ------------------------------------------------------------------ start / stop
try {
  await app.listen({ port: PORT, host: HOST });
} catch (e) {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other server (systemctl --user stop jharokha) or set PORT=<free port> (see .env.example).`);
  else console.error(e);
  process.exit(1);
}
console.log(`jharokha server listening on http://${HOST}:${PORT}  (node ${process.version}, fastify ${app.version})`);
console.log(`  on this machine : http://localhost:${PORT}/app/   (probe: /, what's new: /updates.html)`);
if (HOST === '0.0.0.0') {
  for (const a of lanAddrs()) console.log(`  ${a.iface.padEnd(15)} : http://${a.addr}:${PORT}/lan.html`);
  console.log('  (inside Crostini these are VM addresses; phones use the ChromeOS Wi-Fi IP after port forwarding)');
}
console.log(`  sqlite: ${JSON.stringify(sqliteInfo)}`);

async function stop() {
  try { fun.save(); } catch { /* best effort */ }
  try { tools.save(); } catch { /* best effort */ }
  tunnel.stop();
  snapshots.stop();
  try { room?.save(); } catch { /* best effort */ }
  checkpoint();
  try { await app.close(); } catch { /* already closing */ }
  try { db?.close(); } catch { /* closed */ }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
