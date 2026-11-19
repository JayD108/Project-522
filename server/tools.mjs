// Week 7 · Room utilities: polls, laundry timers, Split & Settle (UPI deep links), sunrise alarm.
// Same shape as fun.mjs: small JSON state in RAM, saved to SQLite (kv) at most every 10 s, pushed live over /ws.
// Money is kept in paise (integers) so splits always add up exactly.

import crypto from 'node:crypto';

const id = () => crypto.randomBytes(5).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
const SAVE_MS = 10_000;
export const VPA = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,32}$/;      // UPI ID, e.g. asha.k@okaxis
const MAX_PAISE = 1_000_000_00;                                                  // ₹10 lakh per expense

/** Equal split in paise; the first people absorb the leftover paise so the parts add up exactly. */
export function splitEqual(total, n) {
  const base = Math.floor(total / n), extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Who owes whom: fewest transfers by matching the largest debtor with the largest creditor each time. */
export function settleUp(net) {
  const debt = Object.entries(net).filter(([, v]) => v < 0).map(([k, v]) => [k, -v]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const cred = Object.entries(net).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = Math.min(debt[i][1], cred[j][1]);
    if (amt > 0) out.push({ from: debt[i][0], to: cred[j][0], amount: amt });
    debt[i][1] -= amt; cred[j][1] -= amt;
    if (!debt[i][1]) i++;
    if (!cred[j][1]) j++;
  }
  return out;
}

/** upi://pay link that opens GPay / PhonePe / Paytm / BHIM with the amount filled in. */
export function upiLink(vpa, name, paise, note) {
  const q = new URLSearchParams({ pa: vpa, pn: clean(name, 40) || 'Room', am: (paise / 100).toFixed(2), cu: 'INR', tn: clean(note, 40) || 'Jharokha room' });
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

/** Rupees as typed ("120", "99.5", "1,250.75") → paise, or null. */
export function toPaise(v) {
  const s = String(v ?? '').replace(/[,₹\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const p = Math.round(parseFloat(s) * 100);
  return p > 0 && p <= MAX_PAISE ? p : null;
}

export function createTools({ kvGet, kvSet, now = () => Date.now(), onChange = () => {}, onDing = () => {}, people = () => [], minuteMs = 60000 }) {
  const MIN = minuteMs;   // tests shorten a "minute"
  const blank = () => ({
    polls: [],        // { id, q, options: [{ id, text, votes: [key] }], by, byDev, at, closesAt, closed }
    timers: [],       // { id, label, minutes, endsAt, by, byDev, done, doneAt }
    expenses: [],     // { id, kind: 'expense'|'settle', what, amount, paidBy, split: [key], by, byDev, at } (settle: paidBy → split[0])
    upi: {},          // key → { vpa, name }
    alarm: { on: false, time: '07:00', days: [1, 2, 3, 4, 5], rampMin: 15, sound: true, by: null, dismissedAt: 0, snoozeUntil: 0 },
  });
  let s = { ...blank(), ...(kvGet('tools') || {}) };
  s.alarm = { ...blank().alarm, ...s.alarm };
  let dirty = false, timer = null;
  const changed = () => {
    dirty = true;
    if (!timer) timer = setTimeout(() => { timer = null; save(); }, SAVE_MS);
    onChange(view());
  };
  function save() { if (dirty) { dirty = false; kvSet('tools', s); } }
  const err = (error, code = 400) => ({ error, code });
  const mayEdit = (item, who, owner) => owner || item.byDev === who.key;

  // ---------------------------------------------------------------- money view (balances + who pays whom)
  function nameOf(key) {
    const p = people().find((x) => x.key === key);
    return p?.name || s.upi[key]?.name || (key === 'laptop' ? 'Laptop' : 'Someone');
  }
  function money() {
    const net = {};
    const add = (k, v) => { net[k] = (net[k] || 0) + v; };
    for (const e of s.expenses) {
      if (e.kind === 'settle') { add(e.paidBy, e.amount); add(e.split[0], -e.amount); continue; }
      add(e.paidBy, e.amount);
      splitEqual(e.amount, e.split.length).forEach((part, i) => add(e.split[i], -part));
    }
    const transfers = settleUp(net).map((t) => {
      const u = s.upi[t.to];
      return { ...t, fromName: nameOf(t.from), toName: nameOf(t.to), upi: u ? upiLink(u.vpa, u.name || nameOf(t.to), t.amount, 'Room split') : null, vpa: u?.vpa || null };
    });
    const total = s.expenses.filter((e) => e.kind !== 'settle').reduce((a, e) => a + e.amount, 0);
    return { net, transfers, total };
  }

  const view = () => ({
    polls: s.polls, timers: s.timers,
    expenses: s.expenses.slice(-60).map((e) => ({ ...e, paidByName: nameOf(e.paidBy), splitNames: e.split.map(nameOf) })),
    upi: Object.fromEntries(Object.entries(s.upi).map(([k, v]) => [k, v.vpa])),
    money: money(), people: people(), alarm: s.alarm, serverNow: now(),
  });

  // ---------------------------------------------------------------- polls
  function createPoll({ q, options, minutes }, who) {
    const text = clean(q, 120);
    const opts = [...new Set((Array.isArray(options) ? options : []).map((o) => clean(o, 60)).filter(Boolean))];
    if (!text) return err('Write a question');
    if (opts.length < 2 || opts.length > 6) return err('Give 2 to 6 choices');
    if (s.polls.filter((p) => !p.closed).length >= 10) return err('10 polls are open already: close one first');
    const m = Math.round(+minutes || 0);
    const poll = { id: id(), q: text, options: opts.map((t) => ({ id: id(), text: t, votes: [] })), by: who.name, byDev: who.key, at: now(), closesAt: m > 0 ? now() + Math.min(m, 7 * 1440) * MIN : null, closed: false };
    s.polls.unshift(poll);
    s.polls = s.polls.slice(0, 30);
    changed();
    return { ok: true, poll };
  }
  function votePoll(pid, oid, who) {
    const p = s.polls.find((x) => x.id === pid);
    if (!p) return err('No such poll', 404);
    if (p.closed) return err('This poll is closed');
    const o = p.options.find((x) => x.id === oid);
    if (!o) return err('No such choice', 404);
    const had = o.votes.includes(who.key);
    for (const x of p.options) x.votes = x.votes.filter((k) => k !== who.key);   // one vote each; tap again to take it back
    if (!had) o.votes.push(who.key);
    changed();
    return { ok: true };
  }
  function closePoll(pid, who, owner) {
    const p = s.polls.find((x) => x.id === pid);
    if (!p) return err('No such poll', 404);
    if (!mayEdit(p, who, owner)) return err('Only whoever asked (or an owner) can close it', 403);
    p.closed = true; changed();
    return { ok: true };
  }
  function deletePoll(pid, who, owner) {
    const p = s.polls.find((x) => x.id === pid);
    if (!p) return err('No such poll', 404);
    if (!mayEdit(p, who, owner)) return err('Only whoever asked (or an owner) can delete it', 403);
    s.polls = s.polls.filter((x) => x !== p); changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------- laundry (and any other) timers
  function startTimer({ label, minutes }, who) {
    const m = Math.round(+minutes);
    if (!(m >= 1 && m <= 240)) return err('1 to 240 minutes');
    if (s.timers.filter((t) => !t.done).length >= 8) return err('8 timers are running already');
    const t = { id: id(), label: clean(label, 30) || 'Washer', minutes: m, endsAt: now() + m * MIN, by: who.name, byDev: who.key, done: false, doneAt: null };
    s.timers.push(t); changed();
    return { ok: true, timer: t };
  }
  function cancelTimer(tid, who, owner) {
    const t = s.timers.find((x) => x.id === tid);
    if (!t) return err('No such timer', 404);
    if (!t.done && !mayEdit(t, who, owner)) return err('Only whoever started it (or an owner) can cancel it', 403);
    s.timers = s.timers.filter((x) => x !== t); changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------- split & settle
  const known = () => new Set([...people().map((p) => p.key), ...Object.keys(s.upi)]);
  function addExpense({ what, amount, paidBy, split }, who) {
    const paise = toPaise(amount);
    if (!paise) return err('Amount: up to ₹10,00,000, like 240 or 99.50');
    const ok = known(); ok.add(who.key);
    const payer = paidBy || who.key;
    if (!ok.has(payer)) return err('Who paid? Pick someone in the room');
    const parts = [...new Set(Array.isArray(split) && split.length ? split : [...ok])].filter((k) => ok.has(k));
    if (!parts.length) return err('Pick who it is split between');
    if (s.expenses.length >= 500) return err('Too many entries: clear settled ones first');
    s.expenses.push({ id: id(), kind: 'expense', what: clean(what, 60) || 'Something', amount: paise, paidBy: payer, split: parts, by: who.name, byDev: who.key, at: now() });
    changed();
    return { ok: true };
  }
  /** "I paid Asha ₹120": recorded by the payer (or the person who received it, or an owner). */
  function settle({ from, to, amount }, who, owner) {
    const paise = toPaise(amount);
    if (!paise) return err('Amount?');
    const f = from || who.key;
    if (f === to || !to) return err('Pay whom?');
    if (!owner && who.key !== f && who.key !== to) return err('Only the payer or the person paid can record this', 403);
    s.expenses.push({ id: id(), kind: 'settle', what: 'Settled', amount: paise, paidBy: f, split: [to], by: who.name, byDev: who.key, at: now() });
    changed();
    return { ok: true };
  }
  function deleteExpense(eid, who, owner) {
    const e = s.expenses.find((x) => x.id === eid);
    if (!e) return err('Not found', 404);
    if (!mayEdit(e, who, owner)) return err('Only whoever added it (or an owner) can remove it', 403);
    s.expenses = s.expenses.filter((x) => x !== e); changed();
    return { ok: true };
  }
  function clearSettled(owner) {
    if (!owner) return err('Owners only', 403);
    if (Object.values(money().net).some((v) => v !== 0)) return err('Someone still owes money: settle first');
    s.expenses = []; changed();
    return { ok: true };
  }
  function setUpi({ vpa }, who) {
    const v = String(vpa ?? '').trim();
    if (!v) { delete s.upi[who.key]; changed(); return { ok: true }; }
    if (!VPA.test(v)) return err('That doesn\'t look like a UPI ID (like name@okaxis)');
    s.upi[who.key] = { vpa: v, name: who.name };
    changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------- sunrise alarm
  // The wall works out the local time (the server in Linux may run on UTC); the server only keeps the settings and
  // when someone last pressed "I'm up" / "Snooze", so every screen and phone agrees.
  function setAlarm(a, who) {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(a?.time) ? a.time : s.alarm.time;
    const days = Array.isArray(a?.days) ? [...new Set(a.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : s.alarm.days;
    const rampMin = [5, 10, 15, 20, 30].includes(+a?.rampMin) ? +a.rampMin : s.alarm.rampMin;
    s.alarm = { ...s.alarm, on: a?.on !== undefined ? !!a.on : s.alarm.on, time, days, rampMin, sound: a?.sound !== undefined ? !!a.sound : s.alarm.sound, by: who.name, snoozeUntil: 0 };
    changed();
    return { ok: true, alarm: s.alarm };
  }
  function alarmAction(action) {
    if (action === 'dismiss') { s.alarm.dismissedAt = now(); s.alarm.snoozeUntil = 0; }
    else if (action === 'snooze') s.alarm.snoozeUntil = now() + 9 * MIN;
    else if (action === 'test') { s.alarm.testAt = now(); }
    else return err('dismiss, snooze or test');
    changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------- clock: timers ending, polls closing
  function tick() {
    const t = now();
    let any = false;
    for (const x of s.timers) {
      if (!x.done && x.endsAt <= t) { x.done = true; x.doneAt = t; any = true; onDing({ kind: 'timer', label: x.label, by: x.by, byDev: x.byDev }); }
    }
    const before = s.timers.length;
    s.timers = s.timers.filter((x) => !x.done || t - x.doneAt < 30 * MIN);      // finished ones stay 30 min
    for (const p of s.polls) if (!p.closed && p.closesAt && p.closesAt <= t) { p.closed = true; any = true; }
    if (any || before !== s.timers.length) changed();
  }

  return { view, save, tick, createPoll, votePoll, closePoll, deletePoll, startTimer, cancelTimer, addExpense, settle, deleteExpense, clearSettled, setUpi, setAlarm, alarmAction };
}
