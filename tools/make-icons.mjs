// Generates the Jharokha app icons (an arched window) as PNGs with no dependencies.
// Usage: node tools/make-icons.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = process.argv[2] || '.';
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };

function icon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = size / 2, w = size * 0.26, top = size * 0.42, bottom = size * 0.80, stroke = size * 0.035;
  // inside(x,y,inset): point within the arch shape shrunk by `inset`
  const inside = (x, y, i) => {
    if (y > bottom - i || x < cx - w + i || x > cx + w - i) return false;
    if (y >= top) return true;
    const r = w - i; return (x - cx) ** 2 + (y - top) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 13, g = 12, b = 11; // background
      if (inside(x, y, 0)) {
        if (!inside(x, y, stroke)) { r = 224; g = 164; b = 88; }            // amber frame
        else { const t = (y - (top - w)) / (bottom - top + w);               // dusk sky
          r = Math.round(60 + 150 * t); g = Math.round(40 + 70 * t); b = Math.round(70 - 30 * t); }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(out, { recursive: true });
for (const s of [192, 512]) fs.writeFileSync(path.join(out, `icon-${s}.png`), icon(s));
console.log(`icons written to ${out}`);
