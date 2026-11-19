// Phone room page (/app/room.html), redesigned: Home · Share · Board · Fun · People.
// Home = what's on the wall (+ remote), cast from this phone, door sign, apps, screen controls (owners).
import { useEffect, useRef, useState } from 'preact/hooks';
import { accessState, applyUpdate, leaveRoom, me, server, serverOffline, startServerLink, stepDown, decide, updateReady } from '../serverLink';
import { appState, tools, castFile, castLink, fun, pomoLeft, fmtClock, roomInfo, screen, sendRemote, startRoom } from './roomClient';
import { Icon } from '../ui/Icon';
import { BoardEditor, DoorBadge, DoorPicker, DropZone } from '../ui/Room';
import { CastBox, MediaRemote, PomoCard, Scoreboard, WatchQueue } from '../ui/Fun';
import { AppTiles } from '../ui/Apps';
import { AppRemote, RemoteHelperSetup } from '../ui/AppRemote';
import { DingBanner, alarmPhase } from '../ui/Tools';
import { AlarmCard, PollsCard, SplitCard, TimersCard } from '../ui/ToolsCards';

type Tab = 'home' | 'share' | 'board' | 'fun' | 'tools' | 'people';
const TABS: { k: Tab; label: string; icon: string }[] = [
  { k: 'home', label: 'Home', icon: 'home' },
  { k: 'share', label: 'Share', icon: 'cast' },
  { k: 'board', label: 'Board', icon: 'note' },
  { k: 'fun', label: 'Fun', icon: 'cinema' },
  { k: 'tools', label: 'Tools', icon: 'tools' },
  { k: 'people', label: 'People', icon: 'people' },
];

export function RoomApp() {
  const [tab, setTab] = useState<Tab>(() => { try { return (sessionStorage.getItem('jhk-rtab') as Tab) || 'home'; } catch { return 'home'; } });
  const [info, setInfo] = useState<{ canWrite: boolean; owner: boolean; you: string } | null>(null);
  const [blocked, setBlocked] = useState('');
  const go = (t: Tab) => { setTab(t); try { sessionStorage.setItem('jhk-rtab', t); } catch { /* */ } scrollTo({ top: 0 }); };
  const load = () => roomInfo().then(setInfo).catch((e) => {
    if (/not approved|owner-only|ask to join/.test(e.message)) location.href = '/join';
    else if (/not-on-room-wifi/.test(e.message)) setBlocked('wifi');
    else setBlocked(e.message);
  });
  // Shared to Jharokha from another app (Android share sheet → installed app): ?url= / ?text= carries the link.
  const [shared] = useState(() => {
    const q = new URLSearchParams(location.search);
    const hit = [q.get('url'), q.get('text'), q.get('title')].join(' ').match(/https:\/\/\S+/);
    if (hit) history.replaceState(null, '', location.pathname);
    return hit ? hit[0] : '';
  });
  useEffect(() => { startServerLink(); startRoom(); load(); }, []);
  // A new version was deployed: phones just reload (nothing to lose here).
  useEffect(() => { if (updateReady()) applyUpdate(); }, [updateReady()]);
  // Role changed (promoted / stepped down) → the server reconnects us; refresh what we're allowed to do.
  const m = me.value as any;
  useEffect(() => { if (m) load(); }, [m?.role, m?.status]);
  if (m && m.status === 'none' && !m.owner) { location.href = '/join'; return null; }

  const owner = !!(info?.owner || m?.owner);
  const role: string = m?.effectiveRole || m?.role || (owner ? 'owner' : '');
  const canWrite = info?.canWrite ?? false;
  const casting = fun.value?.casting;
  if (blocked === 'wifi') return <main class="rp"><Blocked title="Use the room's Wi-Fi" text="This room only works on the hostel Wi-Fi. Turn off mobile data, connect to the Wi-Fi, then scan the QR again." /></main>;
  if (blocked) return <main class="rp"><Blocked title="Can't open the room" text={blocked} /></main>;
  return (
    <main class="rp">
      <header class="rp-head">
        <div class="rp-id">
          <span class="rp-av">{(m?.name || 'J').slice(0, 1).toUpperCase()}</span>
          <div>
            <div class="rp-name">{m?.name || 'Jharokha'}</div>
            <div class="rp-role"><span class={`role-tag r-${role}`}>{role || '…'}</span>{m?.quiet ? <span class="small amber"> · quiet hours</span> : null}</div>
          </div>
        </div>
        <span class={`live ${serverOffline.value ? 'off' : server.value.online ? 'on' : 'wait'}`}>{serverOffline.value ? 'offline' : server.value.online ? 'live' : '…'}</span>
      </header>

      {tab === 'home' && (
        <div class="rp-stack">
          {alarmPhase(tools.value?.alarm).active && <section class="rp-card hero"><h2><Icon name="sun" size={16} /> Alarm</h2><AlarmCard /></section>}
          {appState.value && canWrite && (
            <section class="rp-card hero"><h2><Icon name="remote" size={16} /> Remote</h2><AppRemote /></section>
          )}
          {casting ? (
            <section class="rp-card hero"><h2><Icon name="cast" size={16} /> On the wall</h2><MediaRemote you={info?.you} /></section>
          ) : (
            <section class="rp-card hero">
              <h2><Icon name="cast" size={16} /> Cast to the screen</h2>
              {canWrite ? <CastFromPhone owner={owner} initialLink={shared} /> : <p class="muted small">Read-only right now.</p>}
            </section>
          )}
          <section class="rp-card"><h2><Icon name="door" size={16} /> Door</h2>{owner ? <DoorPicker /> : <DoorBadge big />}</section>
          <section class="rp-card"><h2><Icon name="globe" size={16} /> Apps</h2><AppTiles where="phone" />{owner && <RemoteHelperSetup compact />}</section>
          {owner && <ScreensCard />}
          <StudyMini onOpen={() => go('fun')} />
        </div>
      )}
      {tab === 'share' && (
        <div class="rp-stack">
          <section class="rp-card hero"><h2><Icon name="cast" size={16} /> Cast from this phone</h2>{canWrite ? <CastFromPhone owner={owner} /> : <p class="muted small">Read-only right now.</p>}</section>
          <section class="rp-card"><h2><Icon name="globe" size={16} /> Cast a link</h2><CastBox canWrite={canWrite} /></section>
          <section class="rp-card"><h2><Icon name="play" size={16} /> Watch-party queue</h2><WatchQueue you={info?.you} canWrite={canWrite} /></section>
          <section class="rp-card"><h2><Icon name="upload" size={16} /> Files</h2><DropZone canWrite={canWrite} you={info?.you} /></section>
        </div>
      )}
      {tab === 'board' && <section class="rp-card"><h2><Icon name="note" size={16} /> Room board</h2><BoardEditor by={m?.name || 'Guest'} /></section>}
      {tab === 'fun' && (
        <div class="rp-stack">
          <section class="rp-card"><h2><Icon name="calendar" size={16} /> Study room</h2><PomoCard canWrite={canWrite} /></section>
          <section class="rp-card"><h2><Icon name="people" size={16} /> Game night</h2><Scoreboard canWrite={canWrite} /></section>
        </div>
      )}
      {tab === 'tools' && (
        <div class="rp-stack">
          <section class="rp-card"><h2><Icon name="check" size={16} /> Polls</h2><PollsCard you={info?.you} canWrite={canWrite} /></section>
          <section class="rp-card"><h2><Icon name="calendar" size={16} /> Laundry timers</h2><TimersCard you={info?.you} canWrite={canWrite} /></section>
          <section class="rp-card"><h2><Icon name="people" size={16} /> Split & Settle</h2><SplitCard you={info?.you} canWrite={canWrite} /></section>
          <section class="rp-card"><h2><Icon name="sun" size={16} /> Sunrise alarm</h2><AlarmCard /></section>
        </div>
      )}
      {tab === 'people' && <PeopleTab owner={owner} role={role} />}
      <DingBanner />

      <nav class="rp-tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k} class={tab === t.k ? 'on' : ''} onClick={() => go(t.k)}>
            <span class="pill"><Icon name={t.icon} size={22} /></span>{t.label}
            {t.k === 'people' && owner && !!accessState.value?.pending && <span class="dot" />}
            {t.k === 'tools' && !!tools.value?.timers.some((x) => x.done) && <span class="dot" />}
          </button>
        ))}
      </nav>
    </main>
  );
}

function Blocked({ title, text }: { title: string; text: string }) {
  return <section class="rp-card center"><div class="rp-brand">Jharokha</div><h2 class="big-h">{title}</h2><p class="muted">{text}</p></section>;
}

/** Pick a video / photo / song on this phone → it plays on the PC (owners) or asks the owner (others). */
function CastFromPhone({ owner, initialLink = '' }: { owner: boolean; initialLink?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [prog, setProg] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [link, setLink] = useState(initialLink);
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); const m = t.match(/https:\/\/\S+/); if (m) setLink(m[0]); else setMsg('Nothing to paste: copy the reel link first.'); }
    catch { setMsg('Long-press the box and choose Paste.'); }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setMsg(''); setProg(0);
    try {
      const r: any = await castFile(f, setProg);
      setMsg(r.pending ? 'Sent. The owner taps "Show on wall" on the laptop.' : 'Playing on the screen.');
    } catch (e: any) { setMsg(e.message); }
    setProg(null);
  };
  return (
    <div class="cfp">
      <button class="cfp-big" onClick={() => input.current?.click()} disabled={prog != null}>
        <Icon name="upload" size={28} />
        <span><b>{prog != null ? `Sending… ${Math.round(prog * 100)}%` : 'Video, photo or song'}</b><span class="small muted">from your gallery or files</span></span>
      </button>
      {prog != null && <span class="bar"><span style={{ width: `${prog * 100}%` }} /></span>}
      <input ref={input} type="file" accept="video/*,image/*,audio/*" hidden onChange={(e) => { pick((e.target as HTMLInputElement).files?.[0]); (e.target as HTMLInputElement).value = ''; }} />
      <form class="row" onSubmit={(e) => { e.preventDefault(); castLink(link).then((r: any) => { setLink(''); setMsg(r.pending ? 'Asked: the owner will approve it.' : 'On the screen now.'); }).catch((x) => setMsg(x.message)); }}>
        <input value={link} placeholder="…or a reel / YouTube link" inputMode="url" aria-label="Link to cast" onInput={(e) => setLink((e.target as HTMLInputElement).value)} />
        {!link && <button type="button" onClick={paste}>Paste</button>}
        {link && <button type="submit" class="primary">{owner ? 'Cast' : 'Ask'}</button>}
      </form>
      <details class="reel-help">
        <summary>How to cast a reel</summary>
        <ol class="small">
          <li><b>Instagram:</b> open the reel → paper-plane (Share) → <i>Copy link</i>.</li>
          <li><b>YouTube Shorts / TikTok / Facebook:</b> Share → <i>Copy link</i>.</li>
          <li>Come back here, tap <b>Paste</b>, then <b>Cast</b>.</li>
        </ol>
        <p class="tiny muted">YouTube Shorts can be paused and turned up from this phone. Instagram / Facebook / TikTok reels play on the screen, but those apps don't allow remote buttons: click the reel on the PC to unmute. Saved a reel to your phone? Cast it as a video file above.</p>
      </details>
      {msg && <p class="small muted">{msg}</p>}
      <p class="tiny muted">Files go to the laptop over an encrypted link, are stored encrypted, photo location data is removed, and everything is deleted after 7 days.</p>
    </div>
  );
}

function ScreensCard() {
  const s = screen.value;
  if (!s) return <section class="rp-card"><h2><Icon name="remote" size={16} /> Screens</h2><p class="muted small">The dashboard isn't running on the laptop.</p></section>;
  const started = s.layer !== 'start';
  return (
    <section class="rp-card">
      <h2><Icon name="remote" size={16} /> Screens <span class="small muted">{s.mode === 'dual' ? 'two screens' : 'one screen'}{s.scene ? ` · ${s.scene}` : ''}</span></h2>
      {!started && <p class="small muted">Press Start on the laptop first.</p>}
      <div class="remote-grid">
        <button class="rbtn" disabled={!started || s.cinema || s.night} onClick={() => sendRemote('swap')}><Icon name="swap" size={24} />Swap</button>
        <button class={`rbtn ${s.cinema ? 'on' : ''}`} disabled={!started} aria-pressed={s.cinema} onClick={() => sendRemote('cinema')}><Icon name="cinema" size={24} />Cinema</button>
        <button class={`rbtn ${s.night ? 'on' : ''}`} disabled={!started} aria-pressed={s.night} onClick={() => sendRemote('night')}><Icon name="night" size={24} />Night</button>
        <button class={`rbtn ${s.showcase ? 'on' : ''}`} disabled={!started} aria-pressed={!!s.showcase} onClick={() => sendRemote('showcase')}><Icon name="music" size={24} />Showcase</button>
      </div>
      <details class="wp-pick">
        <summary>Wallpaper: {s.wallpapers.find((w) => w.id === s.currentId)?.name ?? '—'}</summary>
        <ul class="wp-remote">
          {s.wallpapers.map((w) => <li key={w.id}><button class={w.id === s.currentId ? 'on' : ''} onClick={() => sendRemote('wallpaper', w.id)}>{w.name}</button></li>)}
        </ul>
      </details>
    </section>
  );
}

function StudyMini({ onOpen }: { onOpen: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const p = fun.value?.pomo;
  if (!p || p.phase === 'idle') return null;
  return (
    <button class="rp-card study-mini" onClick={onOpen}>
      <Icon name="calendar" size={18} /><b>{p.phase === 'focus' ? 'Focus' : 'Break'}</b><span class="sm-time">{fmtClock(pomoLeft(p))}</span><span class="muted small">{p.running ? 'study room' : 'paused'}</span>
    </button>
  );
}

/** Members (owners can change roles or kick out), and your own controls: step down / leave. */
function PeopleTab({ owner, role }: { owner: boolean; role: string }) {
  const a = accessState.value;
  const m = me.value as any;
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState<'leave' | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setErr('')).catch((e) => setErr(String(e.message || e)));
  const people = (a?.devices || []).filter((d) => d.status === 'approved');
  const pending = (a?.devices || []).filter((d) => d.status === 'pending');
  return (
    <div class="rp-stack">
      <section class="rp-card">
        <h2><Icon name="people" size={16} /> You</h2>
        <div class="me-row"><span class="rp-av">{(m?.name || '?').slice(0, 1).toUpperCase()}</span><div><b>{m?.name}</b><div class="small muted">{role}</div></div></div>
        <div class="me-actions">
          {role === 'owner' && <button onClick={() => run(stepDown('collaborator'))}><Icon name="down" size={16} /> Step down to collaborator</button>}
          {(role === 'owner' || role === 'collaborator') && <button onClick={() => run(stepDown('viewer'))}><Icon name="down" size={16} /> Step down to viewer</button>}
          {confirm === 'leave'
            ? <div class="row"><button class="danger" onClick={() => leaveRoom().then(() => { location.href = '/join'; }).catch((e) => setErr(e.message))}>Yes, leave</button><button onClick={() => setConfirm(null)}>Cancel</button></div>
            : <button class="danger-ghost" onClick={() => setConfirm('leave')}><Icon name="leave" size={16} /> Leave the room</button>}
        </div>
        <p class="tiny muted">Stepping down can't be undone by yourself: an owner has to promote you again.</p>
      </section>
      {owner ? (
        <section class="rp-card">
          <h2><Icon name="people" size={16} /> Members <span class="small muted">{people.length}</span></h2>
          {pending.map((d) => (
            <div class="person pending" key={d.id}>
              <span class="rp-av">{d.name.slice(0, 1).toUpperCase()}</span>
              <div class="p-main"><b>{d.name}</b><div class="small amber">wants to join · {d.ua}</div></div>
              <button class="primary" onClick={() => run(decide(d.id, 'approve', 'collaborator'))}>Let in</button>
              <button class="icon-btn" aria-label={`Deny ${d.name}`} onClick={() => run(decide(d.id, 'deny'))}><Icon name="x" size={18} /></button>
            </div>
          ))}
          {people.map((d) => (
            <div class="person" key={d.id}>
              <span class={`rp-av ${d.lastSeen && Date.now() - d.lastSeen < 600000 ? 'on' : ''}`}>{d.name.slice(0, 1).toUpperCase()}</span>
              <div class="p-main"><b>{d.name}</b><div class="small muted">{d.ua}</div></div>
              {d.id === m?.id ? <span class="small muted">you</span> : (
                <>
                  <select class="role-sel" value={d.role ?? ''} aria-label={`Role for ${d.name}`} onChange={(e) => run(decide(d.id, 'role', (e.target as HTMLSelectElement).value))}>
                    <option value="owner">Owner</option><option value="collaborator">Collaborator</option><option value="viewer">Viewer</option>
                  </select>
                  <button class="icon-btn danger" aria-label={`Kick out ${d.name}`} title="Kick out" onClick={() => run(decide(d.id, 'revoke'))}><Icon name="leave" size={18} /></button>
                </>
              )}
            </div>
          ))}
          {!people.length && !pending.length && <p class="muted small">Nobody else yet.</p>}
        </section>
      ) : (
        <section class="rp-card"><h2><Icon name="people" size={16} /> Members</h2><p class="muted small">Only owners can see and manage members.</p></section>
      )}
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}
