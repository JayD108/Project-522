// Week 8 · Harden: ring-buffer logs and nightly SQLite snapshots.
//  · Logs: every console line goes to an in-RAM ring (last 1000 lines, for the System tab) AND to
//    DATA_DIR/logs/jharokha.log, which rotates at 1 MB and keeps 3 old files (≤ 4 MB on the HDD, ever).
//  · Snapshots: `VACUUM INTO` a consistent copy of the live WAL database once a night (03:30 local by
//    default) into DATA_DIR/backups/, keeping the newest 7. Owners can also take one now.

import fs from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------------------------------------- logs
export function createLogRing({ dir, max = 1000, fileMax = 1 << 20, keep = 3, now = () => Date.now() }) {
  const ring = [];
  let seq = 0;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'jharokha.log');
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* new */ }

  function rotate() {
    try {
      for (let i = keep - 1; i >= 1; i--) {
        const a = `${file}.${i}`, b = `${file}.${i + 1}`;
        if (fs.existsSync(a)) fs.renameSync(a, b);
      }
      if (fs.existsSync(`${file}.${keep + 1}`)) fs.rmSync(`${file}.${keep + 1}`);
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
    } catch { /* disk trouble: keep appending */ }
    size = 0;
  }

  function add(level, args) {
    const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack || a.message) : safeJson(a))).join(' ').slice(0, 2000);
    const at = now();
    const e = { n: ++seq, at, level, text };
    ring.push(e);
    if (ring.length > max) ring.splice(0, ring.length - max);
    const line = `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
    try {
      if (size + line.length > fileMax) rotate();
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch { /* read-only disk: the ring still works */ }
    return e;
  }

  /** Wrap console.log / warn / error so every line lands in the ring as well as journalctl. */
  function capture(con = console) {
    for (const level of ['log', 'warn', 'error']) {
      const orig = con[level].bind(con);
      con[level] = (...args) => {
        // Node's own "(node:123) ExperimentalWarning …" goes through console.error: it's a warning, not an error.
        const lv = level === 'log' ? 'info' : level === 'error' && /^\(node:\d+\) \w*Warning/.test(String(args[0] ?? '')) ? 'warn' : level;
        add(lv, args); orig(...args);
      };
    }
  }

  const tail = ({ n = 200, level = null, after = 0 } = {}) =>
    ring.filter((e) => e.n > after && (!level || e.level === level || (level === 'warn' && e.level === 'error'))).slice(-Math.min(1000, Math.max(1, n)));

  const files = () => {
    try {
      return fs.readdirSync(dir).filter((f) => f.startsWith('jharokha.log')).map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size }));
    } catch { return []; }
  };

  return { add, capture, tail, files, size: () => ring.length, file };
}

function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

// --------------------------------------------------------------------------------------- snapshots
/** ms until the next local hh:mm (tz offset in minutes east of UTC; Crostini runs UTC, so the laptop tells us). */
export function msUntil(hhmm, nowMs, tzOffsetMin = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  const local = new Date(nowMs + tzOffsetMin * 60000);
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - tzOffsetMin * 60000;
  let d = target - nowMs;
  if (d <= 0) d += 86_400_000;
  return d;
}

export function createSnapshots({ db, dir, keep = 7, at = '03:30', now = () => Date.now(), log = () => {}, tzOffset = () => 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  let timer = null;
  let last = null;      // { name, bytes, ms, at, ok, error }

  function list() {
    try {
      return fs.readdirSync(dir).filter((f) => /^jharokha-\d{8}-\d{6}\.sqlite$/.test(f)).sort().reverse()
        .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, bytes: st.size, at: st.mtimeMs }; });
    } catch { return []; }
  }

  function prune() {
    for (const f of list().slice(keep)) { try { fs.rmSync(path.join(dir, f.name)); } catch { /* */ } }
  }

  /** A consistent copy of the live database (WAL included), written in one go; old ones pruned. */
  function take(why = 'manual') {
    const t0 = Date.now();
    const d = new Date(now());
    const p2 = (x) => String(x).padStart(2, '0');
    const name = `jharokha-${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}.sqlite`;
    const out = path.join(dir, name);
    try {
      if (!db) throw new Error('no database');
      if (fs.existsSync(out)) fs.rmSync(out);
      db.prepare('VACUUM INTO ?').run(out);
      fs.chmodSync(out, 0o600);
      // sanity: it opens and has our tables
      last = { name, bytes: fs.statSync(out).size, ms: Date.now() - t0, at: now(), ok: true, why };
      prune();
      log(`snapshot ${name} (${Math.round(last.bytes / 1024)} KB, ${last.ms} ms, ${why})`);
    } catch (e) {
      last = { name, ms: Date.now() - t0, at: now(), ok: false, error: String(e?.message || e), why };
      log(`snapshot FAILED: ${last.error}`);
    }
    return last;
  }

  function schedule() {
    clearTimeout(timer);
    const ms = msUntil(at, now(), tzOffset());
    timer = setTimeout(() => { take('nightly'); schedule(); }, ms);
    timer.unref?.();
    return ms;
  }

  function status() {
    return { dir, keep, at, last, list: list(), nextInMs: msUntil(at, now(), tzOffset()) };
  }

  return { take, list, schedule, status, stop: () => clearTimeout(timer) };
}
