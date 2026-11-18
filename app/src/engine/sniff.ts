// Cheap container sniff: looks for codec FourCCs / Matroska CodecIDs in the head and tail.
// Good enough to catch AV1/HEVC at import time; mediaCapabilities does the real check.

export type Codec = 'H.264' | 'H.264-webm' | 'VP9' | 'VP9-mp4' | 'VP8' | 'AV1' | 'AV1-webm' | 'HEVC' | 'unknown';

const WINDOW = 4 << 20;

export function sniffCodec(u8: Uint8Array): Codec {
  const parts = u8.length <= 2 * WINDOW ? [u8] : [u8.subarray(0, WINDOW), u8.subarray(u8.length - WINDOW)];
  const has = (s: string) => parts.some((p) => indexOfAscii(p, s) >= 0);
  if (has('V_AV1')) return 'AV1-webm';
  if (has('V_VP9')) return 'VP9';
  if (has('V_VP8')) return 'VP8';
  if (has('V_MPEG4/ISO/AVC')) return 'H.264-webm';
  if (has('av01')) return 'AV1';
  if (has('vp09')) return 'VP9-mp4';
  if (has('hvc1') || has('hev1')) return 'HEVC';
  if (has('avc1') || has('avc3')) return 'H.264';
  return 'unknown';
}

/** H.264 / VP9 / VP8 are allowed. AV1 = CPU decode on Gen 9.5 → rejected. HEVC is HW on this GPU but not reliably exposed by ChromeOS → warn. */
export function codecVerdict(c: Codec): 'ok' | 'warn' | 'reject' {
  if (c === 'AV1' || c === 'AV1-webm') return 'reject';
  if (c === 'HEVC' || c === 'unknown') return 'warn';
  return 'ok';
}

export function mimeFor(c: Codec, fileName = ''): string {
  if (/webm$/i.test(fileName) || c === 'VP9' || c === 'VP8' || c === 'AV1-webm' || c === 'H.264-webm') return 'video/webm';
  return 'video/mp4';
}

export function indexOfAscii(hay: Uint8Array, str: string): number {
  const n = str.length, c0 = str.charCodeAt(0);
  outer: for (let i = 0; i <= hay.length - n; i++) {
    if (hay[i] !== c0) continue;
    for (let j = 1; j < n; j++) if (hay[i + j] !== str.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
