// Week 6 · Fun layer (v2 §4): Watch-Party queue, Cast-to-Wall (owner approves), Study Room Pomodoro, Game Night scoreboard.
// Small shared JSON state in RAM, saved to SQLite (kv) at most every 10 s. Everyone in the room sees it live over /ws.
// DRM note (v2 §1.3): Netflix/Prime can't be captured or re-streamed. The queue only holds links; a cast opens them.

import crypto from 'node:crypto';

const id = () => crypto.randomBytes(5).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
const SAVE_MS = 10_000;

/** What kind of thing a link is, so the wall knows how to show it. */
export function classify(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let yt = null;
  if (host === 'youtu.be') yt = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com') yt = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1] || null;
  if (yt && /^[\w-]{6,20}$/.test(yt)) return { kind: 'youtube', url: u.toString(), embed: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&rel=0`, site: 'YouTube' };
  // Reels: Instagram, Facebook, TikTok (YouTube Shorts are handled above as YouTube, with full remote control).
  const ig = host.endsWith('instagram.com') && /^\/(?:[\w.]+\/)?(reels?|p|tv)\/([\w-]{5,40})/.exec(u.pathname);
  if (ig) return { kind: 'reel', url: `https://www.instagram.com/${ig[1] === 'p' ? 'p' : 'reel'}/${ig[2]}/`, embed: `https://www.instagram.com/${ig[1] === 'p' ? 'p' : 'reel'}/${ig[2]}/embed/`, site: 'Instagram' };
  const tt = host.endsWith('tiktok.com') && /\/video\/(\d{8,25})/.exec(u.pathname);
  if (tt) return { kind: 'reel', url: u.toString(), embed: `https://www.tiktok.com/embed/v2/${tt[1]}`, site: 'TikTok' };
  if (host.endsWith('facebook.com') && /^\/(reel|watch|[\w.]+\/videos)\b/.test(u.pathname)) {
    return { kind: 'reel', url: u.toString(), embed: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(u.toString())}&show_text=false&autoplay=true`, site: 'Facebook' };
  }
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(u.pathname)) return { kind: 'image', url: u.toString(), site: host };
  const drm = /(^|\.)(netflix\.com|primevideo\.com|hotstar\.com|jiocinema\.com|sonyliv\.com|zee5\.com|disneyplus\.com)$/.test(host);
  return { kind: drm ? 'drm' : 'link', url: u.toString(), site: host };
}

export function createFun({ kvGet, kvSet, now = () => Date.now(), onChange = () => {}, fetchTitle = null }) {
  const blank = () => ({
    queue: [],                                     // { id, url, title, kind, site, embed?, by, byDev, at, votes: [devKey] }
    casts: [],                                     // pending requests: { id, ...link, by, byDev, at }
    casting: null,                                 // what is on the wall now: { ...link, by, at }
    pomo: { phase: 'idle', running: false, endsAt: null, leftMs: 25 * 60000, focusMin: 25, breakMin: 5, round: 0, by: null },
    game: { title: 'Game Night', players: [] },    // { id, name, score }
  });
  let s = { ...blank(), ...(kvGet('fun') || {}) };
  let dirty = false, timer = null;
  const changed = () => {
    dirty = true;
    if (!timer) timer = setTimeout(() => { timer = null; save(); }, SAVE_MS);
    onChange(view());
  };
  function save() { if (dirty) { dirty = false; kvSet('fun', s); } }

  const view = () => ({ ...s, serverNow: now() });
  const err = (error, code = 400) => ({ error, code });

  // ---------------------------------------------------------------- watch-party queue
  /** No title typed: ask YouTube's public oEmbed for the real one (best effort, 4 s), then update the item in place. */
  function fillTitle(item) {
    if (item.kind !== 'youtube' || item.title !== item.site || !fetchTitle) return;
    fetchTitle(item.url).then((t) => { if (t) { item.title = clean(t, 80); changed(); } }).catch(() => {});
  }
  function addToQueue({ url, title }, who) {
    const c = classify(url);
    if (!c) return err('Paste a full link (https://…)');
    if (s.queue.length >= 50) return err('The queue is full (50)');
    if (s.queue.some((q) => q.url === c.url)) return err('Already in the queue');
    const item = { id: id(), ...c, title: clean(title, 80) || c.site, by: who.name, byDev: who.key, at: now(), votes: [who.key] };
    s.queue.push(item);
    changed();
    fillTitle(item);
    return { ok: true };
  }
  function vote(qid, who) {
    const q = s.queue.find((x) => x.id === qid);
    if (!q) return err('Not in the queue', 404);
    q.votes = q.votes.includes(who.key) ? q.votes.filter((v) => v !== who.key) : [...q.votes, who.key];
    changed();
    return { ok: true };
  }
  function removeFromQueue(qid, who, owner) {
    const q = s.queue.find((x) => x.id === qid);
    if (!q) return err('Not in the queue', 404);
    if (!owner && q.byDev !== who.key) return err('Only who added it, or an owner', 403);
    s.queue = s.queue.filter((x) => x.id !== qid);
    changed();
    return { ok: true };
  }
  /** Queue sorted for display: most votes first, then oldest. */
  const sortedQueue = () => [...s.queue].sort((a, b) => b.votes.length - a.votes.length || a.at - b.at);

  // ---------------------------------------------------------------- cast to wall
  function requestCast({ url, title }, who) {
    const c = classify(url);
    if (!c) return err('Paste a full link (https://…)');
    if (s.casts.length >= 10) return err('Too many cast requests waiting');
    const item = { id: id(), ...c, title: clean(title, 80) || c.site, by: who.name, byDev: who.key, at: now() };
    s.casts.push(item);
    changed();
    fillTitle(item);
    return { ok: true, pending: true };
  }
  function startCast(link, by, byDev = null) {
    s.casting = { ...link, by, byDev, at: now() };
    changed();
    fillTitle(s.casting);
    return { ok: true, casting: s.casting };
  }
  function castNow({ url, title, fromQueue }, who) {
    let link;
    if (fromQueue) {
      const q = s.queue.find((x) => x.id === fromQueue);
      if (!q) return err('Not in the queue', 404);
      s.queue = s.queue.filter((x) => x.id !== fromQueue);
      link = q;
    } else {
      const c = classify(url);
      if (!c) return err('Paste a full link (https://…)');
      link = { ...c, title: clean(title, 80) || c.site };
    }
    return startCast({ kind: link.kind, url: link.url, embed: link.embed, site: link.site, title: link.title }, who.name, who.key);
  }
  function decideCast(cid, approve, who) {
    const c = s.casts.find((x) => x.id === cid);
    if (!c) return err('No such request', 404);
    s.casts = s.casts.filter((x) => x.id !== cid);
    // The person who asked can also play/pause/seek it from their phone.
    if (approve) return startCast({ kind: c.kind, url: c.url, embed: c.embed, site: c.site, title: c.title, requestedBy: c.by }, who.name, c.byDev);
    changed();
    return { ok: true };
  }
  function stopCast() { s.casting = null; changed(); return { ok: true }; }

  // ---------------------------------------------------------------- study room pomodoro (one shared timer)
  const P = () => s.pomo;
  function pomo(action, opts = {}, who) {
    const p = P();
    const t = now();
    if (action === 'start') {
      if (p.running) return { ok: true };
      if (p.phase === 'idle') { p.phase = 'focus'; p.round = 1; p.leftMs = p.focusMin * 60000; }
      p.running = true; p.endsAt = t + p.leftMs; p.by = who.name;
    } else if (action === 'pause') {
      if (!p.running) return { ok: true };
      p.leftMs = Math.max(0, p.endsAt - t); p.running = false; p.endsAt = null;
    } else if (action === 'reset') {
      s.pomo = { ...blank().pomo, focusMin: p.focusMin, breakMin: p.breakMin };
    } else if (action === 'skip') {
      advance();
    } else if (action === 'set') {
      const f = Math.round(Number(opts.focusMin)), b = Math.round(Number(opts.breakMin));
      if (!(f >= 5 && f <= 90 && b >= 1 && b <= 30)) return err('Focus 5–90 min, break 1–30 min');
      p.focusMin = f; p.breakMin = b;
      if (p.phase === 'idle') p.leftMs = f * 60000;
    } else return err('Unknown action');
    changed();
    return { ok: true };
  }
  function advance() {
    const p = P();
    const toBreak = p.phase !== 'break';
    p.phase = toBreak ? 'break' : 'focus';
    if (!toBreak) p.round += 1;
    p.leftMs = (toBreak ? p.breakMin : p.focusMin) * 60000;
    p.endsAt = p.running ? now() + p.leftMs : null;
    p.lastSwitch = now();
  }
  // The server owns phase changes, so every screen and phone flips at the same moment.
  setInterval(() => { const p = P(); if (p.running && p.endsAt && now() >= p.endsAt) { advance(); changed(); } }, 1000).unref();

  // ---------------------------------------------------------------- game night scoreboard
  function game(action, opts = {}) {
    const g = s.game;
    if (action === 'add') {
      const name = clean(opts.name, 24);
      if (!name) return err('Type a name');
      if (g.players.length >= 12) return err('Up to 12 players');
      if (g.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return err('Already playing');
      g.players.push({ id: id(), name, score: 0 });
    } else if (action === 'score') {
      const p = g.players.find((x) => x.id === opts.id);
      if (!p) return err('No such player', 404);
      const d = Math.max(-10, Math.min(10, Math.round(Number(opts.delta) || 0)));
      p.score = Math.max(-999, Math.min(9999, p.score + d));
    } else if (action === 'remove') {
      g.players = g.players.filter((x) => x.id !== opts.id);
    } else if (action === 'title') {
      g.title = clean(opts.title, 40) || 'Game Night';
    } else if (action === 'zero') {
      g.players.forEach((p) => { p.score = 0; });
    } else if (action === 'clear') {
      s.game = blank().game;
    } else return err('Unknown action');
    changed();
    return { ok: true };
  }

  /** Owner casts something that isn't a web link (a dropped picture/video). */
  const castRaw = (link, who) => startCast(link, who.name, who.key);
  /** A collaborator asks to show one of their dropped files. */
  function requestRaw(link, who) {
    if (s.casts.length >= 10) return err('Too many cast requests waiting');
    s.casts.push({ id: id(), ...link, by: who.name, byDev: who.key, at: now() });
    changed();
    return { ok: true, pending: true };
  }
  /** Owners, and whoever's thing is on the wall, may control playback. */
  const canControl = (key, owner) => owner || (!!s.casting && !!key && s.casting.byDev === key);
  return { view, save, castRaw, requestRaw, canControl, sortedQueue, addToQueue, vote, removeFromQueue, requestCast, castNow, decideCast, stopCast, pomo, game };
}

/** YouTube's public oEmbed: title of a video, no API key. Returns null on any problem. */
export async function youtubeTitle(url) {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j.title === 'string' ? j.title : null;
}

/** Short share links (vm.tiktok.com, fb.watch, instagr.am…) point somewhere else: follow up to 3 redirects to find the real reel. */
const SHORT = /^(vm\.tiktok\.com|vt\.tiktok\.com|fb\.watch|instagr\.am|www\.instagr\.am|share\.facebook\.com|www\.facebook\.com\/share)$/;
export async function expandLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return raw; }
  if (!SHORT.test(u.hostname) && !(u.hostname.endsWith('facebook.com') && u.pathname.startsWith('/share/'))) return raw;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'Mozilla/5.0 (Jharokha link preview)' } });
      const loc = r.headers.get('location');
      if (!loc) break;
      u = new URL(loc, u);
      if (!SHORT.test(u.hostname) && !u.pathname.startsWith('/share/')) break;
    } catch { break; }
  }
  return u.toString();
}
