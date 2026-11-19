// Drop-zone storage that is safe at rest.
//  · Every file is encrypted on disk with AES-256-CTR (random 16-byte IV per file). The key lives in
//    DATA_DIR/keys/drops.key (mode 0600, folder 0700), readable only by the server's user. CTR lets us decrypt any byte
//    range, so videos can still seek. ChromeOS also encrypts the whole Linux disk with your login, so this is a 2nd layer.
//  · The file TYPE is decided from the bytes (magic numbers), never from what the phone claims. Anything we don't
//    recognise is stored as application/octet-stream: download only, never shown inside the app.
//  · Photos: EXIF / XMP / IPTC metadata (GPS location, phone model, time) is removed from JPEGs before saving.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';

export function loadKey(dataDir) {
  const dir = path.join(dataDir, 'keys');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ }
  const f = path.join(dir, 'drops.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = fs.readFileSync(f);
  if (key.length !== 32) throw new Error('drops.key is damaged');
  return key;
}

/** IV for AES-CTR after `blocks` 16-byte blocks (128-bit big-endian counter add). */
export function ivAt(iv, blocks) {
  const out = Buffer.from(iv);
  let carry = BigInt(blocks);
  for (let i = 15; i >= 0 && carry > 0n; i--) {
    const sum = BigInt(out[i]) + (carry & 0xffn);
    out[i] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return out;
}

export const encryptor = (key, iv) => crypto.createCipheriv('aes-256-ctr', key, iv);

/** Read plaintext bytes [start, end] of an encrypted file as a stream. */
export function decryptRange(file, key, iv, start, end) {
  const blockStart = Math.floor(start / 16) * 16;
  const skip = start - blockStart;
  const dec = crypto.createDecipheriv('aes-256-ctr', key, ivAt(iv, blockStart / 16));
  let toSkip = skip;
  const trim = new Transform({
    transform(chunk, _e, cb) {
      if (toSkip) { const n = Math.min(toSkip, chunk.length); chunk = chunk.subarray(n); toSkip -= n; }
      cb(null, chunk);
    },
  });
  return fs.createReadStream(file, { start: blockStart, end }).pipe(dec).pipe(trim);
}

/** What the bytes really are. */
export function sniffMime(h) {
  const s = (o, str) => h.length >= o + str.length && h.toString('latin1', o, o + str.length) === str;
  if (h[0] === 0x89 && s(1, 'PNG')) return 'image/png';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (s(0, 'GIF87a') || s(0, 'GIF89a')) return 'image/gif';
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
  if (s(0, 'RIFF') && s(8, 'WAVE')) return 'audio/wav';
  if (s(4, 'ftyp')) {
    const brand = h.toString('latin1', 8, 12);
    if (/^(avif|avis)/.test(brand)) return 'image/avif';
    if (/^(M4A |M4B )/.test(brand)) return 'audio/mp4';
    if (/^qt/.test(brand)) return 'video/quicktime';
    return 'video/mp4';
  }
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return 'video/webm';
  if (s(0, 'OggS')) return 'audio/ogg';
  if (s(0, 'ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (s(0, 'fLaC')) return 'audio/flac';
  if (s(0, '%PDF-')) return 'application/pdf';
  // Plain text: valid UTF-8, no NULs, no markup that a browser might treat as a page.
  const head = h.subarray(0, 4096);
  if (head.length && !head.includes(0)) {
    const t = head.toString('utf8');
    if (!t.includes('�') && !/<\s*(script|html|svg|iframe|body|head|!doctype)/i.test(t)) return 'text/plain';
  }
  return 'application/octet-stream';
}

/**
 * Remove JPEG metadata segments (APP1 = EXIF/XMP incl. GPS, APP13 = IPTC) while streaming.
 * Keeps everything else byte-for-byte (APP0/JFIF, ICC colour profile in APP2, image data).
 * Non-JPEG input passes straight through.
 */
export function jpegScrubber() {
  let buf = Buffer.alloc(0), state = 'start', removed = 0;
  const t = new Transform({
    transform(chunk, _e, cb) {
      if (state === 'pass') return cb(null, chunk);
      buf = Buffer.concat([buf, chunk]);
      const out = [];
      if (state === 'start') {
        if (buf.length < 2) return cb();
        if (!(buf[0] === 0xff && buf[1] === 0xd8)) { state = 'pass'; const b = buf; buf = Buffer.alloc(0); return cb(null, b); }
        out.push(buf.subarray(0, 2)); buf = buf.subarray(2); state = 'seg';
      }
      while (state === 'seg') {
        if (buf.length < 4) break;
        if (buf[0] !== 0xff) { state = 'pass'; break; }                 // not a marker: give up scrubbing, keep data
        const marker = buf[1];
        if (marker === 0xda || marker === 0xd9) { state = 'pass'; break; } // start of scan: metadata section is over
        const len = buf.readUInt16BE(2);
        if (buf.length < 2 + len) break;
        const seg = buf.subarray(0, 2 + len);
        if (marker === 0xe1 || marker === 0xed) removed += seg.length; else out.push(seg);
        buf = buf.subarray(2 + len);
        if (out.reduce((a, b) => a + b.length, 0) > 4 * 2 ** 20) { state = 'pass'; break; }
      }
      if (state === 'pass') { out.push(buf); buf = Buffer.alloc(0); }
      cb(null, Buffer.concat(out));
    },
    flush(cb) { cb(null, buf); },
  });
  t.removed = () => removed;
  return t;
}
