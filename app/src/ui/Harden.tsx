// Week 8 · System tab card (its own chunk: loaded when the System tab opens).
import { useEffect, useState } from 'preact/hooks';
import { autoStack, mode, stacked, thermalGuard, thermalHold } from '../state';
import { currentPressure, setAutoStack, setStacked, setThermalGuard, unstack } from '../host';
import { getBackups, getLogs, me, server, takeBackup, type LogLine, type Snapshot } from '../serverLink';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------- System tab: Week 8 card
const kb = (b: number) => (b < 2 ** 20 ? `${Math.round(b / 1024)} KB` : `${(b / 2 ** 20).toFixed(1)} MB`);
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

export function HardenCard() {
  const owner = !!me.value?.owner;
  const v = server.value.v;
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [dir, setDir] = useState('data/backups/');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => getBackups().then((b) => { setSnaps(b.list); setNext(b.nextInMs); if ((b as any).dir) setDir((b as any).dir.replace(/^\/home\/[^/]+/, '~')); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { if (owner) load(); }, [owner]);
  const now = async () => { setBusy(true); try { await takeBackup(); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const p = currentPressure();
  return (
    <div class="harden">
      <div class="h-row">
        <label class="switch"><input type="checkbox" checked={autoStack.value} onChange={(e) => setAutoStack((e.target as HTMLInputElement).checked)} /> Stack both layers on one screen when swaps get slow</label>
        {mode.value === 'dual' && (stacked.value
          ? <button class="small-btn" onClick={unstack}>Back to swapping</button>
          : <button class="small-btn" onClick={() => setStacked(true, 'switched on by hand')}><Icon name="layers" size={14} /> Stack now</button>)}
      </div>
      <div class="h-row">
        <label class="switch"><input type="checkbox" checked={thermalGuard.value} onChange={(e) => setThermalGuard((e.target as HTMLInputElement).checked)} /> Thermal guard: pause the wallpaper when the laptop works hard</label>
        <span class={`small ${p === 'serious' || p === 'critical' ? 'warn' : p === 'fair' ? 'amber' : 'muted'}`}>CPU pressure: {p}{thermalHold.value ? ' · paused' : ''}</span>
      </div>
      <div class="h-sec">
        <div class="h-head"><b><Icon name="backup" size={15} /> Nightly snapshot</b>
          {owner && <button class="small-btn" onClick={now} disabled={busy}>{busy ? 'Saving…' : 'Snapshot now'}</button>}</div>
        {!owner ? <p class="small muted">Pair this screen to see backups.</p> : (
          <>
            <p class="small muted">A consistent copy of the room database every night at 03:30{next != null ? ` (next in ${Math.round(next / 3600000)} h)` : ''}. The newest 7 are kept in <code>{dir}</code>.</p>
            {snaps && !snaps.length && <p class="small amber">No snapshot yet.</p>}
            {snaps && snaps.length > 0 && (
              <ul class="snap-list">{snaps.slice(0, 4).map((s) => <li key={s.name}><span>{s.name}</span><span class="muted">{kb(s.bytes)} · {ago(s.at)}</span></li>)}</ul>
            )}
          </>
        )}
        {!owner && v?.lastSnapshot && <p class="small muted">Last: {ago(v.lastSnapshot.at)}</p>}
      </div>
      {owner && <LogView />}
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}

function LogView() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [level, setLevel] = useState<'' | 'warn'>('');
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<{ name: string; bytes: number }[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const get = () => getLogs(level || undefined, 120).then((r) => { if (live) { setLines(r.lines); setFiles(r.files); } }).catch(() => {});
    get();
    const t = setInterval(get, 4000);
    return () => { live = false; clearInterval(t); };
  }, [open, level]);
  return (
    <div class="h-sec">
      <div class="h-head"><b><Icon name="list" size={15} /> Server log</b>
        <span class="row">
          {open && <select value={level} aria-label="Which lines" onChange={(e) => setLevel((e.target as HTMLSelectElement).value as any)}><option value="">Everything</option><option value="warn">Warnings + errors</option></select>}
          <button class="small-btn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
        </span>
      </div>
      {open && (
        <>
          <pre class="log-view" aria-label="Server log">{lines.length ? lines.map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.level === 'info' ? ' ' : l.level === 'warn' ? '!' : '✕'} ${l.text}`).join('\n') : 'Nothing logged yet.'}</pre>
          <p class="tiny muted">Last 1000 lines are kept in memory; on disk <code>data/logs/jharokha.log</code> rotates at 1 MB, 3 old files kept ({files.map((f) => `${f.name} ${kb(f.bytes)}`).join(', ') || 'none yet'}).</p>
        </>
      )}
    </div>
  );
}
