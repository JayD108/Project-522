// Layer 2, redesigned (Week 5): two layouts for two jobs.
//  · Control centre (laptop, < 1700 px): compact header + tabs (Home · Wallpapers · Room · System).
//  · Wall (monitor, ≥ 1700 px): glanceable from 3 m: huge clock, door sign, board as sticky notes, people + join QR.
import { useEffect, useState } from 'preact/hooks';
import {
  DEBUG, ROLE, theme, activeScene, blobMB, currentId, diskReads, lastReadMs, library, loopStats, mode, nextChange, overlayOpen, scenes,
  swapFails, swapSummary, swapping, swaps, yielded,
} from '../state';
import { autoSwap, launchAppWithTap, requestSwap, setTheme, toggleCinema, toggleFullscreen, toggleNightWatch, toggleShowcase } from '../host';
import { WallTools } from './Tools';
import { accessState, me, qrSrc, server } from '../serverLink';
import { boardWritable, fun, notes } from '../room/roomClient';
import { CastBox, MediaRemote, PomoCard, PomoWall, ScoreWall, Scoreboard, UpNext, WatchQueue } from './Fun';
import { AppTiles } from './Apps';
import { Clock } from './Clock';
import { RemoteHelperSetup } from './AppRemote';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { Library } from './Library';
import { BoardEditor, BoardWall, ConnectPhone, DoorBadge, DoorPicker, DropZone, People } from './Room';
import { ScenesCard, WeatherCard, WeatherLine } from './Week2';
import { ServerPanel, VitalsRing } from './Week3';
import { AccessCard, PairCard } from './Week4';
import { vitals } from './vitals';

type Tab = 'home' | 'wallpapers' | 'room' | 'fun' | 'tools' | 'system';

export function useIsWall() {
  const [wall, setWall] = useState(() => innerWidth >= 1700);
  useEffect(() => {
    const on = () => setWall(innerWidth >= 1700);
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return wall;
}

export function Layer2() {
  const wall = useIsWall();
  return wall ? <WallDisplay /> : <ControlCenter />;
}

// ============================================================================ shared bits
function ScreenActions({ labels = true }: { labels?: boolean }) {
  const single = mode.value === 'single';
  return (
    <div class="actions">
      <button class="primary" onClick={requestSwap} disabled={swapping.value} title={single ? 'Show the wallpaper (S)' : 'Swap screens (S)'}>
        <Icon name={single ? 'image' : 'swap'} />{labels && (single ? (overlayOpen.value ? 'Wallpaper' : 'Dashboard') : 'Swap')}
      </button>
      <button onClick={toggleCinema} title="Cinema (C): pause the wallpaper, dim this screen"><Icon name="cinema" />{labels && 'Cinema'}</button>
      <button onClick={toggleNightWatch} title="Night Watch (N): both screens near-black"><Icon name="night" />{labels && 'Night'}</button>
      <button onClick={toggleShowcase} title="Showcase (V): the wall dances to the music in the room"><Icon name="music" />{labels && 'Showcase'}</button>
      <button class="icon-only" onClick={toggleFullscreen} aria-label="Fullscreen (F)" title="Fullscreen (F)"><Icon name="fullscreen" /></button>
    </div>
  );
}

function Card({ title, icon, children, class: cls = '', action }: { title: string; icon?: string; children: any; class?: string; action?: any }) {
  return (
    <section class={`card ${cls}`}>
      <div class="card-head"><h2>{icon && <Icon name={icon} size={16} />}{title}</h2>{action}</div>
      {children}
    </section>
  );
}

function NowPlaying() {
  const st = loopStats.value;
  const wp = library.value.find((w) => w.id === currentId.value);
  const sc = scenes.value.find((s) => s.key === activeScene.value);
  const nx = nextChange.value;
  const fmtIn = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  return (
    <div class="now">
      <div class="now-name">{ROLE === 'A' ? (wp?.name ?? 'No wallpaper') : 'Wallpaper on the other screen'}</div>
      <div class="now-meta">
        {yielded.value ? 'Paused for other apps' : st ? `${st.width}×${st.height} · ${Math.round(st.fps)} fps${st.paused ? ' · paused' : ''}` : 'On the other screen'}
      </div>
      {ROLE === 'A' && sc && <div class="now-scene"><Icon name="sun" size={14} /> {sc.label}{nx ? ` · ${nx.label} in ${fmtIn(nx.inMs)}` : ''}</div>}
    </div>
  );
}

// ============================================================================ control centre (laptop)
function readTab(): Tab {
  try { const t = localStorage.getItem('jhk-tab') as Tab | null; if (t && ['home', 'wallpapers', 'room', 'fun', 'tools', 'system'].includes(t)) return t; } catch { /* storage off */ }
  return 'home';
}

function ControlCenter() {
  const [tab, setTabState] = useState<Tab>(readTab);
  const [connect, setConnect] = useState(false);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem('jhk-tab', t); } catch { /* */ } };
  const pending = accessState.value?.pending ?? 0;
  const owner = !!me.value?.owner;
  const tabs: { k: Tab; label: string; icon: string; badge?: number; hide?: boolean }[] = [
    { k: 'home', label: 'Home', icon: 'home' },
    { k: 'wallpapers', label: 'Wallpapers', icon: 'image', hide: ROLE !== 'A' },
    { k: 'room', label: 'Room', icon: 'people', badge: pending },
    { k: 'fun', label: 'Fun', icon: 'cinema', badge: owner ? fun.value?.casts.length || 0 : 0 },
    { k: 'tools', label: 'Tools', icon: 'tools' },
    { k: 'system', label: 'System', icon: 'gauge' },
  ];
  const by = me.value?.name || 'Laptop';
  return (
    <div class="cc">
      <header class="cc-head">
        <div class="cc-time"><Clock /><WeatherLine /></div>
        <DoorBadge />
        <ScreenActions />
      </header>
      <nav class="tabs" role="tablist" aria-label="Dashboard sections">
        {tabs.filter((t) => !t.hide).map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k} class={`tab ${tab === t.k ? 'on' : ''}`} onClick={() => setTab(t.k)}>
            <Icon name={t.icon} />{t.label}{!!t.badge && <span class="badge" aria-label={`${t.badge} waiting`}>{t.badge}</span>}
          </button>
        ))}
      </nav>
      <PairCard />
      <div class="tab-body" role="tabpanel">
        {tab === 'home' && (
          <div class="home">
            <div class="home-main">
              <VitalsRing />
              <Card title="Room board" icon="note" action={notes.value.length > 4 ? <button class="small-btn" onClick={() => setTab('room')}>All {notes.value.length}</button> : null}>
                <BoardEditor by={by} compact />
              </Card>
            </div>
            <div class="home-side">
              {fun.value?.casting && <Card title="On the wall" icon="cast"><MediaRemote you="laptop" /></Card>}
              <Card title="Now playing" icon="play"><NowPlaying /><UpNext /></Card>
              <Card title="Apps" icon="globe"><AppTiles where="pc" launch={launchAppWithTap} /></Card>
              {fun.value && fun.value.pomo.phase !== 'idle' && <Card title="Study room" icon="calendar"><PomoCard /></Card>}
              <Card title="Door sign" icon="door"><DoorPicker /></Card>
              <Card title="People" icon="people" action={<button class="small-btn" onClick={() => setConnect(true)}><Icon name="qr" size={14} /> Connect a phone</button>}>
                {owner ? <People /> : <p class="muted small">Pair this screen to see who's in.</p>}
              </Card>
            </div>
          </div>
        )}
        {tab === 'wallpapers' && ROLE === 'A' && (
          <div class="grid">
            <Library />
            <ScenesCard />
            <WeatherCard />
            <Card title="Look" icon="sun">
              <div class="themes" role="radiogroup" aria-label="Dashboard look">
                <button role="radio" aria-checked={theme.value === 'night'} class={`theme-opt t-night ${theme.value === 'night' ? 'on' : ''}`} onClick={() => setTheme('night')}>
                  <span class="sw" /><b>Night</b><span class="small muted">warm dark</span>
                </button>
                <button role="radio" aria-checked={theme.value === 'ink'} class={`theme-opt t-ink ${theme.value === 'ink' ? 'on' : ''}`} onClick={() => setTheme('ink')}>
                  <span class="sw" /><b>Ink</b><span class="small muted">paper &amp; brush</span>
                </button>
              </div>
              <p class="small muted">Applies to both screens. Night Watch and Cinema stay dark.</p>
            </Card>
          </div>
        )}
        {tab === 'room' && (
          <div class="grid">
            <Card title="Room board" icon="note" class="span-2"><BoardEditor by={by} /></Card>
            <Card title="Drop zone" icon="upload"><DropZone you={owner ? 'laptop' : null} /></Card>
            <AccessCard />
            {!owner && <Card title="Access" icon="people"><p class="muted small">Pair this screen to approve people.</p></Card>}
          </div>
        )}
        {tab === 'fun' && (
          <div class="grid">
            <Card title="Watch-party queue" icon="play" class="span-2"><WatchQueue you={owner ? 'laptop' : null} canWrite={boardWritable.value} /></Card>
            <Card title="Cast to wall" icon="cinema"><CastBox canWrite={boardWritable.value} /></Card>
            <Card title="Study room" icon="calendar"><PomoCard canWrite={boardWritable.value} /></Card>
            <Card title="Game night" icon="people"><Scoreboard canWrite={boardWritable.value} /></Card>
          </div>
        )}
        {tab === 'tools' && <ToolsTab />}
        {tab === 'system' && (
          <div class="grid">
            <ServerPanel />
            <EngineCard />
            <Card title="Connect a phone" icon="phone" class="span-2"><ConnectPhone /></Card>
            <Card title="Phone remote for Netflix / YouTube" icon="remote" class="span-2"><RemoteHelperSetup /></Card>
          </div>
        )}
      </div>
      {connect && <Modal label="Connect a phone" onClose={() => setConnect(false)}><ConnectPhone /></Modal>}
    </div>
  );
}

function EngineCard() {
  const st = loopStats.value;
  const sum = swapSummary(swaps.value);
  const [auto, setAuto] = useState('');
  const runAuto = async () => {
    setAuto('running…');
    const r0 = diskReads.value;
    const { ok, times } = await autoSwap(50);
    const s = swapSummary(times);
    setAuto(`${ok}/50 ok · med ${s?.med ?? '–'} · max ${s?.max ?? '–'} ms · disk reads during test: ${diskReads.value - r0}`);
  };
  return (
    <Card title="Wallpaper engine" icon="play">
      <dl class="kv">
        <dt>Playing</dt><dd>{yielded.value ? 'released (yielded to other apps)' : st ? `${st.width}×${st.height} · ${st.fps} fps${st.paused ? ' · paused' : ''}` : '—'}</dd>
        <dt>Loop</dt><dd>{st ? `${st.loops} loops · ${st.hitches} hitches · seam ${st.lastSeamMs} ms` : '—'}</dd>
        <dt>Dropped</dt><dd>{st ? `${st.dropped} / ${st.totalDecoded}` : '—'}</dd>
        <dt>Swaps</dt><dd>{sum ? `${sum.n} · median ${sum.med} ms · max ${sum.max} ms` : 'none yet'}{swapFails.value ? ` · ${swapFails.value} failed` : ''}</dd>
        <dt>RAM</dt><dd>{blobMB.value ? `${blobMB.value} MB clip held here` : 'no clip held here'}{vitals.value.heapMB != null ? ` · JS ${vitals.value.heapMB} MB` : ''}</dd>
        <dt>Disk</dt><dd>{diskReads.value} video read(s){lastReadMs.value ? ` · last ${lastReadMs.value} ms` : ''}</dd>
      </dl>
      {DEBUG && ROLE === 'A' && mode.value === 'dual' && (
        <p><button onClick={runAuto} disabled={auto === 'running…'}>Auto-swap ×50</button> <span class="small">{auto}</span></p>
      )}
    </Card>
  );
}

// ============================================================================ wall display (monitor)
function WallDisplay() {
  const j = server.value.join;
  const owner = !!me.value?.owner;
  return (
    <div class="wall2">
      <section class="w-time">
        <div><Clock /><WeatherLine /></div>
        <DoorBadge big />
      </section>
      <section class={`w-board ${fun.value?.game.players.length ? 'with-score' : ''}`}>
        <div class="w-notes">
          <h2 class="w-h"><Icon name="note" size={20} /> Room board</h2>
          <BoardWall max={fun.value?.game.players.length ? 8 : 12} />
        </div>
        <ScoreWall />
      </section>
      <aside class="w-side">
        {fun.value && fun.value.pomo.phase !== 'idle' ? <PomoWall /> : <VitalsRing mini />}
        <WallTools />
        {owner && <div class="w-people"><People /></div>}
        {j && (
          <div class="w-join">
            <img class="qr" src={qrSrc(j.url)} alt={`QR code to join: ${j.url}`} width={168} height={168} />
            <div>
              <div class="w-join-title">Scan to join</div>
              <div class="w-join-url">{j.url.replace(/^http:\/\//, '')}</div>
            </div>
          </div>
        )}
      </aside>
      <footer class="w-foot">
        <div class="w-foot-l"><NowPlaying /><UpNext /></div>
        <ScreenActions labels={false} />
      </footer>
    </div>
  );
}

/** Tools tab: its cards are a separate chunk, so the always-on dashboard stays small. */
let toolsMod: typeof import('./ToolsCards') | null = null;
function ToolsTab() {
  const [m, setM] = useState(toolsMod);
  useEffect(() => { if (!m) import('./ToolsCards').then((x) => { toolsMod = x; setM(x); }); }, []);
  if (!m) return <p class="muted small">Loading…</p>;
  const w = boardWritable.value;
  return (
    <div class="grid">
      <Card title="Polls" icon="check" class="span-2"><m.PollsCard you="laptop" canWrite={w} /></Card>
      <Card title="Laundry timers" icon="calendar"><m.TimersCard you="laptop" canWrite={w} /></Card>
      <Card title="Split & Settle" icon="people" class="span-2"><m.SplitCard you="laptop" canWrite={w} /></Card>
      <Card title="Sunrise alarm" icon="sun"><m.AlarmCard /></Card>
    </div>
  );
}
