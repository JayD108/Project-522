// Week 5 · Collaborate (v2 §4): Room Board (Yjs, conflict-free), Door Sign, Drop Zone, owner remote relay.
// Board: one Y.Doc kept in RAM, saved to SQLite every 30 s when changed (v2 §5: gentle on the HDD).
// Drop Zone: files written sequentially to DATA_DIR/drops, 500 MB per device, deleted after 7 days.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import * as Y from 'yjs';
import { decryptRange, encryptor, jpegScrubber, loadKey, sniffMime } from './vault.mjs';

export const DROP_QUOTA = Number(process.env.JHK_DROP_QUOTA_MB || 500) * 2 ** 20;
export const DROP_DAYS = 7;
const SAVE_MS = 30_000;
export const DOOR = ['Come in', 'Knock first', 'Busy', 'Studying', 'Sleeping', 'Away'];

export function createRoom(db, { dataDir, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS room (k TEXT PRIMARY KEY, v BLOB NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drops (id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT,
      by_dev TEXT, by_name TEXT NOT NULL, at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);

  // ---------------------------------------------------------------- board (Yjs)
  const doc = new Y.Doc();
  const saved = db.prepare("SELECT v FROM room WHERE k = 'board'").get();
  if (saved) { try { Y.applyUpdate(doc, new Uint8Array(saved.v)); } catch { /* corrupt: start empty */ } }
  let dirty = false;
  doc.on('update', () => { dirty = true; });
  const saveStmt = db.prepare("INSERT INTO room (k, v, at) VALUES ('board', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at");
  function save() {
    if (!dirty) return;
    dirty = false;
    saveStmt.run(Buffer.from(Y.encodeStateAsUpdate(doc)), now());
  }
  setInterval(save, SAVE_MS).unref();

  /** Client sent its state vector: reply with what it is missing. */
  const diffFor = (svB64) => Buffer.from(Y.encodeStateAsUpdate(doc, svB64 ? new Uint8Array(Buffer.from(svB64, 'base64')) : undefined)).toString('base64');
  /** Apply a client update. Returns false if it doesn't parse. Size-capped so one phone can't bloat the doc. */
  function applyFrom(b64, origin) {
    if (typeof b64 !== 'string' || b64.length > 256 * 1024) return false;
    try { Y.applyUpdate(doc, new Uint8Array(Buffer.from(b64, 'base64')), origin); return true; } catch { return false; }
  }
  const onUpdate = (fn) => doc.on('update', (u, origin) => fn(Buffer.from(u).toString('base64'), origin));
  const noteCount = () => doc.getArray('notes').length;

  // ---------------------------------------------------------------- door sign (owners set it; everyone sees it)
  const getDoor = () => {
    const r = db.prepare("SELECT v FROM room WHERE k = 'door'").get();
    try { return r ? JSON.parse(Buffer.from(r.v).toString()) : { status: 'Come in', note: '', by: null, at: null }; } catch { return { status: 'Come in', note: '', by: null, at: null }; }
  };
  function setDoor({ status, note }, by) {
    if (!DOOR.includes(status)) return { error: `status must be one of: ${DOOR.join(', ')}`, code: 400 };
    const d = { status, note: String(note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80), by, at: now() };
    db.prepare("INSERT INTO room (k, v, at) VALUES ('door', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").run(Buffer.from(JSON.stringify(d)), d.at);
    return { ok: true, door: d };
  }

  // ---------------------------------------------------------------- drop zone
  const DROPS = path.join(dataDir, 'drops');
  fs.mkdirSync(DROPS, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DROPS, 0o700); } catch { /* not ours */ }
  const KEY = loadKey(dataDir);
  try { db.exec('ALTER TABLE drops ADD COLUMN iv TEXT'); } catch { /* already there */ }
  const q = {
    list: db.prepare('SELECT id, name, bytes, mime, by_dev AS byDev, by_name AS byName, at, expires_at AS expiresAt FROM drops WHERE expires_at > ? ORDER BY at DESC'),
    used: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM drops WHERE by_dev = ? AND expires_at > ?'),
    get: db.prepare('SELECT * FROM drops WHERE id = ?'),
    ins: db.prepare('INSERT INTO drops (id, name, bytes, mime, by_dev, by_name, at, expires_at, iv) VALUES (?,?,?,?,?,?,?,?,?)'),
    del: db.prepare('DELETE FROM drops WHERE id = ?'),
    expired: db.prepare('SELECT id FROM drops WHERE expires_at <= ?'),
  };
  const fileOf = (id) => path.join(DROPS, id.replace(/[^a-f0-9]/g, ''));
  const listDrops = () => q.list.all(now());
  const usedBy = (devKey) => q.used.get(devKey, now()).n;

  /** Stream a body to disk (one sequential write): quota → sniff the real type → strip photo metadata → encrypt → 0600 file. */
  async function saveDrop(stream, { name, devKey, byName, declared }) {
    const clean = String(name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'file';
    const left = DROP_QUOTA - usedBy(devKey);
    if (declared != null && declared > left) return { error: `Over your ${Math.round(DROP_QUOTA / 2 ** 20)} MB drop quota (${Math.max(0, Math.round(left / 2 ** 20))} MB left)`, code: 413 };
    const id = crypto.randomBytes(8).toString('hex');
    const file = fileOf(id);
    let bytes = 0, head = Buffer.alloc(0), stored = 0;
    const counter = new Transform({
      transform(chunk, _e, cb) {
        bytes += chunk.length;
        if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
        if (bytes > left) cb(Object.assign(new Error('quota'), { quota: true })); else cb(null, chunk);
      },
    });
    const scrub = jpegScrubber();
    const iv = crypto.randomBytes(16);
    const sizer = new Transform({ transform(chunk, _e, cb) { stored += chunk.length; cb(null, chunk); } });
    try {
      await pipeline(stream, counter, scrub, sizer, encryptor(KEY, iv), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    } catch (e) {
      fs.rmSync(file, { force: true });
      if (e.quota) return { error: `Over your ${Math.round(DROP_QUOTA / 2 ** 20)} MB drop quota`, code: 413 };
      return { error: 'Upload interrupted', code: 400 };
    }
    if (!bytes) { fs.rmSync(file, { force: true }); return { error: 'Empty file', code: 400 }; }
    const t = now();
    const mime = sniffMime(head);                    // from the bytes, not from the phone's claim
    q.ins.run(id, clean, stored, mime, devKey, byName, t, t + DROP_DAYS * 86400000, iv.toString('hex'));
    return { ok: true, id, name: clean, bytes: stored, mime, scrubbed: scrub.removed() };
  }
  const getDrop = (id) => { const d = q.get.get(id); return d && d.expires_at > now() && fs.existsSync(fileOf(id)) ? { ...d, file: fileOf(id) } : null; };
  /** Plaintext bytes [start, end] (inclusive) of a drop. Older, pre-encryption files are read as they are. */
  const readDrop = (d, start = 0, end = d.bytes - 1) => (d.iv
    ? decryptRange(d.file, KEY, Buffer.from(d.iv, 'hex'), start, end)
    : fs.createReadStream(d.file, { start, end }));
  function deleteDrop(id) { q.del.run(id); fs.rmSync(fileOf(id), { force: true }); }
  function cleanup() {
    let n = 0;
    for (const { id } of q.expired.all(now())) { deleteDrop(id); n++; }
    // Orphans (crash mid-upload) older than a day.
    for (const f of fs.readdirSync(DROPS)) {
      if (!q.get.get(f)) { const st = fs.statSync(path.join(DROPS, f)); if (now() - st.mtimeMs > 86400000) { fs.rmSync(path.join(DROPS, f), { force: true }); n++; } }
    }
    return n;
  }
  setInterval(cleanup, 3600_000).unref();
  cleanup();

  return { doc, diffFor, applyFrom, onUpdate, save, noteCount, getDoor, setDoor, listDrops, usedBy, saveDrop, getDrop, readDrop, deleteDrop, cleanup };
}
