// Week 4 · Access (v2 §3.3): QR join → name → owner approves with a role → device token (HttpOnly cookie, 30 days).
// Owners: requests from inside Linux (loopback: tests, curl, scripts) or a device with role "owner".
// The laptop's Chrome becomes an owner by pairing once: `npm run pair` opens /app/?pair=<one-time code>.
// Also: kill switch (owner-only mode), quiet hours (friends read-only), audit log, rate limits, max 20 users.

import crypto from 'node:crypto';

export const TOKEN_DAYS = 30;
export const MAX_USERS = 20;
export const COOKIE = 'jhk_dev';
const DAY = 86400000;
const PAIR_MS = 10 * 60 * 1000;
export const ROLES = ['owner', 'collaborator', 'viewer'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newId = () => crypto.randomBytes(6).toString('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** "HH:MM" window that may wrap midnight. */
export function inWindow(now, start, end) {
  const m = (s) => { const [h, mi] = String(s).split(':').map(Number); return h * 60 + mi; };
  const t = now.getHours() * 60 + now.getMinutes(), a = m(start), b = m(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** Tiny token bucket: `perMin` requests per minute per key. */
export function makeLimiter(perMin) {
  const b = new Map();
  return (key, now = Date.now()) => {
    const e = b.get(key) || { n: perMin, t: now };
    e.n = Math.min(perMin, e.n + ((now - e.t) / 60000) * perMin);
    e.t = now;
    if (e.n < 1) { b.set(key, e); return false; }
    e.n -= 1; b.set(key, e);
    if (b.size > 5000) b.clear();        // memory guard
    return true;
  };
}

export function createAccess(db, { trustedIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'], kvGet, kvSet, now = () => Date.now() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, expires_at INTEGER NOT NULL,
      last_seen INTEGER, ip TEXT, ua TEXT);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);`);
  const q = {
    byHash: db.prepare('SELECT * FROM devices WHERE token_hash = ?'),
    byId: db.prepare('SELECT * FROM devices WHERE id = ?'),
    insert: db.prepare('INSERT INTO devices (id, token_hash, name, role, status, created_at, decided_at, expires_at, last_seen, ip, ua) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    decide: db.prepare('UPDATE devices SET status = ?, role = ?, decided_at = ?, expires_at = ? WHERE id = ?'),
    seen: db.prepare('UPDATE devices SET last_seen = ?, ip = ? WHERE id = ?'),
    extend: db.prepare('UPDATE devices SET expires_at = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM devices WHERE id = ?'),
    list: db.prepare("SELECT id, name, role, status, created_at, decided_at, expires_at, last_seen, ip, ua FROM devices WHERE status IN ('pending','approved') ORDER BY created_at DESC"),
    active: db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status IN ('pending','approved') AND expires_at > ?"),
    prune: db.prepare("DELETE FROM devices WHERE (status IN ('denied','revoked') AND decided_at < ?) OR expires_at < ?"),
    audit: db.prepare('INSERT INTO audit (at, actor, action, target, detail) VALUES (?,?,?,?,?)'),
    auditList: db.prepare('SELECT at, actor, action, target, detail FROM audit ORDER BY id DESC LIMIT ?'),
    auditPrune: db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 2000)'),
  };
  const lastSeenWrite = new Map();      // batch last_seen writes: at most once per device per minute (HDD)

  const log = (actor, action, target = null, detail = null) => {
    q.audit.run(now(), actor, action, target, detail == null ? null : String(detail));
    if (Math.random() < 0.02) q.auditPrune.run();
  };

  const settings = () => ({
    kill: !!kvGet('killSwitch'),
    quiet: { enabled: false, start: '00:30', end: '07:00', ...(kvGet('quietHours') || {}) },
  });
  const quietNow = () => { const s = settings().quiet; return s.enabled && inWindow(new Date(now()), s.start, s.end); };

  /** Who is asking: { loopback } | { dev } | { dev: null } */
  function identify(req) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    const token = parseCookies(req.headers.cookie)[COOKIE];
    let dev = null;
    if (token) {
      const d = q.byHash.get(sha(token));
      if (d && d.expires_at > now() && (d.status === 'pending' || d.status === 'approved')) dev = d;
    }
    if (dev) {
      const t = now();
      if (t - (lastSeenWrite.get(dev.id) || 0) > 60000) {
        lastSeenWrite.set(dev.id, t); q.seen.run(t, ip, dev.id);
        // Owners stay signed in while they keep using it (sliding 30 days); everyone else has a fixed 30 days.
        if (dev.role === 'owner' && dev.status === 'approved' && dev.expires_at - t < (TOKEN_DAYS - 1) * DAY) q.extend.run(t + TOKEN_DAYS * DAY, dev.id);
      }
    }
    // Trusted only if it comes from inside Linux (or ChromeOS's own localhost tunnel) AND was addressed to localhost.
    // A phone always addresses the laptop's Wi-Fi IP, so even if a forwarder made it look like 127.0.0.1 it isn't trusted.
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const loopback = trustedIps.includes(ip) && ['localhost', '127.0.0.1', '::1'].includes(host);
    return { loopback, dev, ip };
  }
  const isOwner = (who) => who.loopback || (who.dev?.status === 'approved' && who.dev.role === 'owner');
  const isMember = (who) => isOwner(who) || who.dev?.status === 'approved';
  const actorName = (who) => (who.dev ? `${who.dev.name} (${who.dev.role || who.dev.status})` : 'laptop (Linux)');

  /** The role a device actually has right now (quiet hours → friends are viewers). */
  function effectiveRole(dev) {
    if (!dev || dev.status !== 'approved') return null;
    if (dev.role !== 'owner' && quietNow()) return 'viewer';
    return dev.role;
  }

  /** Over the https internet link the cookie is also `Secure` (never sent over plain http). */
  function cookieFor(token, maxAgeS, secure = false) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
  }

  function requestJoin({ name, ip, ua, secure = false }) {
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32);
    if (clean.length < 1) return { error: 'Please type your name', code: 400 };
    if (settings().kill) return { error: 'The room is in owner-only mode right now', code: 403 };
    q.prune.run(now() - 7 * DAY, now());
    if (q.active.get(now()).n >= MAX_USERS) return { error: `The room is full (${MAX_USERS} devices)`, code: 429 };
    const token = newToken(), id = newId(), t = now();
    q.insert.run(id, sha(token), clean, null, 'pending', t, null, t + TOKEN_DAYS * DAY, t, ip, String(ua || '').slice(0, 160));
    log(clean, 'join-request', null, ip);
    return { id, token, cookie: cookieFor(token, TOKEN_DAYS * 86400, secure) };
  }

  function decide(who, id, action, role) {
    const d = q.byId.get(id);
    if (!d) return { error: 'No such device', code: 404 };
    const t = now();
    if (action === 'approve' || action === 'role') {
      if (!ROLES.includes(role)) return { error: 'Pick a role', code: 400 };
      if (action === 'role' && d.status !== 'approved') return { error: 'Approve them first', code: 409 };
      if (d.status !== 'pending' && d.status !== 'approved') return { error: `Device is ${d.status}`, code: 409 };
      q.decide.run('approved', role, t, t + TOKEN_DAYS * DAY, id);
    } else if (action === 'deny') q.decide.run('denied', null, t, d.expires_at, id);
    else if (action === 'revoke') q.decide.run('revoked', d.role, t, d.expires_at, id);
    else return { error: 'Unknown action', code: 400 };
    log(actorName(who), action === 'role' ? `role → ${role}` : action, d.name, action === 'approve' ? role : null);
    return { ok: true };
  }

  /** Anyone may lower their OWN role (owner → collaborator → viewer); nobody can raise their own. */
  function selfRole(who, role) {
    const d = who.dev;
    if (!d || d.status !== 'approved') return { error: 'Not a member', code: 403 };
    const rank = { viewer: 0, collaborator: 1, owner: 2 };
    if (!(role in rank)) return { error: 'Pick a role', code: 400 };
    if (rank[role] >= rank[d.role]) return { error: 'You can only step down. Ask an owner to promote you.', code: 403 };
    q.decide.run('approved', role, now(), d.expires_at, d.id);
    log(d.name, `stepped down → ${role}`, d.name);
    return { ok: true };
  }

  function leave(who) {
    if (!who.dev) return;
    q.del.run(who.dev.id);
    log(who.dev.name, 'left', who.dev.name);
  }

  // ---- pairing the laptop's Chrome (one-time code, 10 min, only obtainable from inside Linux)
  // A phone that will be the owner's controller app gets its own, longer code (it may travel over the internet link).
  function newPairCode(who, { phone = false } = {}) {
    const code = crypto.randomBytes(phone ? 16 : 5).toString('hex');
    kvSet(phone ? 'pairPhone' : 'pair', { hash: sha(code), exp: now() + PAIR_MS });
    log(actorName(who), phone ? 'pair-code (phone app)' : 'pair-code');
    return code;
  }
  function pair({ code, name, ip, ua, secure = false }) {
    const key = ['pair', 'pairPhone'].find((k) => { const p = kvGet(k); return p && p.exp >= now() && code && sha(String(code)) === p.hash; });
    if (!key) return { error: 'Pairing code is wrong or expired. Make a new one: laptop dashboard → Access → "Pair my phone" (or `npm run pair` for the laptop)', code: 403 };
    kvSet(key, null);
    const token = newToken(), id = newId(), t = now();
    const label = String(name || (key === 'pairPhone' ? 'Owner phone' : 'Laptop')).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || (key === 'pairPhone' ? 'Owner phone' : 'Laptop');
    q.insert.run(id, sha(token), label, 'owner', 'approved', t, t, t + TOKEN_DAYS * DAY, t, ip, String(ua || '').slice(0, 160));
    log(label, key === 'pairPhone' ? 'paired as owner (phone app)' : 'paired as owner', null, ip);
    return { id, token, cookie: cookieFor(token, TOKEN_DAYS * 86400, secure) };
  }

  function setKill(who, on) {
    kvSet('killSwitch', !!on);
    log(actorName(who), on ? 'kill-switch ON' : 'kill-switch off');
  }
  function setQuiet(who, patch) {
    const cur = settings().quiet;
    const next = { ...cur };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    for (const k of ['start', 'end']) if (patch[k] !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(patch[k])) return { error: `${k} must be HH:MM`, code: 400 };
      next[k] = patch[k];
    }
    kvSet('quietHours', next);
    log(actorName(who), 'quiet-hours', null, `${next.enabled ? 'on' : 'off'} ${next.start}–${next.end}`);
    return { ok: true, quiet: next };
  }

  function state() {
    const t = now();
    const devices = q.list.all().filter((d) => d.expires_at > t).map((d) => ({
      id: d.id, name: d.name, role: d.role, status: d.status, createdAt: d.created_at, decidedAt: d.decided_at,
      expiresAt: d.expires_at, lastSeen: d.last_seen, ip: d.ip, ua: shortUa(d.ua),
    }));
    const s = settings();
    return { devices, pending: devices.filter((d) => d.status === 'pending').length, kill: s.kill, quiet: { ...s.quiet, now: quietNow() }, max: MAX_USERS };
  }
  const audit = (n = 50) => q.auditList.all(n);

  function me(who) {
    const d = who.dev;
    const s = settings();
    if (!d) return { status: who.loopback ? 'owner' : 'none', owner: who.loopback, kill: s.kill };
    return {
      id: d.id, status: d.status, name: d.name, role: d.role, effectiveRole: effectiveRole(d), owner: isOwner(who),
      expiresAt: d.expires_at, quiet: d.role !== 'owner' && quietNow(), kill: s.kill,
    };
  }

  return { identify, isOwner, isMember, requestJoin, decide, selfRole, leave, newPairCode, pair, setKill, setQuiet, settings, state, audit, me, effectiveRole, log, actorName };
}

export function shortUa(ua = '') {
  if (!ua) return '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 30);
}
