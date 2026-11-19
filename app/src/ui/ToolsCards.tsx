// Week 7 · Tools tab cards (laptop: loaded when the tab opens; phone: part of the room page).
import { useState } from 'preact/hooks';
import {
  alarmDo, alarmSet, eventAdd, eventDelete, expenseAdd, expenseDelete, pollClose, pollCreate, pollDelete, pollVote, serverNowT,
  settleRecord, splitClear, timerCancel, timerStart, tools, upiSet, type Alarm, type Poll, type Timer,
} from '../room/roomClient';
import { me } from '../serverLink';
import { Icon } from './Icon';
import { DAYS, DAY_NAMES, alarmPhase, dayLabel, hhmm, mmss, nextAlarmText, rupees, run, useTick } from './Tools';

// ---------------------------------------------------------------- polls
export function PollsCard({ you, canWrite }: { you?: string | null; canWrite: boolean }) {
  const t = tools.value;
  const owner = !!me.value?.owner;
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const [mins, setMins] = useState(0);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  useTick(15000);
  if (!t) return <p class="muted small">Loading…</p>;
  const submit = (e: Event) => { e.preventDefault(); run(pollCreate(q, opts.filter((o) => o.trim()), mins), setErr, () => { setQ(''); setOpts(['', '']); setOpen(false); }); };
  return (
    <div class="tools-polls">
      {canWrite && (open ? (
        <form class="poll-new" onSubmit={submit}>
          <input value={q} placeholder="Ask the room… (e.g. Dinner tonight?)" aria-label="Question" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          {opts.map((o, i) => (
            <input key={i} value={o} placeholder={`Choice ${i + 1}`} aria-label={`Choice ${i + 1}`} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setOpts((cur) => cur.map((x, k) => (k === i ? v : x))); }} />
          ))}
          <div class="row">
            {opts.length < 6 && <button type="button" onClick={() => setOpts((cur) => [...cur, ''])}><Icon name="plus" size={16} /> Choice</button>}
            <select value={mins} aria-label="Closes" onChange={(e) => setMins(+(e.target as HTMLSelectElement).value)}>
              <option value={0}>Stays open</option><option value={10}>Closes in 10 min</option><option value={60}>Closes in 1 h</option><option value={1440}>Closes in 1 day</option>
            </select>
          </div>
          <div class="row"><button type="submit" class="primary">Ask</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      ) : <button class="primary" onClick={() => setOpen(true)}><Icon name="plus" size={16} /> New poll</button>)}
      {!t.polls.length && <p class="muted small">No polls yet. Ask where to eat, what to watch, who cleans…</p>}
      {t.polls.map((p) => <PollView key={p.id} p={p} you={you} canWrite={canWrite} mine={owner || p.byDev === you} setErr={setErr} />)}
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}
function PollView({ p, you, canWrite, mine, setErr }: { p: Poll; you?: string | null; canWrite: boolean; mine: boolean; setErr: (s: string) => void }) {
  const total = p.options.reduce((a, o) => a + o.votes.length, 0);
  const top = Math.max(...p.options.map((o) => o.votes.length));
  const left = p.closesAt && !p.closed ? p.closesAt - serverNowT() : 0;
  return (
    <div class={`poll ${p.closed ? 'closed' : ''}`}>
      <div class="poll-q"><b>{p.q}</b><span class="tiny muted">{p.by} · {total} vote{total === 1 ? '' : 's'}{p.closed ? ' · closed' : left > 0 ? ` · ${mmss(left)} left` : ''}</span></div>
      {p.options.map((o) => {
        const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
        const mineV = !!you && o.votes.includes(you);
        const win = p.closed && total > 0 && o.votes.length === top;
        return (
          <button key={o.id} class={`poll-opt ${mineV ? 'mine' : ''} ${win ? 'win' : ''}`} disabled={p.closed || !canWrite} aria-pressed={mineV}
            onClick={() => run(pollVote(p.id, o.id), setErr)}>
            <span class="po-bar" style={{ width: `${pct}%` }} />
            <span class="po-text">{win && '🏆 '}{o.text}{mineV && <Icon name="check" size={14} />}</span>
            <span class="po-n">{o.votes.length} · {pct}%</span>
          </button>
        );
      })}
      {mine && canWrite && (
        <div class="row end">
          {!p.closed && <button class="small-btn" onClick={() => run(pollClose(p.id), setErr)}>Close</button>}
          <button class="small-btn" onClick={() => run(pollDelete(p.id), setErr)} aria-label="Delete poll"><Icon name="trash" size={14} /></button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- laundry timers
const PRESETS: [string, number][] = [['Washer', 45], ['Dryer', 60], ['Rinse', 20]];
export function TimersCard({ you, canWrite }: { you?: string | null; canWrite: boolean }) {
  const t = tools.value;
  const owner = !!me.value?.owner;
  const [label, setLabel] = useState('');
  const [mins, setMins] = useState('30');
  const [err, setErr] = useState('');
  useTick(1000);
  if (!t) return null;
  return (
    <div class="tools-timers">
      {t.timers.map((x) => <TimerRow key={x.id} x={x} canCancel={canWrite && (owner || x.byDev === you || x.done)} setErr={setErr} />)}
      {!t.timers.length && <p class="muted small">No timers running. Start one when the machine starts: everyone gets a chime when it's done.</p>}
      {canWrite && (
        <>
          <div class="row presets">
            {PRESETS.map(([l, m]) => <button key={l} onClick={() => run(timerStart(l, m), setErr)}>{l} · {m} min</button>)}
          </div>
          <form class="row" onSubmit={(e) => { e.preventDefault(); run(timerStart(label || 'Timer', +mins), setErr, () => setLabel('')); }}>
            <input value={label} placeholder="Label (Washer 2…)" aria-label="Timer label" onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
            <input class="num" value={mins} inputMode="numeric" aria-label="Minutes" onInput={(e) => setMins((e.target as HTMLInputElement).value)} />
            <span class="small muted">min</span>
            <button type="submit" class="primary">Start</button>
          </form>
        </>
      )}
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}
function TimerRow({ x, canCancel, setErr }: { x: Timer; canCancel: boolean; setErr: (s: string) => void }) {
  const left = x.endsAt - serverNowT();
  const frac = x.done ? 1 : 1 - Math.max(0, left) / (x.minutes * 60000);
  return (
    <div class={`timer-row ${x.done ? 'done' : ''}`}>
      <div class="tr-main">
        <b>{x.label}</b><span class="tiny muted"> · {x.by}</span>
        <span class="bar"><span style={{ width: `${Math.min(100, frac * 100)}%` }} /></span>
      </div>
      <span class="tr-time">{x.done ? 'Done!' : mmss(left)}</span>
      {canCancel && <button class="icon-btn" aria-label={x.done ? `Clear ${x.label}` : `Cancel ${x.label}`} onClick={() => run(timerCancel(x.id), setErr)}><Icon name="x" size={16} /></button>}
    </div>
  );
}

// ---------------------------------------------------------------- Split & Settle
export function SplitCard({ you, canWrite }: { you?: string | null; canWrite: boolean }) {
  const t = tools.value;
  const owner = !!me.value?.owner;
  const [what, setWhat] = useState('');
  const [amt, setAmt] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [split, setSplit] = useState<string[] | null>(null);
  const [vpa, setVpa] = useState<string | null>(null);
  const [err, setErr] = useState('');
  if (!t) return null;
  const meKey = you || 'laptop';
  const people = [...t.people];
  if (!people.some((p) => p.key === meKey)) people.unshift({ key: meKey, name: me.value?.name || 'Laptop' });
  const chosen = split ?? people.map((p) => p.key);
  const net = t.money.net[meKey] || 0;
  const myVpa = vpa ?? t.upi[meKey] ?? '';
  const add = (e: Event) => {
    e.preventDefault();
    run(expenseAdd({ what, amount: amt, paidBy: paidBy || meKey, split: chosen }), setErr, () => { setWhat(''); setAmt(''); });
  };
  return (
    <div class="tools-split">
      <div class="split-sum">
        <div><span class="tiny muted">Room spent</span><b>{rupees(t.money.total)}</b></div>
        <div class={net < 0 ? 'owe' : net > 0 ? 'get' : ''}><span class="tiny muted">You</span><b>{net < 0 ? `owe ${rupees(-net)}` : net > 0 ? `get ${rupees(net)}` : 'all square'}</b></div>
      </div>
      {t.money.transfers.length > 0 && (
        <ul class="settle-list">
          {t.money.transfers.map((x) => (
            <li key={`${x.from}-${x.to}`} class={x.from === meKey || x.to === meKey ? 'me' : ''}>
              <span><b>{x.from === meKey ? 'You' : x.fromName}</b> → <b>{x.to === meKey ? 'you' : x.toName}</b></span>
              <span class="amt">{rupees(x.amount)}</span>
              {x.from === meKey && canWrite && (
                <span class="row">
                  {x.upi ? <a class="button primary" href={x.upi}>Pay with UPI</a> : <span class="tiny muted">{x.toName} hasn't added a UPI ID</span>}
                  <button onClick={() => run(settleRecord(x.to, x.amount), setErr)}>I paid</button>
                </span>
              )}
              {x.to === meKey && canWrite && <button onClick={() => run(settleRecord(meKey, x.amount, x.from), setErr)}>Got it</button>}
              {x.from !== meKey && x.vpa && <span class="tiny muted">UPI: {x.vpa}</span>}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form class="split-add" onSubmit={add}>
          <div class="row">
            <input value={what} placeholder="What (Groceries, Maggi…)" aria-label="What was it" onInput={(e) => setWhat((e.target as HTMLInputElement).value)} />
            <input class="num" value={amt} placeholder="₹" inputMode="decimal" aria-label="Amount in rupees" onInput={(e) => setAmt((e.target as HTMLInputElement).value)} />
          </div>
          <div class="row">
            <span class="small muted">Paid by</span>
            <select value={paidBy || meKey} aria-label="Paid by" onChange={(e) => setPaidBy((e.target as HTMLSelectElement).value)}>
              {people.map((p) => <option key={p.key} value={p.key}>{p.key === meKey ? `You (${p.name})` : p.name}</option>)}
            </select>
          </div>
          <div class="chips" role="group" aria-label="Split between">
            {people.map((p) => {
              const on = chosen.includes(p.key);
              return <button type="button" key={p.key} class={`chip ${on ? 'on' : ''}`} aria-pressed={on}
                onClick={() => setSplit((cur) => { const c = cur ?? people.map((x) => x.key); return on ? c.filter((k) => k !== p.key) : [...c, p.key]; })}>{p.key === meKey ? 'You' : p.name}</button>;
            })}
          </div>
          <button type="submit" class="primary" disabled={!amt || !chosen.length}>Add · split {chosen.length} way{chosen.length === 1 ? '' : 's'}</button>
        </form>
      )}
      {t.expenses.length > 0 && (
        <details class="wp-pick">
          <summary>History ({t.expenses.length})</summary>
          <ul class="exp-list">
            {[...t.expenses].reverse().map((e) => (
              <li key={e.id}>
                <span>{e.kind === 'settle' ? <><b>{e.paidByName}</b> paid <b>{e.splitNames[0]}</b></> : <><b>{e.what}</b> · {e.paidByName} paid · {e.split.length} way{e.split.length === 1 ? '' : 's'}</>}</span>
                <span class="amt">{rupees(e.amount)}</span>
                {canWrite && (owner || e.byDev === meKey) && <button class="icon-btn" aria-label="Remove" onClick={() => run(expenseDelete(e.id), setErr)}><Icon name="trash" size={14} /></button>}
              </li>
            ))}
          </ul>
          {owner && <button class="small-btn" onClick={() => run(splitClear(), setErr)}>Clear history (when all square)</button>}
        </details>
      )}
      {canWrite && (
        <form class="row upi-row" onSubmit={(e) => { e.preventDefault(); run(upiSet(myVpa), setErr, () => setVpa(null)); }}>
          <input value={myVpa} placeholder="Your UPI ID (name@okaxis)" aria-label="Your UPI ID" autoComplete="off" onInput={(e) => setVpa((e.target as HTMLInputElement).value)} />
          <button type="submit">Save</button>
        </form>
      )}
      <p class="tiny muted">Your UPI ID is shown only to people in this room, so they can pay you. "Pay with UPI" opens GPay / PhonePe / Paytm with the amount filled in; nothing is paid until you confirm there.</p>
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}

export function AlarmCard() {
  const t = tools.value;
  const owner = !!me.value?.owner;
  const [draft, setDraft] = useState<Partial<Alarm> | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  useTick(5000);
  if (!t) return null;
  const a = { ...t.alarm, ...(draft || {}) } as Alarm;
  const ph = alarmPhase(t.alarm);
  const set = (p: Partial<Alarm>) => setDraft((d) => ({ ...(d || {}), ...p }));
  return (
    <div class="tools-alarm">
      {ph.active && (
        <div class="alarm-live">
          <b>{ph.ringing ? 'Ringing on the wall now' : `Sunrise on the wall · ${Math.round(ph.frac * 100)}%`}</b>
          <div class="row"><button class="primary" onClick={() => run(alarmDo('dismiss'), setErr)}>I'm up</button><button onClick={() => run(alarmDo('snooze'), setErr)}>Snooze 9 min</button></div>
        </div>
      )}
      <p class="small">Next: <b>{nextAlarmText(t.alarm)}</b>{t.alarm.on ? ` · light starts ${t.alarm.rampMin} min before` : ''}</p>
      {owner ? (
        <>
          <div class="row">
            <label class="switch"><input type="checkbox" checked={a.on} onChange={(e) => set({ on: (e.target as HTMLInputElement).checked })} /> On</label>
            <input type="time" value={a.time} aria-label="Alarm time" onInput={(e) => set({ time: (e.target as HTMLInputElement).value })} />
            <select value={a.rampMin} aria-label="Sunrise length" onChange={(e) => set({ rampMin: +(e.target as HTMLSelectElement).value })}>
              {[5, 10, 15, 20, 30].map((n) => <option key={n} value={n}>{n} min sunrise</option>)}
            </select>
          </div>
          <div class="chips" role="group" aria-label="Days">
            {DAYS.map((d, i) => {
              const on = a.days.includes(i);
              return <button key={i} type="button" class={`chip day ${on ? 'on' : ''}`} aria-pressed={on} aria-label={DAY_NAMES[i]}
                onClick={() => set({ days: on ? a.days.filter((x) => x !== i) : [...a.days, i].sort() })}>{d}</button>;
            })}
          </div>
          <div class="row">
            <label class="switch"><input type="checkbox" checked={a.sound} onChange={(e) => set({ sound: (e.target as HTMLInputElement).checked })} /> Chime at the time</label>
          </div>
          <div class="row">
            <button class="primary" disabled={!draft} onClick={() => run(alarmSet(a), setErr, () => { setDraft(null); setMsg('Saved.'); })}>Save</button>
            <button onClick={() => run(alarmDo('test'), setErr, () => setMsg('Watch the wall: a 20-second sunrise, then the chime.'))}>Test now</button>
          </div>
        </>
      ) : <p class="tiny muted">Only owners change the alarm.</p>}
      <p class="tiny muted">The wall slowly fills with warm light before the time, like a sunrise, then chimes softly. Keep the dashboard running overnight (Night Watch is fine).</p>
      {msg && <p class="small muted">{msg}</p>}
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}


// ---------------------------------------------------------------- room calendar
const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function CalendarCard({ you, canWrite }: { you?: string | null; canWrite: boolean }) {
  const t = tools.value;
  const owner = !!me.value?.owner;
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(() => isoDay(new Date()));
  const [time, setTime] = useState('');
  const [remind, setRemind] = useState(10);
  const [err, setErr] = useState('');
  useTick(30000);
  if (!t) return null;
  const events = t.events || [];
  const submit = (e: Event) => {
    e.preventDefault();
    const [y, m, d] = day.split('-').map(Number);
    if (!y || !m || !d) { setErr('Pick a date'); return; }
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    const at = new Date(y, m - 1, d, time ? hh : 0, time ? mm : 0).getTime();    // this device's local time → epoch ms
    run(eventAdd({ title, at, allDay: !time, remind }), setErr, () => { setTitle(''); setTime(''); });
  };
  let lastDay = '';
  return (
    <div class="tools-cal">
      {!events.length && <p class="muted small">Nothing coming up. Add exams, a birthday, the plumber… the wall shows the next ones and rings a reminder.</p>}
      <ul class="cal-list">
        {events.map((e) => {
          const dl = dayLabel(e.at);
          const head = dl !== lastDay ? (lastDay = dl) : null;
          return (
            <li key={e.id} class={`cal-ev ${e.at < Date.now() && !e.allDay ? 'past' : ''}`}>
              {head && <div class="cal-day">{head}</div>}
              <div class="cal-row">
                <span class="cal-time">{e.allDay ? 'All day' : hhmm(e.at)}</span>
                <b class="cal-title">{e.title}</b>
                <span class="tiny muted">{e.by}{e.remind ? ` · reminder ${e.remind >= 60 ? `${e.remind / 60} h` : `${e.remind} min`} before` : ''}</span>
                {canWrite && (owner || e.byDev === you) && <button class="icon-btn" aria-label={`Remove ${e.title}`} onClick={() => run(eventDelete(e.id), setErr)}><Icon name="x" size={16} /></button>}
              </div>
            </li>
          );
        })}
      </ul>
      {canWrite && (
        <form class="cal-add" onSubmit={submit}>
          <input value={title} placeholder="What's happening? (Maths exam…)" aria-label="Event" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <div class="row">
            <input type="date" value={day} aria-label="Date" onInput={(e) => setDay((e.target as HTMLInputElement).value)} />
            <input type="time" value={time} aria-label="Time (empty = all day)" onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
            <select value={remind} aria-label="Reminder" disabled={!time} onChange={(e) => setRemind(+(e.target as HTMLSelectElement).value)}>
              <option value={0}>No reminder</option><option value={5}>5 min before</option><option value={10}>10 min before</option><option value={30}>30 min before</option>
              <option value={60}>1 h before</option><option value={1440}>1 day before</option>
            </select>
            <button type="submit" class="primary">Add</button>
          </div>
        </form>
      )}
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}
