// Week 2 UI: weather line, 🎬 Cinema strip, 🌙 Night Watch, Schedule (scenes) card, Weather card.
import { useEffect, useState } from 'preact/hooks';
import { activeScene, autoScenes, library, nextChange, place, scenes, weather, weatherError } from '../state';
import { setAutoScenes, setFx, setPlace, setScene } from '../host';
import { describeCode } from '../weather';
import { Clock } from './Clock';

export function WeatherLine({ compact = false }: { compact?: boolean }) {
  const w = weather.value;
  if (!w) return null;
  const d = describeCode(w.code, w.isDay);
  const stale = Date.now() - w.at > 3 * 3600000;
  if (compact) return <span class="wx-compact">{d.icon} {Math.round(w.temp)}°</span>;
  return (
    <div class={`wx ${stale ? 'muted' : ''}`} title={`Updated ${new Date(w.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}>
      <span class="wx-icon">{d.icon}</span> {Math.round(w.temp)}° · {d.text}
      {w.hi != null && w.lo != null && <> · H {Math.round(w.hi)}° L {Math.round(w.lo)}°</>}
      <span class="muted"> · {w.place.split(',')[0]}{stale ? ' (old)' : ''}</span>
    </div>
  );
}

export function CinemaStrip() {
  return (
    <div class="cinema-strip">
      <Clock size="small" />
      <span>🎬 Cinema · wallpaper paused · notifications off</span>
      <button onClick={() => setFx({ cinema: false })}>Exit cinema</button>
    </div>
  );
}

/** 🌙 Night Watch: near-black, a soft red serif clock that drifts a little each minute (no burn-in).
 *  Waking is easy: tap/click anywhere or press any key. Moving the mouse shows the cursor and a hint. */
export function NightWatch() {
  const [now, setNow] = useState(() => new Date());
  const [awake, setAwake] = useState(false);       // pointer moved recently → show cursor + hint
  useEffect(() => {
    let t = 0;
    const tick = () => { setNow(new Date()); t = window.setTimeout(tick, 1000 - (Date.now() % 1000)); };
    t = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    let idle = 0;
    const move = () => { setAwake(true); clearTimeout(idle); idle = window.setTimeout(() => setAwake(false), 3000); };
    addEventListener('pointermove', move);
    return () => { removeEventListener('pointermove', move); clearTimeout(idle); };
  }, []);
  const parts = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).formatToParts(now);
  const hm = parts.filter((p) => p.type === 'hour' || p.type === 'minute').map((p) => p.value);
  const ampm = parts.find((p) => p.type === 'dayPeriod')?.value;
  // Drift up to ±2 % of the screen, a new spot every minute.
  const m = now.getHours() * 60 + now.getMinutes();
  const dx = ((m * 37) % 9) - 4, dy = ((m * 53) % 7) - 3;
  const secFrac = now.getSeconds() / 60;
  return (
    <div class={`night ${awake ? 'awake' : ''}`} role="button" tabIndex={0} aria-label="Night Watch: tap or press any key to wake"
      onClick={() => setFx({ night: false })}>
      <div class="nw" style={{ transform: `translate(calc(-50% + ${dx * 0.5}vw), calc(-50% + ${dy * 0.5}vh))` }}>
        <div class="nw-time">
          <span>{hm[0]}</span><span class="nw-colon">:</span><span>{hm[1]}</span>
          {ampm && <span class="nw-ampm">{ampm}</span>}
        </div>
        <div class="nw-bar" aria-hidden="true"><span style={{ width: `${secFrac * 100}%` }} /></div>
        <div class="nw-date">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
      <div class="nw-hint">Tap anywhere or press any key to wake</div>
    </div>
  );
}

const fmtIn = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export function ScenesCard() {
  const nx = nextChange.value;
  return (
    <section class="card scenes">
      <div class="card-head">
        <h2>Schedule</h2>
        <label class="switch">
          <input type="checkbox" checked={autoScenes.value} onChange={(e) => setAutoScenes((e.target as HTMLInputElement).checked)} />
          Auto by time of day
        </label>
      </div>
      <table class="scene-table">
        <tbody>
          {scenes.value.map((s) => (
            <tr key={s.key} class={s.key === activeScene.value ? 'on' : ''}>
              <th>{s.label}{s.key === activeScene.value && <span class="now"> now</span>}</th>
              <td>
                <input type="time" value={s.start} aria-label={`${s.label} starts at`}
                  onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) setScene(s.key, { start: v }); }} />
              </td>
              <td>
                <select aria-label={`${s.label} wallpaper`} value={s.wallpaperId ?? ''}
                  onChange={(e) => setScene(s.key, { wallpaperId: (e.target as HTMLSelectElement).value || null })}>
                  <option value="">(no change)</option>
                  {library.value.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="small muted">
        {autoScenes.value && nx
          ? <>Next: {nx.label} in {fmtIn(nx.inMs)}{nx.prefetched ? ' · already in RAM' : ''}. Its clip is read 3 min early.</>
          : 'Off: the wallpaper only changes when you pick one.'}
      </p>
    </section>
  );
}

export function WeatherCard() {
  const [q, setQ] = useState(place.value?.name ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    await setPlace(q);
    setBusy(false);
  };
  return (
    <section class="card">
      <h2>Weather</h2>
      <form class="wx-form" onSubmit={submit}>
        <input value={q} placeholder="City, e.g. Pune" aria-label="City for weather"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button type="submit" disabled={busy}>{busy ? '…' : 'Set'}</button>
      </form>
      <WeatherLine />
      {weatherError.value && <p class="small warn">{weatherError.value}</p>}
      <p class="small muted">From Open-Meteo (no account). Only the city name / coordinates are sent. Updates every 30 min.</p>
    </section>
  );
}
