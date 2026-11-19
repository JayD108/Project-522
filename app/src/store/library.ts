// Video library: files copied into OPFS once at import; metadata in IndexedDB.
// readToRam() is the ONLY place that reads a video from disk: one sequential read → RAM Blob.

import { codecVerdict, mimeFor, sniffCodec, type Codec } from '../engine/sniff';
import { kvGet, kvSet } from './db';

export interface Wallpaper {
  id: string; name: string; bytes: number; codec: Codec; mime: string;
  width: number; height: number; duration: number; addedAt: number; warn?: string;
  /** small JPEG data URL (≈ 5 KB) for the Layer 2 wallpaper switcher */
  thumb?: string;
}

const DIR = 'videos';
const KEY = 'library';
export const RAM_BUDGET_MB = 300;

let diskReads = 0;
export const diskReadCount = () => diskReads;

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function listLibrary(): Promise<Wallpaper[]> {
  return (await kvGet<Wallpaper[]>(KEY)) || [];
}

/** Ask ChromeOS not to evict our OPFS/IndexedDB data under storage pressure. */
export async function persistStorage(): Promise<boolean> {
  try { return (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { return false; }
}

async function headTail(f: Blob): Promise<Uint8Array> {
  const N = 4 << 20;
  if (f.size <= 2 * N) return new Uint8Array(await f.arrayBuffer());
  const [a, b] = await Promise.all([f.slice(0, N).arrayBuffer(), f.slice(f.size - N).arrayBuffer()]);
  const out = new Uint8Array(2 * N); out.set(new Uint8Array(a), 0); out.set(new Uint8Array(b), N);
  return out;
}

function probeMeta(blob: Blob): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = () => { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => {
      const m = { width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : 0 };
      done(); res(m);
    };
    v.onerror = () => { done(); rej(new Error('Chrome cannot decode this file')); };
    v.src = url;
  });
}

/** A small poster frame (192 px wide JPEG data URL) from a clip already in RAM. Never reads the disk. */
export function makeThumb(blob: Blob, w = 192): Promise<string | null> {
  return new Promise((res) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (out: string | null) => {
      if (done) return; done = true;
      clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); res(out);
    };
    const timer = setTimeout(() => finish(null), 8000);
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.onloadedmetadata = () => { v.currentTime = Math.min(1.5, (Number.isFinite(v.duration) ? v.duration : 2) * 0.25); };
    v.onseeked = () => {
      try {
        const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d')!.drawImage(v, 0, 0, w, h);
        finish(c.toDataURL('image/jpeg', 0.72));
      } catch { finish(null); }
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}

export async function setThumb(id: string, thumb: string) {
  const list = await listLibrary();
  const wp = list.find((w) => w.id === id);
  if (!wp || wp.thumb === thumb) return false;
  wp.thumb = thumb;
  await kvSet(KEY, list);
  return true;
}

/** Copy a picked file into OPFS (streamed, sequential) after codec checks. */
export async function importFile(file: File | Blob, name: string): Promise<Wallpaper> {
  const codec = sniffCodec(await headTail(file));
  if (codecVerdict(codec) === 'reject') throw new Error(`${name}: ${codec} has no hardware decode on this laptop. Re-encode with tools/encode.sh (H.264).`);
  const meta = await probeMeta(file);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const mime = mimeFor(codec, name);
  const fh = await (await dir()).getFileHandle(id, { create: true });
  const w = await fh.createWritable();
  await file.stream().pipeTo(w);   // pipeTo closes the writable
  const warns: string[] = [];
  if (codecVerdict(codec) === 'warn') warns.push(`${codec}: may decode on CPU`);
  if (file.size > RAM_BUDGET_MB * 2 ** 20) warns.push(`over ${RAM_BUDGET_MB} MB RAM budget`);
  if (meta.height > 1440) warns.push(`${meta.height}p is above any screen here: wasted decode`);
  const thumb = (await makeThumb(file)) || undefined;
  const wp: Wallpaper = { id, name, bytes: file.size, codec, mime, ...meta, addedAt: Date.now(), warn: warns.join('; ') || undefined, thumb };
  await kvSet(KEY, [...(await listLibrary()), wp]);
  return wp;
}

export async function removeWallpaper(id: string) {
  await kvSet(KEY, (await listLibrary()).filter((w) => w.id !== id));
  try { await (await dir()).removeEntry(id); } catch { /* already gone */ }
}

/** One sequential disk read → Blob held in RAM. */
export async function readToRam(wp: Wallpaper): Promise<{ blob: Blob; ms: number }> {
  const t0 = performance.now();
  const f = await (await (await dir()).getFileHandle(wp.id)).getFile();
  const buf = await f.arrayBuffer();
  diskReads++;
  return { blob: new Blob([buf], { type: wp.mime }), ms: Math.round(performance.now() - t0) };
}
