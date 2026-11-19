import { describe, expect, it } from 'vitest';
import { arcPath, fmtUptime, ringSegments } from './ui/ring';
import type { Vitals } from './ui/vitals';
import type { ServerVitals } from './serverLink';

const base: Vitals = { battery: { level: 0.8, charging: true }, pressure: 'nominal', heapMB: 20, online: true, net: { type: '4g', rtt: 50 } };
const sv = (p: Partial<ServerVitals> = {}): ServerVitals => ({
  at: 0, uptimeS: 3700, reqPerS: 1.2, requests: 10, errors: 0, activeClients60s: 2, wsClients: 2, dbBytes: 4096, lastCheckpoint: null,
  disk: { freeGB: 6, totalGB: 10 }, load: [0.5, 0.4, 0.3], cpus: 8, mem: { totalMB: 6000, availMB: 2000 }, rssMB: 60, node: 'v22',
  sqlite: { ok: true, journal_mode: 'wal' }, ...p,
});
const lv = (segs: ReturnType<typeof ringSegments>) => Object.fromEntries(segs.map((s) => [s.key, s.level]));

describe('vitals ring', () => {
  it('all good', () => {
    expect(lv(ringSegments(base, { online: true, v: sv() }, false))).toEqual({ power: 'good', cpu: 'good', net: 'good', server: 'good' });
  });
  it('flags low battery, CPU pressure, offline network', () => {
    const segs = ringSegments({ ...base, battery: { level: 0.15, charging: false }, pressure: 'serious', online: false }, { online: true, v: sv() }, false);
    expect(lv(segs)).toMatchObject({ power: 'bad', cpu: 'bad', net: 'bad' });
    expect(segs.find((s) => s.key === 'cpu')!.reason).toContain('load 0.5 on 8 cores');
  });
  it('server offline / reconnecting / db error / disk low', () => {
    expect(lv(ringSegments(base, { online: false, v: null }, true)).server).toBe('bad');
    expect(lv(ringSegments(base, { online: false, v: sv() }, false)).server).toBe('amber');
    expect(lv(ringSegments(base, { online: true, v: sv({ sqlite: { ok: false, reason: 'locked' } }) }, false)).server).toBe('bad');
    expect(lv(ringSegments(base, { online: true, v: sv({ disk: { freeGB: 1.2, totalGB: 10 } }) }, false)).server).toBe('amber');
  });
  it('falls back to server load when there is no pressure API', () => {
    const segs = ringSegments({ ...base, pressure: 'n/a' }, { online: true, v: sv({ load: [7.9, 5, 4] }) }, false);
    expect(lv(segs).cpu).toBe('bad');
    expect(lv(ringSegments({ ...base, pressure: 'n/a' }, { online: false, v: null }, true)).cpu).toBe('na');
  });
  it('formats uptime and arcs', () => {
    expect(fmtUptime(42)).toBe('42s');
    expect(fmtUptime(3700)).toBe('1h 1m');
    expect(fmtUptime(3 * 86400 + 7200)).toBe('3d 2h');
    expect(arcPath(60, 60, 48, 0, 90)).toBe('M 60.00 12.00 A 48 48 0 0 1 108.00 60.00');
  });
});
