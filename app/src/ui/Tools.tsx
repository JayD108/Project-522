// Week 7 · always-loaded bits: the chime, the "done" banner, the sunrise on the wall, wall timers/poll.
// The Tools tab cards live in ToolsCards.tsx (loaded only when the tab is opened on the laptop).
import { useEffect, useState } from 'preact/hooks';
import { alarmDo, ding, serverNowT, tools, type Alarm } from '../room/roomClient';
import { Icon } from './Icon';

export const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const run = (p: Promise<unknown>, setErr: (s: string) => void, ok?: () => void) => p.then(() => { setErr(''); ok?.(); }).catch((e) => setErr(String(e.message || e)));
export function useTick(ms: number) { const [, t] = useState(0); useEffect(() => { const i = setInterval(() => t((x) => x + 1), ms); return () => clearInterval(i); }, [ms]); }
export const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------- chime (timers done, alarm)
export function chime(notes: [number, number][] = [[784, 0], [988, 0.22], [1175, 0.44]], vol = 0.14) {
  try {
    const ctx = new AudioContext();
    notes.forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, ctx.currentTime + t);
      g.gain.linearRampToValueAtTime(vol, ctx.currentTime + t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 1.1);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 1.2);
    });
    setTimeout(() => ctx.close(), 2200);
  } catch { /* no audio */ }
}
/** Laundry timer finished: chime + a banner (+ a buzz on Android). Mount once per page. */
export function DingBanner({ enabled = true }: { enabled?: boolean }) {
  const d = ding.value;
  const [shown, setShown] = useState<typeof d>(null);
  useEffect(() => {
    if (!d || Date.now() - d.at > 5000) return;
    setShown(d);
    if (enabled) { chime(); try { navigator.vibrate?.([200, 100, 200]); } catch { /* */ } }
    const t = setTimeout(() => setShown(null), 30000);
    return () => clearTimeout(t);
  }, [d?.at]);
  if (!shown) return null;
  return (
    <div class="banner ding" role="alert">
      <Icon name="check" size={18} /><span><b>{shown.label}</b> is done{shown.by ? ` (${shown.by}'s)` : ''}. Time to collect it!</span>
      <button onClick={() => setShown(null)}>OK</button>
    </div>
  );
}

// ---------------------------------------------------------------- sunrise alarm
export const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Where the alarm is right now, in this device's local time. */
export function alarmPhase(a: Alarm | undefined, now = serverNowT()): { active: boolean; frac: number; ringing: boolean; start: number } {
  const off = { active: false, frac: 0, ringing: false, start: 0 };
  if (!a) return off;
  // "Test": a 20-second sunrise, then it rings, for up to a minute.
  if (a.testAt && now - a.testAt < 60000 && a.dismissedAt < a.testAt) {
    const frac = Math.min(1, (now - a.testAt) / 20000);
    return { active: a.snoozeUntil <= now, frac, ringing: frac >= 1, start: a.testAt };
  }
  if (!a.on || !a.days.length) return off;
  const [h, m] = a.time.split(':').map(Number);
  for (const dayOff of [0, 1]) {
    const d = new Date(now); d.setDate(d.getDate() + dayOff); d.setHours(h, m, 0, 0);
    const occ = d.getTime(), start = occ - a.rampMin * 60000;
    if (!a.days.includes(d.getDay())) continue;
    const end = Math.max(occ + 30 * 60000, a.snoozeUntil + 10 * 60000);
    if (now < start || now > end || a.dismissedAt >= start) continue;
    if (a.snoozeUntil > now) return off;
    return { active: true, frac: Math.min(1, (now - start) / (occ - start)), ringing: now >= occ, start };
  }
  return off;
}
export function nextAlarmText(a: Alarm) {
  if (!a.on || !a.days.length) return 'Off';
  const [h, m] = a.time.split(':').map(Number);
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
    if (d.getTime() > now.getTime() && a.days.includes(d.getDay())) return `${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DAY_NAMES[d.getDay()]} ${a.time}`;
  }
  return 'Off';
}
/** The sunrise itself, full screen on the wall window. */
export function Sunrise() {
  const t = tools.value;
  useTick(1000);
  const ph = alarmPhase(t?.alarm);
  const [rang, setRang] = useState(0);
  useEffect(() => {
    if (!ph.ringing || !t?.alarm.sound) return;
    if (Date.now() - rang < 20000) return;                         // a soft chime every 20 s while ringing
    setRang(Date.now());
    chime([[523, 0], [659, 0.3], [784, 0.6], [1047, 0.9]], Math.min(0.22, 0.08 + (ph.frac * 0.1)));
  });
  if (!ph.active) return null;
  const f = ph.frac;
  const now = new Date();
  return (
    <div class="sunrise" style={{ '--f': f } as any} onClick={() => { if (ph.ringing) alarmDo('dismiss').catch(() => {}); }}>
      <div class="sr-sky" />
      <div class="sr-sun" />
      <div class="sr-text">
        <div class="sr-time">{now.getHours()}:{String(now.getMinutes()).padStart(2, '0')}</div>
        {ph.ringing ? <div class="sr-msg">Good morning</div> : <div class="sr-msg dim">Sunrise…</div>}
        {ph.ringing && (
          <div class="row center">
            <button class="primary" onClick={(e) => { e.stopPropagation(); alarmDo('dismiss').catch(() => {}); }}>I'm up</button>
            <button onClick={(e) => { e.stopPropagation(); alarmDo('snooze').catch(() => {}); }}>Snooze 9 min</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Wall display: running timers and the newest open poll, readable from across the room. */
export function WallTools() {
  const t = tools.value;
  useTick(1000);
  if (!t) return null;
  const timers = t.timers;
  const poll = t.polls.find((p) => !p.closed);
  if (!timers.length && !poll) return null;
  const total = poll ? poll.options.reduce((a, o) => a + o.votes.length, 0) : 0;
  return (
    <div class="w-tools">
      {timers.map((x) => (
        <div key={x.id} class={`w-timer ${x.done ? 'done' : ''}`}><Icon name="calendar" size={18} /><b>{x.label}</b><span>{x.done ? 'Done!' : mmss(x.endsAt - serverNowT())}</span></div>
      ))}
      {poll && (
        <div class="w-poll">
          <div class="w-poll-q">{poll.q}</div>
          {poll.options.map((o) => {
            const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
            return <div key={o.id} class="w-po"><span class="po-bar" style={{ width: `${pct}%` }} /><span>{o.text}</span><b>{o.votes.length}</b></div>;
          })}
        </div>
      )}
    </div>
  );
}
