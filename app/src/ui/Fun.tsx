// Week 6 UI: Watch-Party queue, Cast-to-Wall, Study Room Pomodoro, Game Night scoreboard (+ the wall versions).
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ago, castDecide, castFromQueue, castLink, castStop, fmtClock, fun, gameDo, pomoDo, pomoLeft, queueAdd, queueRemove, queueVote, sortedQueue,
  media, sendMedia, type Link, type MediaState, type Pomo,
} from '../room/roomClient';
import { me, onServerMessage, qrSrc, wsSend } from '../serverLink';
import { Icon } from './Icon';
import { Modal } from './Modal';

const run = (p: Promise<unknown>, setErr?: (m: string) => void) => p.then(() => setErr?.('')).catch((e) => setErr?.(String(e.message || e)));
const KIND: Record<string, string> = { youtube: 'YouTube', reel: 'Reel', image: 'Picture', video: 'Video', audio: 'Audio', drm: 'Opens on a device', link: 'Link' };

function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

// ---------------------------------------------------------------- watch-party queue
export function WatchQueue({ you, canWrite = true }: { you?: string | null; canWrite?: boolean }) {
  const f = fun.value;
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const owner = !!me.value?.owner;
  const [playing, setPlaying] = useState<Link | null>(null);
  if (!f) return <p class="muted small">Loading…</p>;
  const q = sortedQueue(f.queue);
  const open = (it: Link) => { if (it.kind === 'youtube' && it.embed) setPlaying(it); else window.open(it.url, '_blank', 'noopener'); };
  return (
    <div class="queue">
      {canWrite && (
        <form class="row" onSubmit={(e) => { e.preventDefault(); run(queueAdd(url).then(() => setUrl('')), setErr); }}>
          <input value={url} placeholder="Paste a YouTube / video link" aria-label="Link to add" inputMode="url" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
          <button type="submit" class="primary" disabled={!url.trim()}><Icon name="plus" /> Add</button>
        </form>
      )}
      {err && <p class="small warn">{err}</p>}
      {q.length === 0 ? <p class="muted small empty">Nothing queued. Add what you want to watch together; others vote it up.</p> : (
        <ol class="q-list">
          {q.map((it, i) => {
            const voted = !!you && it.votes.includes(you);
            return (
              <li key={it.id}>
                <span class="q-rank">{i + 1}</span>
                <div class="q-main">
                  <button class="q-title" onClick={() => open(it)} title={it.kind === 'youtube' ? 'Play here' : 'Open in a new tab'}>{it.title}</button>
                  <div class="q-meta">{KIND[it.kind]} · {it.by} · {ago(it.at)}</div>
                </div>
                <button class={`vote ${voted ? 'on' : ''}`} aria-pressed={voted} disabled={!canWrite} onClick={() => run(queueVote(it.id), setErr)} aria-label={`Vote for ${it.title}`}>
                  ▲ {it.votes.length}
                </button>
                {it.kind === 'youtube'
                  ? <button class="small-btn" onClick={() => setPlaying(it)} title="Play it on this screen"><Icon name="play" size={14} /> Play here</button>
                  : <a class="small-btn btn" href={it.url} target="_blank" rel="noopener noreferrer" title="Open in a new tab">Open</a>}
                {owner && it.kind !== 'drm' && <button class="small-btn" onClick={() => run(castFromQueue(it.id), setErr)} title="Show it on the wall now"><Icon name="cinema" size={14} /> Wall</button>}
                {(owner || it.byDev === you) && <button class="icon-btn" aria-label={`Remove ${it.title}`} onClick={() => run(queueRemove(it.id), setErr)}><Icon name="x" size={16} /></button>}
              </li>
            );
          })}
        </ol>
      )}
      <p class="small muted">Netflix / Prime can't be streamed to the wall (DRM). They stay in the queue as links to open on a device.</p>
      {playing && <PlayerModal link={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

/** Play a queued YouTube video right here (laptop or phone), not on the wall. */
export function PlayerModal({ link, onClose }: { link: Link; onClose: () => void }) {
  return (
    <Modal label={link.title} onClose={onClose} wide>
      <div class="viewer">
        <div class="viewer-head"><b>{link.title}</b><a class="small" href={link.url} target="_blank" rel="noopener noreferrer">Open on YouTube</a></div>
        <div class="viewer-body vk-video">
          <iframe src={link.embed} title={link.title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- cast to wall
export function CastBox({ canWrite = true }: { canWrite?: boolean }) {
  const f = fun.value;
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const owner = !!me.value?.owner;
  const send = (e: Event) => {
    e.preventDefault();
    castLink(url).then((r: any) => { setUrl(''); setMsg(r.pending ? 'Asked: an owner will approve it.' : 'On the wall now.'); }).catch((x) => setMsg(x.message));
  };
  return (
    <div class="cast">
      {f?.casting ? (
        <div class="now-casting">
          <Icon name="cinema" />
          <div class="q-main"><b>{f.casting.title}</b><div class="q-meta">on the wall · {f.casting.requestedBy ? `asked by ${f.casting.requestedBy}, ` : ''}by {f.casting.by}</div></div>
          {owner && <button onClick={() => run(castStop(), setMsg)}>Stop</button>}
        </div>
      ) : <p class="muted small">Nothing on the wall.</p>}
      {canWrite && (
        <form class="row" onSubmit={send}>
          <input value={url} placeholder={owner ? 'Link to show on the wall' : 'Link to ask for the wall'} aria-label="Link to cast" inputMode="url" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
          <button type="submit" disabled={!url.trim()}>{owner ? 'Cast' : 'Ask'}</button>
        </form>
      )}
      {msg && <p class="small muted">{msg}</p>}
      {owner && !!f?.casts.length && (
        <ul class="cast-reqs">
          {f.casts.map((c) => (
            <li key={c.id}>
              <div class="q-main"><b>{c.by}</b> wants <a href={c.url} target="_blank" rel="noopener noreferrer">{c.title}</a><div class="q-meta">{KIND[c.kind]} · {ago(c.at)}</div></div>
              <button class="primary" onClick={() => run(castDecide(c.id, true), setMsg)}>Show</button>
              <button onClick={() => run(castDecide(c.id, false), setMsg)} aria-label="Deny">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The wall screen showing a cast (YouTube embed / picture / link card). Rendered only on the wall window. */
/** Something that can be played/paused/seeked: a <video>/<audio>, or the YouTube player (iframe API over postMessage). */
interface Ctl { play(): void; pause(): void; seek(d: number): void; seekTo(t: number): void; volume(v: number): void; mute(m: boolean): void; state(): Omit<MediaState, 'at' | 'kind'> | null }
const YT_ORIGIN = 'https://www.youtube-nocookie.com';

export function CastOverlay({ link, onStop }: { link: Link & { by: string; requestedBy?: string }; onStop?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [peek, setPeek] = useState(true);            // show the title/stop bar for the first seconds
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const yt = useRef({ playing: false, t: 0, d: 0, vol: 100, muted: false });
  useEffect(() => { setLoaded(false); setPeek(true); const t = setTimeout(() => setPeek(false), 5000); return () => clearTimeout(t); }, [link.url]);

  // ---- one controller for whatever is on screen
  useEffect(() => {
    const ytCmd = (func: string, args: unknown[] = []) =>
      frameRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YT_ORIGIN);
    const el = () => mediaRef.current;
    const ctl: Ctl = link.kind === 'youtube' ? {
      play: () => ytCmd('playVideo'), pause: () => ytCmd('pauseVideo'),
      seek: (d) => ytCmd('seekTo', [Math.max(0, yt.current.t + d), true]), seekTo: (t) => ytCmd('seekTo', [t, true]),
      volume: (v) => { ytCmd('setVolume', [v]); if (v > 0) ytCmd('unMute'); }, mute: (m) => ytCmd(m ? 'mute' : 'unMute'),
      state: () => ({ ...yt.current }),
    } : {
      play: () => { el()?.play().catch(() => {}); }, pause: () => el()?.pause(),
      seek: (d) => { const m = el(); if (m) m.currentTime = Math.max(0, Math.min(m.duration || 0, m.currentTime + d)); },
      seekTo: (t) => { const m = el(); if (m) m.currentTime = t; },
      volume: (v) => { const m = el(); if (m) { m.volume = v / 100; m.muted = v === 0; } }, mute: (mu) => { const m = el(); if (m) m.muted = mu; },
      state: () => { const m = el(); return m ? { playing: !m.paused, t: m.currentTime, d: Number.isFinite(m.duration) ? m.duration : 0, vol: Math.round(m.volume * 100), muted: m.muted } : null; },
    };
    onServerMessage('media', (msg: { cmd: string; arg: number | null }) => {
      const st = ctl.state();
      switch (msg.cmd) {
        case 'toggle': st?.playing ? ctl.pause() : ctl.play(); break;
        case 'play': ctl.play(); break;
        case 'pause': ctl.pause(); break;
        case 'seek': ctl.seek(msg.arg ?? 10); break;
        case 'seekTo': if (msg.arg != null) ctl.seekTo(msg.arg); break;
        case 'volume': if (msg.arg != null) ctl.volume(Math.max(0, Math.min(100, msg.arg))); break;
        case 'mute': ctl.mute(true); break;
        case 'unmute': ctl.mute(false); break;
      }
      setPeek(true); setTimeout(() => setPeek(false), 2500);
      setTimeout(report, 250);
    });
    // YouTube tells us its state once we say we're listening.
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || e.source !== frameRef.current?.contentWindow) return;
      let d: any; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      const info = d?.info;
      if (d?.event === 'infoDelivery' && info) {
        if (typeof info.playerState === 'number') yt.current.playing = info.playerState === 1 || info.playerState === 3;
        if (typeof info.currentTime === 'number') yt.current.t = info.currentTime;
        if (typeof info.duration === 'number') yt.current.d = info.duration;
        if (typeof info.volume === 'number') yt.current.vol = info.volume;
        if (typeof info.muted === 'boolean') yt.current.muted = info.muted;
      }
    };
    addEventListener('message', onMsg);
    const report = () => { const st = ctl.state(); if (st && link.kind !== 'image' && link.kind !== 'link' && link.kind !== 'drm') wsSend({ t: 'media-state', s: { ...st, kind: link.kind } }); };
    const iv = setInterval(() => {
      if (link.kind === 'youtube') frameRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'jhk', channel: 'widget' }), YT_ORIGIN);
      report();
    }, 1000);
    return () => { clearInterval(iv); removeEventListener('message', onMsg); onServerMessage('media', () => {}); };
  }, [link.url]);

  const src = new URL(link.url, location.href).toString();
  const embed = link.embed ? `${link.embed}&enablejsapi=1&origin=${encodeURIComponent(location.origin)}` : '';
  return (
    <div class={`cast-overlay ${peek ? 'peek' : ''}`} role="dialog" aria-label={`On the wall: ${link.title}`}>
      {(link.kind === 'youtube' || link.kind === 'reel' || link.kind === 'image' || link.kind === 'video') && !loaded && (
        <div class="cast-loading"><Icon name="cinema" size={40} /><div class="cast-card-title">{link.title}</div><div class="muted">Loading {link.site}…</div></div>
      )}
      {link.kind === 'youtube' && embed && (
        <iframe ref={frameRef} class={`cast-frame ${loaded ? 'in' : ''}`} src={embed} title={link.title} onLoad={() => setLoaded(true)}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      )}
      {link.kind === 'reel' && link.embed && (
        <div class="cast-reel">
          <iframe class={`reel-frame ${loaded ? 'in' : ''}`} src={link.embed} title={link.title} onLoad={() => setLoaded(true)}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
          <div class="reel-side"><div class="cast-card-title">{link.site} reel</div><div class="muted">from {link.requestedBy || link.by}</div>
            <div class="small muted">{link.site} doesn't allow remote control: click the reel on this screen to play or unmute.</div></div>
        </div>
      )}
      {link.kind === 'image' && <img class="cast-img" src={src} alt={link.title} referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} />}
      {link.kind === 'video' && <video ref={(v) => { mediaRef.current = v; }} class="cast-img" src={src} autoPlay controls playsInline onLoadedData={() => setLoaded(true)} />}
      {link.kind === 'audio' && (
        <div class="cast-audio">
          <div class="eq" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <div class="cast-card-title">{link.title}</div>
          <div class="muted">from {link.by}'s phone</div>
          <audio ref={(a) => { mediaRef.current = a; }} src={src} autoPlay controls />
        </div>
      )}
      {(link.kind === 'link' || link.kind === 'drm') && (
        <div class="cast-card">
          <img class="qr" src={qrSrc(link.url)} alt="" width={220} height={220} />
          <div>
            <div class="cast-card-title">{link.title}</div>
            <div class="muted">{link.kind === 'drm' ? `${link.site} can't be shown here (DRM). Scan to open it on a phone or the laptop.` : `Scan to open ${link.site}, or open it here:`}</div>
            {link.kind === 'link' && <a class="btn primary" href={link.url} target="_blank" rel="noopener noreferrer">Open on this screen</a>}
          </div>
        </div>
      )}
      <div class="cast-bar">
        <span>{link.title} · by {link.by}</span>
        {onStop && <button onClick={onStop}><Icon name="x" size={16} /> Stop</button>}
      </div>
    </div>
  );
}

const fmtT = (t: number) => { const s = Math.max(0, Math.floor(t)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`; };

/** Phone / laptop remote for what's on the wall: play-pause, ±10 s, scrub, volume, mute, stop. */
export function MediaRemote({ you }: { you?: string | null }) {
  const c = fun.value?.casting;
  const m = media.value;
  const owner = !!me.value?.owner;
  const [err, setErr] = useState('');
  useTick(1000);
  if (!c) return null;
  const mine = owner || (!!you && c.byDev === you);
  const playable = c.kind === 'youtube' || c.kind === 'video' || c.kind === 'audio';
  const fresh = m && Date.now() - m.at < 5000;
  const t = fresh ? m!.t + (m!.playing ? (Date.now() - m!.at) / 1000 : 0) : 0;
  return (
    <div class="mremote">
      <div class="mr-top">
        <span class={`ftype ft-${c.kind === 'youtube' || c.kind === 'reel' ? 'video' : c.kind}`}>{c.kind === 'youtube' ? 'YT' : c.kind === 'reel' ? 'REEL' : c.kind.slice(0, 3).toUpperCase()}</span>
        <div class="q-main"><b class="mr-title">{c.title}</b><div class="q-meta">on the wall · by {c.requestedBy || c.by}</div></div>
      </div>
      {playable && mine && (
        <>
          <div class="mr-time">
            <span>{fmtT(t)}</span>
            <input type="range" min={0} max={Math.max(1, Math.round(m?.d || 0))} value={Math.round(t)} aria-label="Position"
              disabled={!fresh || !m?.d} onChange={(e) => sendMedia('seekTo', +(e.target as HTMLInputElement).value)} />
            <span>{m?.d ? fmtT(m.d) : '--:--'}</span>
          </div>
          <div class="mr-btns">
            <button class="mr-b" onClick={() => sendMedia('seek', -10)} aria-label="Back 10 seconds">−10</button>
            <button class="mr-b big primary" onClick={() => sendMedia('toggle')} aria-label={m?.playing ? 'Pause' : 'Play'}>
              <Icon name={m?.playing ? 'pause' : 'play'} size={28} />
            </button>
            <button class="mr-b" onClick={() => sendMedia('seek', 10)} aria-label="Forward 10 seconds">+10</button>
          </div>
          <div class="mr-vol">
            <button class="icon-btn" onClick={() => sendMedia(m?.muted ? 'unmute' : 'mute')} aria-label={m?.muted ? 'Unmute' : 'Mute'}>
              <Icon name={m?.muted || m?.vol === 0 ? 'mute' : 'volume'} size={22} />
            </button>
            <input type="range" min={0} max={100} step={5} value={m?.muted ? 0 : m?.vol ?? 100} aria-label="Volume"
              onInput={(e) => sendMedia('volume', +(e.target as HTMLInputElement).value)} />
            <span class="small muted">{m?.muted ? 'muted' : `${m?.vol ?? 100}%`}</span>
          </div>
          {!fresh && <p class="small muted">Waiting for the wall to report…</p>}
        </>
      )}
      {c.kind === 'reel' && <p class="small muted">{c.site} reels can't be paused from a phone (their rule): click the reel on the PC to play or unmute. YouTube Shorts links work fully from here.</p>}
      {mine && <button class="mr-stop" onClick={() => run(castStop(), setErr)}><Icon name="x" size={16} /> Stop casting</button>}
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- pomodoro
function Ring({ frac, size, stroke, cls }: { frac: number; size: number; stroke: number; cls: string }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return (
    <svg class={`pomo-ring ${cls}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} class="track" stroke-width={stroke} fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} class="fill" stroke-width={stroke} fill="none" stroke-linecap="round"
        stroke-dasharray={c} stroke-dashoffset={c * (1 - frac)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}
const phaseLabel = (p: Pomo) => (p.phase === 'focus' ? 'Focus' : p.phase === 'break' ? 'Break' : 'Ready');

export function PomoCard({ canWrite = true }: { canWrite?: boolean }) {
  useTick(500);
  const f = fun.value;
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(false);
  const [fm, setFm] = useState(25), [bm, setBm] = useState(5);
  if (!f) return null;
  const p = f.pomo;
  const left = pomoLeft(p);
  const total = (p.phase === 'break' ? p.breakMin : p.focusMin) * 60000;
  return (
    <div class={`pomo ph-${p.phase}`}>
      <div class="pomo-dial">
        <Ring frac={p.phase === 'idle' ? 1 : left / total} size={150} stroke={9} cls={p.phase} />
        <div class="pomo-in">
          <div class="pomo-time">{fmtClock(left)}</div>
          <div class="pomo-ph">{phaseLabel(p)}{p.round ? ` · round ${p.round}` : ''}</div>
        </div>
      </div>
      <div class="pomo-side">
        {canWrite ? (
          <div class="row">
            {p.running
              ? <button class="primary" onClick={() => run(pomoDo('pause'), setErr)}>Pause</button>
              : <button class="primary" onClick={() => run(pomoDo('start'), setErr)}><Icon name="play" size={14} /> {p.phase === 'idle' ? 'Start focus' : 'Resume'}</button>}
            {p.phase !== 'idle' && <button onClick={() => run(pomoDo('skip'), setErr)}>Skip</button>}
            {p.phase !== 'idle' && <button onClick={() => run(pomoDo('reset'), setErr)}>Reset</button>}
          </div>
        ) : <p class="small muted">Read-only right now.</p>}
        <p class="small muted">One shared timer for everyone studying here: {p.focusMin} min focus · {p.breakMin} min break.{p.by ? ` Started by ${p.by}.` : ''}</p>
        {canWrite && !edit && <button class="link-btn" onClick={() => { setFm(p.focusMin); setBm(p.breakMin); setEdit(true); }}>Change lengths</button>}
        {edit && (
          <form class="row" onSubmit={(e) => { e.preventDefault(); run(pomoDo('set', { focusMin: fm, breakMin: bm }).then(() => setEdit(false)), setErr); }}>
            <label class="small">Focus <input type="number" min={5} max={90} value={fm} onInput={(e) => setFm(+(e.target as HTMLInputElement).value)} /></label>
            <label class="small">Break <input type="number" min={1} max={30} value={bm} onInput={(e) => setBm(+(e.target as HTMLInputElement).value)} /></label>
            <button type="submit">Save</button>
          </form>
        )}
        {err && <p class="small warn">{err}</p>}
      </div>
    </div>
  );
}

/** Wall version: big ring + time; shown only while a session exists. */
export function PomoWall() {
  useTick(500);
  const p = fun.value?.pomo;
  if (!p || p.phase === 'idle') return null;
  const left = pomoLeft(p);
  const total = (p.phase === 'break' ? p.breakMin : p.focusMin) * 60000;
  return (
    <div class={`pomo-wall ph-${p.phase}`}>
      <div class="pomo-dial">
        <Ring frac={left / total} size={220} stroke={12} cls={p.phase} />
        <div class="pomo-in"><div class="pomo-time">{fmtClock(left)}</div><div class="pomo-ph">{phaseLabel(p)}{p.running ? '' : ' · paused'}</div></div>
      </div>
      <div class="pomo-wall-txt">{p.phase === 'focus' ? 'Study room: quiet please' : 'Break time'}<div class="muted">Round {p.round}</div></div>
    </div>
  );
}

/** Soft two-note chime when the shared timer flips (wall window only, never in quiet hours). */
export function usePomoChime(enabled: boolean) {
  const last = fun.value?.pomo.lastSwitch;
  const [seen, setSeen] = useState<number | undefined>(last);
  useEffect(() => {
    if (!last || last === seen) return;
    setSeen(last);
    if (!enabled || Date.now() - last > 5000) return;
    try {
      const ctx = new AudioContext();
      [[660, 0], [880, 0.25]].forEach(([f, t]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0, ctx.currentTime + t);
        g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.9);
        o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 1);
      });
      setTimeout(() => ctx.close(), 1500);
    } catch { /* no audio */ }
  }, [last]);
}

// ---------------------------------------------------------------- game night
export function Scoreboard({ canWrite = true }: { canWrite?: boolean }) {
  const f = fun.value;
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const owner = !!me.value?.owner;
  if (!f) return null;
  const g = f.game;
  const ranked = [...g.players].sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score;
  return (
    <div class="score">
      {canWrite && (
        <form class="row" onSubmit={(e) => { e.preventDefault(); run(gameDo('add', { name }).then(() => setName('')), setErr); }}>
          <input value={name} maxLength={24} placeholder="Add a player" aria-label="Player name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button type="submit" disabled={!name.trim()}><Icon name="plus" /> Player</button>
        </form>
      )}
      {err && <p class="small warn">{err}</p>}
      {ranked.length === 0 ? <p class="muted small empty">No players yet. Add everyone playing tonight.</p> : (
        <ul class="players">
          {ranked.map((p) => (
            <li key={p.id} class={p.score === top && ranked.length > 1 && top !== 0 ? 'lead' : ''}>
              <span class="pl-name">{p.name}</span>
              {canWrite && <button class="pm" onClick={() => run(gameDo('score', { id: p.id, delta: -1 }), setErr)} aria-label={`${p.name} minus one`}>−</button>}
              <span class="pl-score">{p.score}</span>
              {canWrite && <button class="pm plus" onClick={() => run(gameDo('score', { id: p.id, delta: 1 }), setErr)} aria-label={`${p.name} plus one`}>+</button>}
              {canWrite && <button class="icon-btn" onClick={() => run(gameDo('remove', { id: p.id }), setErr)} aria-label={`Remove ${p.name}`}><Icon name="x" size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
      {canWrite && ranked.length > 0 && (
        <div class="row">
          <button class="link-btn" onClick={() => run(gameDo('zero'), setErr)}>New round (scores to 0)</button>
          {owner && <button class="link-btn" onClick={() => run(gameDo('clear'), setErr)}>Clear game</button>}
        </div>
      )}
    </div>
  );
}

export function ScoreWall() {
  const g = fun.value?.game;
  if (!g || !g.players.length) return null;
  const ranked = [...g.players].sort((a, b) => b.score - a.score);
  return (
    <div class="score-wall">
      <h2 class="w-h"><Icon name="people" size={20} /> {g.title}</h2>
      <ol>
        {ranked.slice(0, 6).map((p, i) => (
          <li key={p.id} class={i === 0 && p.score > 0 ? 'lead' : ''}><span class="sw-rank">{i + 1}</span><span class="sw-name">{p.name}</span><span class="sw-score">{p.score}</span></li>
        ))}
      </ol>
    </div>
  );
}

export function UpNext() {
  const q = fun.value?.queue;
  if (!q?.length) return null;
  const top = sortedQueue(q)[0];
  return <div class="up-next"><Icon name="play" size={14} /> Up next: <b>{top.title}</b> <span class="muted">▲ {top.votes.length}</span></div>;
}
