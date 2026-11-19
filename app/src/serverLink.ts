// Live link to the Jharokha server (Week 3): /ws pushes vitals every 2 s.
// Each window keeps its own socket. If it drops, reconnect with backoff; Layer 2 shows "Server offline".
import { signal } from '@preact/signals';

export interface ServerVitals {
  at: number; uptimeS: number; reqPerS: number; requests: number; errors: number;
  activeClients60s: number; wsClients: number; dbBytes: number; lastCheckpoint: number | null;
  disk: { freeGB: number; totalGB: number } | null; load: number[]; cpus: number;
  mem: { totalMB: number; availMB: number }; rssMB: number; node: string;
  sqlite: { ok: boolean; journal_mode?: string; reason?: string };
  thermal?: string; thermalGuard?: boolean; lastSnapshot?: { name: string; bytes: number; at: number } | null; logLines?: number;
}
export interface JoinInfo {
  url: string; host: string; source: 'manual' | 'seen' | 'crostini' | 'lan' | 'tunnel';
  reach?: { lastOutside: { ip: string; host: string; at: number; ua: string; via?: string } | null };
  tunnel?: TunnelStatus;
}
export interface TunnelStatus { status: 'off' | 'starting' | 'on' | 'unavailable'; url: string | null; error: string | null; available: boolean; wanted: boolean }
export interface Device {
  id: string; name: string; role: 'owner' | 'collaborator' | 'viewer' | null; status: 'pending' | 'approved';
  createdAt: number; decidedAt: number | null; expiresAt: number; lastSeen: number | null; ip: string; ua: string;
}
export interface AccessState {
  devices: Device[]; pending: number; kill: boolean; max: number;
  quiet: { enabled: boolean; start: string; end: string; now: boolean };
  audit: { at: number; actor: string; action: string; target: string | null; detail: string | null }[];
  net?: NetGuard;
}
export interface NetGuard {
  mode: 'wifi' | 'anywhere'; trusted: string[]; room: string[]; laptop: { v4: string | null; v6: string | null; at: number | null };
  blocked: { ip: string; prefix: string | null; at: number; ua: string; path: string }[]; codeRotatesInS: number | null;
}
export interface Me { status: string; owner: boolean; id?: string; name?: string; role?: string | null }

export const server = signal<{ online: boolean; since: number; v: ServerVitals | null; join: JoinInfo | null; rtt: number | null }>(
  { online: false, since: Date.now(), v: null, join: null, rtt: null },
);
/** True once we've failed to reach the server for a while (not during the first connect). */
export const serverOffline = signal(false);
/** Week 4: who this screen is to the server (owner after `npm run pair`), and the owners' access tray. */
export const me = signal<Me | null>(null);
export const accessState = signal<AccessState | null>(null);
/** The build the server has now vs. the build this page runs (hashed main script name). Differ → an update is waiting. */
export const serverBuild = signal<string | null>(null);
export const myBuild = (() => { const s = document.querySelector('script[type="module"][src*="assets/"]')?.getAttribute('src') || ''; return (/(main-[\w-]+\.js)/.exec(s) || [])[1] || null; })();
export const updateReady = () => !!serverBuild.value && !!myBuild && serverBuild.value !== myBuild;
/** Load the new version: let the service worker fetch it first, then reload. */
export async function applyUpdate() {
  try { const r = await navigator.serviceWorker?.getRegistration(); await r?.update(); } catch { /* no SW */ }
  setTimeout(() => location.reload(), 600);
}

/** Extra message handlers (room board, remote, …) and "socket is open" hooks, so features stay out of this file. */
type Handler = (m: any) => void;
const handlers = new Map<string, Handler>();
const openHooks = new Set<() => void>();
export const onServerMessage = (t: string, h: Handler) => { handlers.set(t, h); };
export const onServerOpen = (h: () => void) => { openHooks.add(h); if (ws?.readyState === 1) h(); };
/** Send on the live socket; returns false if it isn't open. */
export function wsSend(m: unknown): boolean {
  if (ws?.readyState !== 1) return false;
  ws.send(JSON.stringify(m));
  return true;
}
let myRole = 'room';
/** Tell the server which window this is ('A' dashboard brain, 'B' monitor, 'room' phone page). */
export function setRole(r: string) { myRole = r; wsSend({ t: 'iam', role: r }); }

const OFFLINE_AFTER_MS = 4000;
let ws: WebSocket | null = null;
let backoff = 500;
let offlineTimer = 0;
let started = false;

const api = (p: string) => new URL(`../${p}`, location.href);

function markDown() {
  if (server.value.online) server.value = { ...server.value, online: false, since: Date.now() };
  if (!offlineTimer) offlineTimer = window.setTimeout(() => { serverOffline.value = true; }, OFFLINE_AFTER_MS);
}

function connect() {
  const u = api('ws');
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { ws = new WebSocket(u); } catch { markDown(); retry(); return; }
  ws.onopen = () => {
    backoff = 500;
    clearTimeout(offlineTimer); offlineTimer = 0;
    serverOffline.value = false;
    server.value = { ...server.value, online: true, since: Date.now() };
    ws?.send(JSON.stringify({ t: 'ping', ts: performance.now() }));   // latency right away, not after 10 s
    ws?.send(JSON.stringify({ t: 'iam', role: myRole }));
    openHooks.forEach((h) => { try { h(); } catch (e) { console.error(e); } });
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.t === 'hello') { me.value = m.me; serverBuild.value = m.build ?? null; }
      else if (m.t === 'denied') { me.value = m.me || { status: 'none', owner: false }; accessState.value = null; }
      else if (m.t === 'access') accessState.value = m.a;
      else if (m.t === 'vitals') server.value = { ...server.value, online: true, v: m.v, join: m.join };
      else if (m.t === 'pong') server.value = { ...server.value, rtt: Math.round(performance.now() - m.ts) };
      else handlers.get(m.t)?.(m);
    } catch { /* ignore */ }
  };
  ws.onclose = (e) => {
    ws = null;
    if (e.code === 4401 || e.code === 4403) {
      // Reachable, just not allowed (screen not paired / owner-only): not "offline". Check again in 10 s.
      clearTimeout(offlineTimer); offlineTimer = 0; serverOffline.value = false;
      server.value = { ...server.value, online: false, v: null };
      window.setTimeout(connect, 10000);
      return;
    }
    markDown(); retry();
  };
  ws.onerror = () => { try { ws?.close(); } catch { /* closing */ } };
}

function retry() {
  window.setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 15000);
}

/** `npm run pair` opens /app/?pair=<code>: trade it for an owner cookie (once), then drop it from the URL. */
async function pairFromUrl() {
  const u = new URL(location.href);
  const code = u.searchParams.get('pair');
  if (!code) return;
  u.searchParams.delete('pair');
  history.replaceState(null, '', u);
  try {
    const cur = await (await fetch(api('api/me'), { cache: 'no-store' })).json();
    if (cur.owner) return;                       // already paired: the code just expires unused
    const r = await fetch(api('api/pair'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Laptop' }) });
    if (!r.ok) console.warn('pairing failed', (await r.json().catch(() => ({}))).error);
  } catch { /* server down: the "Pair" card explains */ }
}

export async function startServerLink() {
  if (started) return;
  started = true;
  await pairFromUrl();
  connect();
  // Latency probe every 10 s (cheap) and a watchdog: no vitals for 8 s = treat as down.
  setInterval(() => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
    const v = server.value.v;
    if (server.value.online && v && Date.now() - v.at > 8000 && ws) { try { ws.close(); } catch { /* */ } }
  }, 10000);
  addEventListener('online', () => { if (!ws) { backoff = 500; connect(); } });
}

/** Set the laptop's Wi-Fi IP by hand (only allowed from http://localhost). Empty string clears it. */
export async function setLanHost(host: string): Promise<JoinInfo> {
  const r = await fetch(api('api/lan-host'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  server.value = { ...server.value, join: j };
  return j;
}

export const qrSrc = (url: string) => `${api('api/qr.svg')}?u=${encodeURIComponent(url)}`;

async function post(path: string, body: unknown = {}) {
  const r = await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const decide = (id: string, action: 'approve' | 'deny' | 'revoke' | 'role', role?: string) => post(`api/devices/${id}/${action}`, { role });
export const stepDown = (role: 'collaborator' | 'viewer') => post('api/me/role', { role });
export const leaveRoom = () => post('api/leave', {});
export const setKill = (on: boolean) => post('api/kill', { on });
export const setTunnel = (on: boolean) => post('api/tunnel', { on });
export const setNetGuard = (b: { mode?: 'wifi' | 'anywhere'; trust?: string; untrust?: string }) => post('api/netguard', b);
// Week 8 · System
export interface Snapshot { name: string; bytes: number; at: number }
export interface LogLine { n: number; at: number; level: 'info' | 'warn' | 'error'; text: string }
export async function getJ<T = any>(path: string): Promise<T> {
  const r = await fetch(api(path), { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const getBackups = () => getJ<{ list: Snapshot[]; last: any; nextInMs: number; keep: number; at: string }>('api/system/backups');
export const takeBackup = () => post('api/system/backups', {});
export const getLogs = (level?: string, n = 150) => getJ<{ lines: LogLine[]; files: { name: string; bytes: number }[]; ring: number }>(`api/system/logs?n=${n}${level ? `&level=${level}` : ''}`);
export const setQuiet = (q: { enabled?: boolean; start?: string; end?: string }) => post('api/quiet', q);
