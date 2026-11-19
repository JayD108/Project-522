// Phone remote for whatever streaming site is open on the laptop (Netflix, YouTube, Prime…), through the
// "Jharokha Remote" Chrome extension: player controls, a TV-style D-pad, a touchpad pointer and a keyboard.
import { useEffect, useRef, useState } from 'preact/hooks';
import { appCmd, appHelper, appState } from '../room/roomClient';
import { Icon } from './Icon';
import { AppMark } from './Apps';

const fmtT = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const markFor = (site: string) => (/netflix/.test(site) ? 'netflix' : /primevideo/.test(site) ? 'prime' : /youtube/.test(site) ? 'youtube' : /google/.test(site) ? 'google' : '');
const SITE_NAME: Record<string, string> = { netflix: 'Netflix', prime: 'Prime Video', youtube: 'YouTube', google: 'Google' };
const buzz = () => { try { navigator.vibrate?.(8); } catch { /* iPhone: no vibration API */ } };

type Mode = 'remote' | 'pad' | 'keys';

export function AppRemote() {
  const s = appState.value;
  const [mode, setMode] = useState<Mode>(() => { try { return (localStorage.getItem('jhk-armode') as Mode) || 'remote'; } catch { return 'remote'; } });
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { try { localStorage.setItem('jhk-armode', mode); } catch { /* */ } }, [mode]);
  // The page has a text box focused: jump to the keyboard.
  useEffect(() => { if (s?.typing) setMode('keys'); }, [s?.typing]);
  if (!s) return null;
  const k = markFor(s.site);
  const v = s.v;
  const t = v ? v.t + (v.playing ? Math.min(5, (Date.now() - s.at) / 1000) : 0) : 0;
  const title = s.title.replace(/\s*[-|]\s*(YouTube|Netflix)\s*$/i, '');
  return (
    <div class="aremote">
      <div class="mr-top">
        {k ? <AppMark k={k} size={34} /> : <span class="ftype ft-video">WEB</span>}
        <div class="q-main"><b class="mr-title">{title || SITE_NAME[k] || s.site}</b><div class="q-meta">{SITE_NAME[k] || s.site} · on the PC</div></div>
        <button class="icon-btn" aria-label="Full screen on the PC" title="Full screen" onClick={() => appCmd('fullscreen')}><Icon name="fullscreen" size={20} /></button>
        <button class="icon-btn" aria-label="Close the app on the PC" title="Close" onClick={() => appCmd('close')}><Icon name="x" size={20} /></button>
      </div>

      {v && (
        <>
          <div class="mr-time">
            <span>{fmtT(t)}</span>
            <input type="range" min={0} max={Math.max(1, v.d)} value={Math.round(t)} aria-label="Position" disabled={!v.d}
              onChange={(e) => appCmd('seekTo', +(e.target as HTMLInputElement).value)} />
            <span>{v.d ? fmtT(v.d) : '--:--'}</span>
          </div>
          <div class="mr-btns">
            <button class="mr-b" onClick={() => { buzz(); appCmd('seek', -10); }} aria-label="Back 10 seconds">−10</button>
            <button class="mr-b big primary" onClick={() => { buzz(); appCmd('toggle'); }} aria-label={v.playing ? 'Pause' : 'Play'}>
              <Icon name={v.playing ? 'pause' : 'play'} size={28} />
            </button>
            <button class="mr-b" onClick={() => { buzz(); appCmd('seek', 10); }} aria-label="Forward 10 seconds">+10</button>
          </div>
          <div class="mr-vol">
            <button class="icon-btn" onClick={() => appCmd('mute')} aria-label={v.muted ? 'Unmute' : 'Mute'}><Icon name={v.muted || v.vol === 0 ? 'mute' : 'volume'} size={22} /></button>
            <input type="range" min={0} max={100} step={5} value={v.muted ? 0 : v.vol} aria-label="Volume" onInput={(e) => appCmd('volume', +(e.target as HTMLInputElement).value)} />
            <span class="small muted">{v.muted ? 'muted' : `${v.vol}%`}</span>
          </div>
          {s.blocked && <p class="small amber">Chrome is holding the sound until someone touches the laptop once (its autoplay rule). After that, everything works from here.</p>}
        </>
      )}
      {s.skip && <button class="ar-skip" onClick={() => { buzz(); appCmd('skip'); }}><Icon name="skip" size={18} /> {s.skip}</button>}

      <div class="seg ar-modes" role="tablist" aria-label="Remote mode">
        <button role="tab" aria-selected={mode === 'remote'} class={mode === 'remote' ? 'on' : ''} onClick={() => setMode('remote')}><Icon name="dpad" size={16} /> Remote</button>
        <button role="tab" aria-selected={mode === 'pad'} class={mode === 'pad' ? 'on' : ''} onClick={() => setMode('pad')}><Icon name="pointer" size={16} /> Touchpad</button>
        <button role="tab" aria-selected={mode === 'keys'} class={mode === 'keys' ? 'on' : ''} onClick={() => setMode('keys')}><Icon name="keyboard" size={16} /> Type</button>
      </div>
      {mode === 'remote' && <DPad player={s.player} />}
      {mode === 'pad' && <Touchpad />}
      {mode === 'keys' && <Keys site={SITE_NAME[k] || s.site} />}
    </div>
  );
}

function DPad({ player }: { player: boolean }) {
  const go = (cmd: string, arg?: unknown) => () => { buzz(); appCmd(cmd, arg); };
  // Held arrow → repeats (scrolling through a long row).
  const hold = useRef(0);
  const start = (dir: string) => (e: PointerEvent) => {
    e.preventDefault(); buzz(); appCmd('nav', dir);
    clearInterval(hold.current);
    const t0 = Date.now();
    hold.current = window.setInterval(() => { if (Date.now() - t0 > 450) appCmd('nav', dir); }, 160);
  };
  const stop = () => clearInterval(hold.current);
  useEffect(() => stop, []);
  const Arrow = ({ dir, icon, label }: { dir: string; icon: string; label: string }) => (
    <button class={`dp dp-${dir}`} aria-label={label} onPointerDown={start(dir) as any} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') appCmd('nav', dir); }}><Icon name={icon} size={30} /></button>
  );
  return (
    <div class="dpad-wrap">
      <div class="dpad">
        <Arrow dir="up" icon="chevU" label={player ? 'Volume up' : 'Up'} />
        <Arrow dir="left" icon="chevL" label={player ? 'Back 10 seconds' : 'Left'} />
        <button class="dp dp-ok" onClick={go('ok')} aria-label="OK">OK</button>
        <Arrow dir="right" icon="chevR" label={player ? 'Forward 10 seconds' : 'Right'} />
        <Arrow dir="down" icon="chevD" label={player ? 'Volume down' : 'Down'} />
      </div>
      <p class="tiny muted center">{player ? 'Watching: ◀ ▶ skip 10 s · ▲ ▼ volume · OK pauses. Tap "Buttons" to reach the player\'s own buttons.' : 'Arrows move the highlight on the PC · OK opens it.'}</p>
      <div class="ar-row">
        <button onClick={go('back')}><Icon name="back" size={18} /> Back</button>
        <button onClick={go('home')}><Icon name="home" size={18} /> Home</button>
        {player && <button onClick={go('browse')}><Icon name="dpad" size={18} /> Buttons</button>}
      </div>
    </div>
  );
}

function Touchpad() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const pts = new Map<number, { x: number; y: number; t: number }>();
    let mv = { dx: 0, dy: 0 }, sc = { dx: 0, dy: 0 }, timer = 0, downAt = 0, travel = 0, most = 0;
    const flush = () => {
      timer = 0;
      if (mv.dx || mv.dy) { appCmd('move', { dx: Math.round(mv.dx), dy: Math.round(mv.dy) }); mv = { dx: 0, dy: 0 }; }
      if (sc.dx || sc.dy) { appCmd('scroll', { dx: Math.round(sc.dx), dy: Math.round(sc.dy) }); sc = { dx: 0, dy: 0 }; }
    };
    const queue = () => { if (!timer) timer = window.setTimeout(flush, 33); };   // ~30 messages a second at most
    const down = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (pts.size === 1) { downAt = e.timeStamp; travel = 0; most = 1; } else most = Math.max(most, pts.size);
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
      p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
      travel += Math.abs(dx) + Math.abs(dy);
      if (pts.size >= 2) { sc.dx -= (dx * 3) / pts.size; sc.dy -= (dy * 3) / pts.size; }   // two fingers: scroll the page
      else {
        const gain = 2.2 + Math.min(4, (Math.hypot(dx, dy) / dt) * 3);                   // faster swipe → farther
        mv.dx += dx * gain; mv.dy += dy * gain;
      }
      queue();
    };
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size === 0 && travel < 12 && e.timeStamp - downAt < 350) { flush(); buzz(); appCmd(most >= 2 ? 'back' : 'click'); }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => { clearTimeout(timer); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
  }, []);
  return (
    <div class="pad-wrap">
      <div class="tpad" ref={ref} role="application" aria-label="Touchpad: drag to move the pointer on the PC, tap to click">
        <span class="tiny muted">Drag to move · tap to click · two fingers to scroll · two-finger tap = back</span>
      </div>
      <div class="ar-row">
        <button onClick={() => { buzz(); appCmd('click'); }}><Icon name="pointer" size={18} /> Click</button>
        <button onClick={() => appCmd('scroll', { dx: 0, dy: -500 })} aria-label="Scroll up"><Icon name="chevU" size={18} /></button>
        <button onClick={() => appCmd('scroll', { dx: 0, dy: 500 })} aria-label="Scroll down"><Icon name="chevD" size={18} /></button>
        <button onClick={() => appCmd('back')}><Icon name="back" size={18} /> Back</button>
      </div>
    </div>
  );
}

function Keys({ site }: { site: string }) {
  const [text, setText] = useState('');
  const live = useRef(0);
  // What you type shows up in the box on the PC as you type (the whole box is replaced each time).
  const onInput = (val: string) => {
    setText(val);
    clearTimeout(live.current);
    live.current = window.setTimeout(() => appCmd('type', { text: val, enter: false }), 350);
  };
  useEffect(() => () => clearTimeout(live.current), []);
  return (
    <div class="keys-wrap">
      <form class="row" onSubmit={(e) => { e.preventDefault(); clearTimeout(live.current); appCmd('type', { text, enter: true }); }}>
        <input value={text} placeholder="Type here → the PC" aria-label="Text for the PC" enterKeyHint="go" autoComplete="off"
          onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
        <button type="submit" class="primary">Enter</button>
      </form>
      <div class="ar-row">
        <button disabled={!text.trim()} onClick={() => { clearTimeout(live.current); appCmd('search', text); }}><Icon name="globe" size={18} /> Search {site}</button>
        <button onClick={() => appCmd('key', 'backspace')} aria-label="Backspace">⌫</button>
        <button onClick={() => { setText(''); appCmd('type', { text: '', enter: false }); }}>Clear</button>
      </div>
      <p class="tiny muted">"Search" opens the {site} search page with your words. To type into another box on the PC, select it first with the Remote or the Touchpad.</p>
    </div>
  );
}

/** For owners when the helper extension isn't on the laptop yet. */
export function RemoteHelperSetup({ compact = false }: { compact?: boolean }) {
  if (appHelper.value) return compact ? null : <p class="small good"><Icon name="check" size={16} /> Jharokha Remote is on: phones can control Netflix / YouTube on this PC.</p>;
  return (
    <details class="reel-help" open={!compact}>
      <summary>{compact ? 'Control Netflix / YouTube from this phone (one-time setup on the laptop)' : 'Set up the phone remote (one time)'}</summary>
      <ol class="small">
        <li>On the laptop, open Chrome and go to <code>chrome://extensions</code>.</li>
        <li>Turn on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> → <b>Linux files</b> → <b>jharokha</b> → <b>extension</b> → <b>Select</b>.</li>
      </ol>
      <p class="tiny muted">"Jharokha Remote" then connects by itself and stays on. It only works on Netflix, Prime Video, YouTube, Google search and other streaming sites, and only takes commands from approved people in this room.</p>
    </details>
  );
}
