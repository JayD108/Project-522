import { describe, expect, it } from 'vitest';
import { codecVerdict, indexOfAscii, mimeFor, sniffCodec } from './sniff';

const bytes = (s: string, pad = 64) => {
  const u = new Uint8Array(pad * 2 + s.length);
  for (let i = 0; i < s.length; i++) u[pad + i] = s.charCodeAt(i);
  return u;
};

describe('sniffCodec', () => {
  it('detects MP4 fourccs', () => {
    expect(sniffCodec(bytes('stsd....avc1'))).toBe('H.264');
    expect(sniffCodec(bytes('hvc1'))).toBe('HEVC');
    expect(sniffCodec(bytes('av01'))).toBe('AV1');
    expect(sniffCodec(bytes('vp09'))).toBe('VP9-mp4');
  });
  it('detects Matroska codec ids', () => {
    expect(sniffCodec(bytes('V_VP9'))).toBe('VP9');
    expect(sniffCodec(bytes('V_AV1'))).toBe('AV1-webm');
    expect(sniffCodec(bytes('V_MPEG4/ISO/AVC'))).toBe('H.264-webm');
  });
  it('checks the tail of big files (moov at end, no faststart)', () => {
    const big = new Uint8Array(20 << 20);
    big.set([...'avc1'].map((c) => c.charCodeAt(0)), big.length - 1000);
    expect(sniffCodec(big)).toBe('H.264');
  });
  it('returns unknown on noise', () => {
    expect(sniffCodec(new Uint8Array(1000))).toBe('unknown');
  });
});

describe('verdicts', () => {
  it('rejects AV1, warns on HEVC/unknown, allows H.264/VP9', () => {
    expect(codecVerdict('AV1')).toBe('reject');
    expect(codecVerdict('AV1-webm')).toBe('reject');
    expect(codecVerdict('HEVC')).toBe('warn');
    expect(codecVerdict('unknown')).toBe('warn');
    expect(codecVerdict('H.264')).toBe('ok');
    expect(codecVerdict('VP9')).toBe('ok');
  });
  it('picks mime from codec / extension', () => {
    expect(mimeFor('VP9')).toBe('video/webm');
    expect(mimeFor('H.264', 'clip.mp4')).toBe('video/mp4');
    expect(mimeFor('unknown', 'x.webm')).toBe('video/webm');
  });
  it('indexOfAscii', () => {
    expect(indexOfAscii(bytes('abc', 3), 'abc')).toBe(3);
    expect(indexOfAscii(bytes('abc', 3), 'abd')).toBe(-1);
  });
});
