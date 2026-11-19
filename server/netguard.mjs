// "Same Wi-Fi only" for the internet link.
// Phones reach the laptop through the Cloudflare tunnel (the hostel Wi-Fi blocks phone → laptop traffic), so every
// request looks like it comes from the internet. Cloudflare tells us the phone's PUBLIC address (CF-Connecting-IP).
// Everyone on the same Wi-Fi leaves the building through the same public network as the laptop, so:
//   same network prefix as the laptop (IPv4 /24, IPv6 /48)  →  same Wi-Fi  →  allowed
//   anything else (mobile data, another building)             →  refused, unless the owner chose "Anywhere"
// Plus a room code inside the QR (changes every 10 min): to ASK to join you must have seen the QR in the room.

import crypto from 'node:crypto';

const ROTATE_MS = 10 * 60 * 1000;
const LOOKUP_MS = 10 * 60 * 1000;

/** Network prefix of an address: IPv4 a.b.c (/24), IPv6 first three groups (/48). null if unparseable. */
export function prefixOf(ip) {
  if (!ip) return null;
  let s = String(ip).trim().replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) return v4.slice(1, 4).every((x) => +x <= 255) ? `${v4[1]}.${v4[2]}.${v4[3]}.0/24` : null;
  if (!s.includes(':')) return null;
  s = s.split('%')[0];
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = s.includes('::') && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return `${groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(':')}::/48`;
}

/** Cloudflare's trace endpoint tells us the laptop's own public address (no account, no key). */
async function publicIp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const m = /^ip=(.+)$/m.exec(await r.text());
    return m ? m[1].trim() : null;
  } catch { return null; }
}

export function createNetGuard({ kvGet, kvSet, log = () => {}, onChange = () => {}, lookup = true, laptopIp = null, fixedCode = null, now = () => Date.now() }) {
  let st = {
    mode: 'wifi',                 // 'wifi' = same Wi-Fi only (default) · 'anywhere' = approved people from any network
    trusted: [],                  // extra prefixes the owner allowed (e.g. a second building, the phone's IPv6)
    ...(kvGet('netguard') || {}),
  };
  let laptop = { v4: laptopIp && !laptopIp.includes(':') ? laptopIp : null, v6: laptopIp?.includes(':') ? laptopIp : null, at: laptopIp ? now() : null };
  let blocked = [];               // recent refused attempts: { ip, prefix, at, ua, path }
  let code = fixedCode ? { cur: fixedCode, prev: null, at: Infinity } : (kvGet('roomCode') || { cur: newCode(), prev: null, at: now() });

  function newCode() { return crypto.randomBytes(4).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 6); }
  const save = () => { kvSet('netguard', { mode: st.mode, trusted: st.trusted }); onChange(); };

  async function refresh() {
    if (!lookup) return;
    const [v4, v6] = await Promise.all([publicIp('https://1.1.1.1/cdn-cgi/trace'), publicIp('https://[2606:4700:4700::1111]/cdn-cgi/trace')]);
    if (v4 || v6) { laptop = { v4, v6, at: now() }; onChange(); }
  }
  if (lookup) { refresh(); setInterval(refresh, LOOKUP_MS).unref(); }

  function rotate() {
    if (fixedCode || now() - code.at < ROTATE_MS) return;
    code = { cur: newCode(), prev: code.cur, at: now() };
    kvSet('roomCode', code);
    onChange();
  }
  setInterval(rotate, 30_000).unref();

  const roomPrefixes = () => [...new Set([prefixOf(laptop.v4), prefixOf(laptop.v6), ...st.trusted].filter(Boolean))];

  /** May this internet visitor use the room? (Requests over the Wi-Fi / from the laptop never come here.) */
  function allows(ip) {
    if (st.mode === 'anywhere') return true;
    const p = prefixOf(ip);
    const room = roomPrefixes();
    // Before we know the laptop's own address (no internet yet), don't lock everyone out.
    if (!room.length) return true;
    return !!p && room.includes(p);
  }

  function noteBlocked(ip, ua, path) {
    const p = prefixOf(ip);
    const last = blocked[0];
    if (last && last.ip === ip && now() - last.at < 60_000) return;
    blocked = [{ ip, prefix: p, at: now(), ua: String(ua || '').slice(0, 80), path: String(path || '').slice(0, 60) }, ...blocked].slice(0, 10);
    log(`refused (not on the room's Wi-Fi): ${ip}`);
    onChange();
  }

  const codeOk = (k) => !!k && (k === code.cur || (k === code.prev && now() - code.at < ROTATE_MS));

  function setMode(mode) { if (!['wifi', 'anywhere'].includes(mode)) return { error: 'mode must be wifi or anywhere', code: 400 }; st.mode = mode; save(); return { ok: true }; }
  function trust(prefix) {
    const p = String(prefix || '');
    if (!/^[0-9a-f.:]+\/(24|48)$/i.test(p)) return { error: 'not a network prefix', code: 400 };
    if (!st.trusted.includes(p)) st.trusted = [...st.trusted, p].slice(-10);
    blocked = blocked.filter((b) => b.prefix !== p);
    save();
    return { ok: true };
  }
  function untrust(prefix) { st.trusted = st.trusted.filter((x) => x !== prefix); save(); return { ok: true }; }

  const status = () => ({
    mode: st.mode, trusted: st.trusted, room: roomPrefixes(), laptop, blocked,
    codeRotatesInS: fixedCode ? null : Math.max(0, Math.round((code.at + ROTATE_MS - now()) / 1000)),
  });

  return { allows, noteBlocked, codeOk, code: () => code.cur, setMode, trust, untrust, status, refresh, rotate };
}
