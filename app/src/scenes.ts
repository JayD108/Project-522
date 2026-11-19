// Scene scheduler (v1 §3 / v2 Showcase): Dawn / Deep Work / Ambient / Night by time of day.
// Pure functions only: the coordinator (host.ts) ticks them and does the reading/prefetching.

export type SceneKey = 'dawn' | 'work' | 'ambient' | 'night';
export interface Scene { key: SceneKey; label: string; start: string /* HH:MM, local */; wallpaperId: string | null }

export const DEFAULT_SCENES: Scene[] = [
  { key: 'dawn', label: 'Dawn', start: '05:30', wallpaperId: null },
  { key: 'work', label: 'Deep Work', start: '09:00', wallpaperId: null },
  { key: 'ambient', label: 'Ambient', start: '17:00', wallpaperId: null },
  { key: 'night', label: 'Night', start: '22:00', wallpaperId: null },
];

/** "HH:MM" → minutes after midnight. Bad input → NaN. */
export function toMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return NaN;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? h * 60 + mi : NaN;
}

const sorted = (scenes: Scene[]) =>
  scenes.filter((s) => Number.isFinite(toMin(s.start))).sort((a, b) => toMin(a.start) - toMin(b.start));

/** The scene in force at `d`: the latest one that started today, else the last one from yesterday (wraps midnight). */
export function sceneAt(d: Date, scenes: Scene[]): Scene | null {
  const list = sorted(scenes);
  if (!list.length) return null;
  const now = d.getHours() * 60 + d.getMinutes();
  let cur = list[list.length - 1];
  for (const s of list) if (toMin(s.start) <= now) cur = s;
  return cur;
}

/** The next scene change after `d`, and how many ms until it. */
export function nextScene(d: Date, scenes: Scene[]): { scene: Scene; inMs: number } | null {
  const list = sorted(scenes);
  if (!list.length) return null;
  const nowMs = ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
  for (const s of list) {
    const at = toMin(s.start) * 60000;
    if (at > nowMs) return { scene: s, inMs: at - nowMs };
  }
  return { scene: list[0], inMs: 24 * 3600000 - nowMs + toMin(list[0].start) * 60000 };
}
