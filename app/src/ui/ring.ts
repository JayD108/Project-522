// Vitals Ring rules (v2 §2): one circle split into Power · CPU · Network · Server.
// Each arc is good / amber / bad / n/a and carries a short reason. Pure: unit-tested.
import type { Vitals } from './vitals';
import type { ServerVitals } from '../serverLink';

export type Level = 'good' | 'amber' | 'bad' | 'na';
export interface Segment { key: 'power' | 'cpu' | 'net' | 'server'; label: string; level: Level; value: string; reason: string }

export function ringSegments(v: Vitals, srv: { online: boolean; v: ServerVitals | null }, offline: boolean): Segment[] {
  return [power(v), cpu(v, srv.v), net(v), server(srv, offline)];
}

function power(v: Vitals): Segment {
  const b = v.battery;
  if (!b) return { key: 'power', label: 'Power', level: 'na', value: 'n/a', reason: 'No battery info from Chrome' };
  const pct = Math.round(b.level * 100);
  const value = `${pct}%${b.charging ? ' ⚡' : ''}`;
  if (!b.charging && pct < 20) return { key: 'power', label: 'Power', level: 'bad', value, reason: `Battery ${pct}% and not charging: plug in` };
  if (!b.charging && pct < 40) return { key: 'power', label: 'Power', level: 'amber', value, reason: `On battery, ${pct}% left` };
  return { key: 'power', label: 'Power', level: 'good', value, reason: b.charging ? 'Charging' : 'On battery' };
}

function cpu(v: Vitals, s: ServerVitals | null): Segment {
  const loadPerCore = s ? s.load[0] / Math.max(1, s.cpus) : null;
  const loadTxt = s ? ` · load ${s.load[0]} on ${s.cpus} cores` : '';
  const p = v.pressure;
  if (p === 'critical' || p === 'serious') return { key: 'cpu', label: 'CPU', level: 'bad', value: p, reason: `CPU ${p}${loadTxt}` };
  if (p === 'fair') return { key: 'cpu', label: 'CPU', level: 'amber', value: p, reason: `CPU busy${loadTxt}` };
  if (p === 'nominal') {
    if (loadPerCore != null && loadPerCore > 0.9) return { key: 'cpu', label: 'CPU', level: 'amber', value: 'nominal', reason: `Linux is busy${loadTxt}` };
    return { key: 'cpu', label: 'CPU', level: 'good', value: 'nominal', reason: `Idle enough${loadTxt}` };
  }
  // No Compute Pressure API: fall back to the server's load average (Linux side only).
  if (loadPerCore == null) return { key: 'cpu', label: 'CPU', level: 'na', value: 'n/a', reason: 'No CPU pressure data' };
  const level: Level = loadPerCore > 0.9 ? 'bad' : loadPerCore > 0.6 ? 'amber' : 'good';
  return { key: 'cpu', label: 'CPU', level, value: `load ${s!.load[0]}`, reason: `Linux load ${s!.load[0]} on ${s!.cpus} cores (no pressure API)` };
}

function net(v: Vitals): Segment {
  if (!v.online) return { key: 'net', label: 'Network', level: 'bad', value: 'offline', reason: 'No network: weather and phones unavailable' };
  const rtt = v.net?.rtt;
  const value = v.net?.type ? `${v.net.type}${rtt != null ? ` · ${rtt} ms` : ''}` : 'online';
  if (rtt != null && rtt >= 400) return { key: 'net', label: 'Network', level: 'amber', value, reason: `Slow network (${rtt} ms)` };
  return { key: 'net', label: 'Network', level: 'good', value, reason: 'Online' };
}

function server(srv: { online: boolean; v: ServerVitals | null }, offline: boolean): Segment {
  const s = srv.v;
  if (offline || (!srv.online && !s)) return { key: 'server', label: 'Server', level: 'bad', value: 'offline', reason: 'Server offline: is Linux running? (systemctl --user status jharokha)' };
  if (!srv.online) return { key: 'server', label: 'Server', level: 'amber', value: 'reconnecting', reason: 'Lost the server link, retrying' };
  if (!s) return { key: 'server', label: 'Server', level: 'amber', value: 'connecting', reason: 'Waiting for vitals' };
  if (!s.sqlite.ok) return { key: 'server', label: 'Server', level: 'bad', value: 'DB error', reason: `SQLite: ${s.sqlite.reason || s.sqlite.journal_mode}` };
  if (s.disk && s.disk.freeGB < 2) return { key: 'server', label: 'Server', level: 'amber', value: `${s.disk.freeGB} GB free`, reason: `Linux disk almost full (${s.disk.freeGB} GB left)` };
  if (s.mem.availMB < 400) return { key: 'server', label: 'Server', level: 'amber', value: `${s.mem.availMB} MB free`, reason: `Linux low on memory (${s.mem.availMB} MB available)` };
  const users = s.activeClients60s;
  return { key: 'server', label: 'Server', level: 'good', value: `up ${fmtUptime(s.uptimeS)}`, reason: `${users} device${users === 1 ? '' : 's'} active · ${s.reqPerS} req/s` };
}

export function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** SVG arc path for a ring segment (angles in degrees, 0 = top, clockwise). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  };
  return `M ${pt(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}`;
}
