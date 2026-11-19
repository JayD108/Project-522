// Week 5 room client, shared by the dashboard and the phone page.
// Board = Yjs doc synced over the server socket (conflict-free: two phones typing at once both win).
// Door sign, drops and the owner remote come as plain messages.
import { signal } from '@preact/signals';
import type * as YT from 'yjs';
import { onServerMessage, onServerOpen, wsSend } from '../serverLink';

export interface Note { id: string; text: string; color: string; by: string; at: number; done: boolean }
export interface Door { status: string; note: string; by: string | null; at: number | null }
export interface Drop { id: string; name: string; bytes: number; mime: string; byDev: string; byName: string; at: number; expiresAt: number }
export interface ScreenState {
  mode: string; layer: string; cinema: boolean; night: boolean; showcase?: boolean; currentId: string | null;
  wallpapers: { id: string; name: string }[]; scene: string | null; at: number;
}

export const NOTE_COLORS = ['amber', 'green', 'blue', 'rose', 'plain'] as const;
export const DOOR_OPTIONS = ['Come in', 'Knock first', 'Busy', 'Studying', 'Sleeping', 'Away'];

export const notes = signal<Note[]>([]);
export const boardReady = signal(false);
export const boardWritable = signal(true);
export const door = signal<Door | null>(null);
export const drops = signal<Drop[]>([]);
export const screen = signal<ScreenState | null>(null);
export const remoteAck = signal<{ cmd: string; delivered: number; direct?: boolean; at: number } | null>(null);

let Y: typeof YT | null = null;
let doc: YT.Doc | null = null;
let arr: YT.Array<YT.Map<unknown>> | null = null;
let unsentOffline = false;
let started = false;

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);   // no crypto.randomUUID on plain-HTTP LAN pages

function publish() {
  if (!arr) return;
  notes.value = arr.toArray().map((m) => ({
    id: String(m.get('id')), text: String(m.get('text') ?? ''), color: String(m.get('color') ?? 'plain'),
    by: String(m.get('by') ?? ''), at: Number(m.get('at') ?? 0), done: !!m.get('done'),
  })).reverse();                                  // newest first
}

/** Load Yjs (its own chunk, so the always-on dashboard page stays small) and hook into the server socket. */
export async function startRoom() {
  if (started) return;
  started = true;
  onServerMessage('door', (m) => { door.value = m.door; });
  onServerMessage('drops', (m) => { drops.value = m.drops; });
  onServerMessage('screen', (m) => { screen.value = m.s; });
  onServerMessage('remote-ack', (m) => { remoteAck.value = { cmd: m.cmd, delivered: m.delivered, direct: !!m.direct, at: Date.now() }; });
  onServerMessage('room-readonly', () => { boardWritable.value = false; });
  Y = await import('yjs');
  doc = new Y.Doc();
  arr = doc.getArray('notes');
  arr.observeDeep(publish);
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'server') return;
    if (!wsSend({ t: 'room-update', u: b64(u) })) unsentOffline = true;
  });
  onServerMessage('room-update', (m) => {
    if (!doc || !Y) return;
    Y.applyUpdate(doc, unb64(m.u), 'server');
    if (m.initial) { boardReady.value = true; if (typeof m.canWrite === 'boolean') boardWritable.value = m.canWrite; publish(); }
  });
  onServerOpen(() => {
    if (!doc || !Y) return;
    wsSend({ t: 'room-sync', sv: b64(Y.encodeStateVector(doc)) });
    // Edits made while offline: send everything we have; Yjs drops what the server already knows.
    if (unsentOffline) { unsentOffline = false; wsSend({ t: 'room-update', u: b64(Y.encodeStateAsUpdate(doc)) }); }
  });
}

const findIdx = (id: string) => (arr ? arr.toArray().findIndex((m) => m.get('id') === id) : -1);

export function addNote(text: string, color: string, by: string) {
  const t = text.trim().slice(0, 280);
  if (!t || !arr || !Y || !doc) return;
  const m = new Y.Map<unknown>();
  doc.transact(() => {
    m.set('id', rid()); m.set('text', t); m.set('color', color); m.set('by', by.slice(0, 32)); m.set('at', Date.now()); m.set('done', false);
    arr!.push([m]);
    // Keep the board readable on the wall: at most 60 notes, oldest done ones go first.
    while (arr!.length > 60) {
      const all = arr!.toArray();
      const i = all.findIndex((x) => x.get('done'));
      arr!.delete(i >= 0 ? i : 0, 1);
    }
  });
}
export function toggleDone(id: string) {
  const i = findIdx(id);
  if (i >= 0 && arr) { const m = arr.get(i); m.set('done', !m.get('done')); }
}
export function editNote(id: string, text: string) {
  const i = findIdx(id);
  if (i >= 0 && arr && text.trim()) arr.get(i).set('text', text.trim().slice(0, 280));
}
export function removeNote(id: string) {
  const i = findIdx(id);
  if (i >= 0 && arr) arr.delete(i, 1);
}
export function clearDone() {
  if (!arr || !doc) return;
  doc.transact(() => { for (let i = arr!.length - 1; i >= 0; i--) if (arr!.get(i).get('done')) arr!.delete(i, 1); });
}

// ---------------------------------------------------------------- plain APIs
const api = (p: string) => new URL(`../${p}`, location.href);
async function req(path: string, init?: RequestInit) {
  const r = await fetch(api(path), init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const setDoor = (status: string, note = '') =>
  req('api/door', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, note }) });
export const deleteDrop = (id: string) => req(`api/drops/${id}`, { method: 'DELETE' });
export const dropUrl = (id: string, inline = false) => api(`api/drops/${id}${inline ? '?inline=1' : ''}`).toString();
export const roomInfo = () => req('api/room');

/** Upload with progress (XHR: fetch has no upload progress). */
export function uploadDrop(file: File, onProgress: (f: number) => void): Promise<{ ok: boolean; name: string }> {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', api(`api/drops?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || '')}`).toString());
    x.setRequestHeader('content-type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let j: any = {}; try { j = JSON.parse(x.responseText); } catch { /* */ }
      if (x.status >= 200 && x.status < 300) res(j); else rej(new Error(j.error || `HTTP ${x.status}`));
    };
    x.onerror = () => rej(new Error('Upload failed: connection lost'));
    x.send(file);
  });
}

export function sendRemote(cmd: string, arg?: unknown) { return wsSend({ t: 'remote', cmd, arg }); }

export const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 2 ** 20 ? `${Math.round(b / 1024)} KB` : `${(b / 2 ** 20).toFixed(1)} MB`);
export const ago = (t: number | null) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

// ---------------------------------------------------------------- Week 6 · fun layer
export interface Link { kind: 'youtube' | 'reel' | 'image' | 'video' | 'audio' | 'drm' | 'link'; url: string; embed?: string; site: string; title: string }
export interface QueueItem extends Link { id: string; by: string; byDev: string; at: number; votes: string[] }
export interface CastReq extends Link { id: string; by: string; byDev: string; at: number }
export interface Pomo { phase: 'idle' | 'focus' | 'break'; running: boolean; endsAt: number | null; leftMs: number; focusMin: number; breakMin: number; round: number; by: string | null; lastSwitch?: number }
export interface FunState {
  queue: QueueItem[]; casts: CastReq[]; casting: (Link & { by: string; byDev?: string | null; at: number; requestedBy?: string }) | null;
  pomo: Pomo; game: { title: string; players: { id: string; name: string; score: number }[] }; serverNow: number;
}
export const fun = signal<FunState | null>(null);
/** server clock − local clock, so every screen shows the same countdown. */
export let clockSkew = 0;
onServerMessage('fun', (m) => { clockSkew = m.fun.serverNow - Date.now(); fun.value = m.fun; });

const postJ = (path: string, body: unknown = {}) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const queueAdd = (url: string, title = '') => postJ('api/fun/queue', { url, title });
export const queueVote = (id: string) => postJ(`api/fun/queue/${id}/vote`);
export const queueRemove = (id: string) => req(`api/fun/queue/${id}`, { method: 'DELETE' });
export const castLink = (url: string, title = '') => postJ('api/fun/cast', { url, title });
export const castFromQueue = (id: string) => postJ(`api/fun/cast/queue/${id}`);
export const castDecide = (id: string, approve: boolean) => postJ(`api/fun/cast/${id}/${approve ? 'approve' : 'deny'}`);
export const castStop = () => postJ('api/fun/cast/stop');
export const castDrop = (id: string) => postJ(`api/fun/cast/drop/${id}`);
export const pomoDo = (action: 'start' | 'pause' | 'reset' | 'skip' | 'set', opts: object = {}) => postJ(`api/fun/pomo/${action}`, opts);
export const gameDo = (action: string, opts: object = {}) => postJ(`api/fun/game/${action}`, opts);

/** ms left on the shared timer right now. */
export function pomoLeft(p: Pomo, at = Date.now()) {
  return p.running && p.endsAt ? Math.max(0, p.endsAt - (at + clockSkew)) : p.leftMs;
}
export const fmtClock = (ms: number) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** Queue sorted like the server: most votes, then oldest. */
export const sortedQueue = (q: QueueItem[]) => [...q].sort((a, b) => b.votes.length - a.votes.length || a.at - b.at);

// ---------------------------------------------------------------- media remote (phone ↔ wall)
export interface MediaState { playing: boolean; t: number; d: number; vol: number; muted: boolean; kind: string; at: number }
export const media = signal<MediaState | null>(null);
onServerMessage('media-state', (m) => { media.value = m.s; });
export const sendMedia = (cmd: 'toggle' | 'play' | 'pause' | 'seek' | 'seekTo' | 'volume' | 'mute' | 'unmute', arg?: number) => wsSend({ t: 'media', cmd, arg });
export const openOnPc = (url: string, title: string) => wsSend({ t: 'open-request', url, title });
/** Pick a file on this phone → upload → put it on the wall (owners) or ask (others). */
export async function castFile(file: File, onProgress: (f: number) => void) {
  const up: any = await uploadDrop(file, onProgress);
  return postJ(`api/fun/cast/drop/${up.id}`);
}

/** Laptop (W-A): a phone asked to open a link here. Shown as a one-tap banner (browsers only open tabs on a tap). */
export const openRequest = signal<{ url: string; title: string; by: string; at: number } | null>(null);
onServerMessage('open-request', (m) => { openRequest.value = { url: m.url, title: m.title, by: m.by, at: Date.now() }; });
/** Laptop: the server already opened an app in Chrome for a phone; just say so. */
export const opened = signal<{ title: string; by: string; at: number } | null>(null);
onServerMessage('opened', (m) => { opened.value = { title: m.title, by: m.by, at: Date.now() }; });

// ---------------------------------------------------------------- phone remote for Netflix / YouTube tabs on the laptop
// The "Jharokha Remote" Chrome extension on the laptop drives the streaming tab; the server relays.
export interface AppState {
  site: string; title: string; player: boolean; skip: string | null; typing: boolean; blocked: boolean; tv: boolean; at: number;
  v: { playing: boolean; t: number; d: number; vol: number; muted: boolean } | null;
}
export const appState = signal<AppState | null>(null);
export const appHelper = signal(false);
onServerMessage('app-state', (m) => { appState.value = m.s; });
onServerMessage('app-helper', (m) => { appHelper.value = !!m.on; });
export const appCmd = (cmd: string, arg?: unknown) => wsSend({ t: 'app', cmd, arg });

// ---------------------------------------------------------------- Week 7 · utilities (polls, timers, split, alarm)
export interface Poll { id: string; q: string; options: { id: string; text: string; votes: string[] }[]; by: string; byDev: string; at: number; closesAt: number | null; closed: boolean }
export interface Timer { id: string; label: string; minutes: number; endsAt: number; by: string; byDev: string; done: boolean; doneAt: number | null }
export interface Expense { id: string; kind: 'expense' | 'settle'; what: string; amount: number; paidBy: string; paidByName: string; split: string[]; splitNames: string[]; by: string; byDev: string; at: number }
export interface Transfer { from: string; to: string; amount: number; fromName: string; toName: string; upi: string | null; vpa: string | null }
export interface Alarm { on: boolean; time: string; days: number[]; rampMin: number; sound: boolean; by: string | null; dismissedAt: number; snoozeUntil: number; testAt?: number }
export interface ToolsState {
  polls: Poll[]; timers: Timer[]; expenses: Expense[]; upi: Record<string, string>;
  money: { net: Record<string, number>; transfers: Transfer[]; total: number };
  people: { key: string; name: string }[]; alarm: Alarm; serverNow: number;
}
export const tools = signal<ToolsState | null>(null);
export let toolsSkew = 0;
onServerMessage('tools', (m) => { toolsSkew = m.tools.serverNow - Date.now(); tools.value = m.tools; });
/** A laundry timer just finished (every screen and phone chimes). */
export const ding = signal<{ kind: string; label: string; by: string; byDev: string; at: number } | null>(null);
onServerMessage('tools-ding', (m) => { ding.value = { ...m, at: Date.now() }; });
export const serverNowT = () => Date.now() + toolsSkew;

export const pollCreate = (q: string, options: string[], minutes = 0) => postJ('api/tools/poll', { q, options, minutes });
export const pollVote = (id: string, option: string) => postJ(`api/tools/poll/${id}/vote`, { option });
export const pollClose = (id: string) => postJ(`api/tools/poll/${id}/close`);
export const pollDelete = (id: string) => req(`api/tools/poll/${id}`, { method: 'DELETE' });
export const timerStart = (label: string, minutes: number) => postJ('api/tools/timer', { label, minutes });
export const timerCancel = (id: string) => req(`api/tools/timer/${id}`, { method: 'DELETE' });
export const expenseAdd = (e: { what: string; amount: string; paidBy?: string; split?: string[] }) => postJ('api/tools/expense', e);
export const expenseDelete = (id: string) => req(`api/tools/expense/${id}`, { method: 'DELETE' });
export const settleRecord = (to: string, amount: number, from?: string) => postJ('api/tools/settle', { to, from, amount: (amount / 100).toFixed(2) });
export const splitClear = () => postJ('api/tools/clear');
export const upiSet = (vpa: string) => postJ('api/tools/upi', { vpa });
export const alarmSet = (a: Partial<Alarm>) => postJ('api/tools/alarm', a);
export const alarmDo = (action: 'dismiss' | 'snooze' | 'test') => postJ(`api/tools/alarm/${action}`);
