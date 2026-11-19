import { useEffect, useRef, useState } from 'preact/hooks';
import {
  DEBUG, ROLE, arming, blobMB, diskReads, layer, library, loopStats, mode, monitorBack, needMonitorTap, notice,
  overlayOpen, screensInfo, cinema, nightWatch, swapping, showcase,
} from '../state';
import { castHere, init, isWallWindow, launchApp, launchAppWithTap, openMonitorWindow, requestSwap, start, toggleFullscreen } from '../host';
import { Icon } from './Icon';
import { DingBanner, Sunrise } from './Tools';
import { CastOverlay, usePomoChime } from './Fun';
import { castStop, fun, opened, openRequest } from '../room/roomClient';
import { accessState, applyUpdate, me, updateReady } from '../serverLink';
import { toast } from '../state';
import { CinemaStrip, NightWatch, WeatherLine } from './Week2';
import { OfflineBadge } from './Week3';
import { ApprovalTray, RequestPill } from './Week4';
import { Layer2 } from './Layer2';
import { startServerLink } from '../serverLink';
import { startRoom } from '../room/roomClient';
import { Clock } from './Clock';
import { Library } from './Library';
import { startVitals } from './vitals';

export function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { init(stageRef.current!); startVitals(); startServerLink(); startRoom(); }, []);

  const l = layer.value;
  // 🎬 Cinema: the strip goes on the dashboard screen (or the only screen); the wallpaper screen just pauses.
  const strip = cinema.value && l !== 'start' && (l === 'L2' || mode.value === 'single');
  const showPanel = strip || l === 'start' || l === 'L2' || (l === 'L1' && overlayOpen.value);
  const casting = fun.value?.casting;
  // A phone asked to open an app here: straight into the apps window if we have one, else a one-tap prompt.
  useEffect(() => {
    const r = openRequest.value;
    if (!r || ROLE !== 'A') return;
    if (launchApp(r.url)) { toast(`${r.by} opened ${r.title || new URL(r.url).hostname}`, 4000); openRequest.value = null; }
  }, [openRequest.value]);
  useEffect(() => {
    const o = opened.value;
    if (o && ROLE === 'A') { toast(`${o.by} opened ${o.title || 'an app'} on this PC`, 4000); opened.value = null; }
  }, [opened.value]);
  // New version deployed: on the start screen just reload; otherwise offer it (a reload would drop dual-screen).
  useEffect(() => { if (updateReady() && l === 'start') applyUpdate(); }, [updateReady(), l]);
  usePomoChime(isWallWindow() && l !== 'start' && !nightWatch.value && !cinema.value && !accessState.value?.quiet.now);
  return (
    <>
      <div id="stage" ref={stageRef} />
      {l === 'L1' && !cinema.value && <WallOverlay />}
      <main class={`panel ${showPanel ? '' : 'gone'} ${l === 'L1' ? 'over-video' : ''} ${arming.value ? 'arming' : ''} ${strip ? 'cinema' : ''}`} aria-hidden={!showPanel}>
        {strip ? <CinemaStrip /> : l === 'start' ? <StartScreen /> : <Layer2 />}
      </main>
      {casting && castHere() && l !== 'start' && !nightWatch.value && (
        <CastOverlay link={casting} onStop={me.value?.owner ? () => { castStop().catch(() => {}); } : undefined} />
      )}
      {nightWatch.value && l !== 'start' && <NightWatch />}
      {showcase.value && l !== 'start' && isWallWindow() && <LazyShowcase />}
      {l !== 'start' && isWallWindow() && <Sunrise />}
      {l !== 'start' && <DingBanner enabled={isWallWindow() && !cinema.value} />}
      {ROLE === 'B' && <TapFullscreen />}
      {(monitorBack.value || needMonitorTap.value) && (
        <div class="banner">
          {needMonitorTap.value ? 'One more tap to light up the monitor.' : 'Monitor connected.'}
          <button class="primary" onClick={openMonitorWindow}>Open on monitor</button>
          <button onClick={() => { monitorBack.value = false; needMonitorTap.value = false; }}>Not now</button>
        </div>
      )}
      {showPanel && !strip && l !== 'start' && <OfflineBadge />}
      {showPanel && !strip && l !== 'start' && <ApprovalTray />}
      {l === 'L1' && !showPanel && !cinema.value && !nightWatch.value && <RequestPill />}
      {ROLE === 'A' && openRequest.value && Date.now() - openRequest.value.at < 120000 && (
        <div class="banner open-req">
          <b>{openRequest.value.by}</b> wants to open <b>{openRequest.value.title || new URL(openRequest.value.url).hostname}</b> on this PC.
          <button class="primary" onClick={() => { launchAppWithTap(openRequest.value!.url); openRequest.value = null; }}>Open</button>
          <button onClick={() => { openRequest.value = null; }}>Not now</button>
          <span class="small muted">After this, phone requests open by themselves.</span>
        </div>
      )}
      {updateReady() && l !== 'start' && (
        <div class="update-pill" role="status">
          Jharokha was updated <button class="primary" onClick={applyUpdate}>Reload</button>
        </div>
      )}
      {notice.value && <div class="toast" role="status">{notice.value}</div>}
    </>
  );
}

// --------------------------------------------------------------------------- Start (W-A only)
function StartScreen() {
  const si = screensInfo.value;
  return (
    <div class="start">
      <h1 class="brand">Jharokha</h1>
      <p class="muted">A living window for your room.</p>
      <button class="primary huge" onClick={start} disabled={!library.value.length}>Start</button>
      <p class="muted small">
        {si.permission === 'granted'
          ? `${si.count} screen(s): ${si.labels.join(' · ')}${si.count >= 2 ? ' → dual-screen' : ' → single-screen'}`
          : si.permission === 'unsupported'
            ? 'Multi-screen API not available here → single-screen'
            : 'Start will ask to "manage windows" so it can use both screens.'}
      </p>
      <Library />
    </div>
  );
}

// --------------------------------------------------------------------------- Layer 1 extras
function WallOverlay() {
  const st = loopStats.value;
  return (
    <>
      <div class="wall-clock"><Clock size="small" /><WeatherLine compact /></div>
      <button class="l1-swap" onClick={(e) => { e.stopPropagation(); requestSwap(); }} disabled={swapping.value}
        title={mode.value === 'single' ? 'Show the dashboard (S)' : 'Swap screens (S)'}>
        <Icon name={mode.value === 'single' ? 'image' : 'swap'} size={20} />{mode.value === 'single' ? 'Dashboard' : 'Swap'}
      </button>
      {DEBUG && st && (
        <div class="hud">
          {st.width}×{st.height} · {st.fps} fps · dropped {st.dropped}/{st.totalDecoded}<br />
          loops {st.loops} · hitches {st.hitches} · seam {st.lastSeamMs}/{st.worstSeamMs} ms · {blobMB.value} MB · reads {diskReads.value}
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------------------- W-B fullscreen tap
function TapFullscreen() {
  const [fs, setFs] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  if (fs) return null;
  return <div class="tapfs"><button class="primary huge" onClick={toggleFullscreen}>Tap to fill this screen</button></div>;
}

// Showcase is its own chunk (canvas + Web Audio), loaded the first time it's switched on.
let showcaseMod: typeof import('./Showcase') | null = null;
function LazyShowcase() {
  const [m, setM] = useState(showcaseMod);
  useEffect(() => { if (!m) import('./Showcase').then((x) => { showcaseMod = x; setM(x); }); }, []);
  return m ? <m.Showcase /> : <div class="showcase" />;
}
