import { useEffect, useRef, useState } from 'preact/hooks';
import {
  DEBUG, ROLE, arming, blobMB, diskReads, layer, lastReadMs, library, loopStats, mode, monitorBack, needMonitorTap, notice,
  overlayOpen, peer, screensInfo, swapFails, swapSummary, swapping, swaps,
} from '../state';
import { autoSwap, init, openMonitorWindow, requestSwap, start, toggleFullscreen } from '../host';
import { Clock } from './Clock';
import { Library } from './Library';
import { startVitals, vitals } from './vitals';

export function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { init(stageRef.current!); startVitals(); }, []);

  const l = layer.value;
  const showPanel = l === 'start' || l === 'L2' || (l === 'L1' && overlayOpen.value);
  return (
    <>
      <div id="stage" ref={stageRef} />
      {l === 'L1' && <WallOverlay />}
      <main class={`panel ${showPanel ? '' : 'gone'} ${l === 'L1' ? 'over-video' : ''} ${arming.value ? 'arming' : ''}`} aria-hidden={!showPanel}>
        {l === 'start' ? <StartScreen /> : <Layer2 />}
      </main>
      {ROLE === 'B' && <TapFullscreen />}
      {(monitorBack.value || needMonitorTap.value) && (
        <div class="banner">
          {needMonitorTap.value ? 'One more tap to light up the monitor.' : 'Monitor connected.'}
          <button class="primary" onClick={openMonitorWindow}>Open on monitor</button>
          <button onClick={() => { monitorBack.value = false; needMonitorTap.value = false; }}>Not now</button>
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
      <div class="wall-clock"><Clock size="small" /></div>
      {DEBUG && st && (
        <div class="hud">
          {st.width}×{st.height} · {st.fps} fps · dropped {st.dropped}/{st.totalDecoded}<br />
          loops {st.loops} · hitches {st.hitches} · seam {st.lastSeamMs}/{st.worstSeamMs} ms · {blobMB.value} MB · reads {diskReads.value}
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------------------- Layer 2
function useIsWall() {
  const [wall, setWall] = useState(() => innerWidth >= 1700);
  useEffect(() => {
    const on = () => setWall(innerWidth >= 1700);
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return wall;
}

function Layer2() {
  const wall = useIsWall();
  const single = mode.value === 'single';
  return (
    <div class={`l2 ${wall ? 'wall' : 'compact'}`}>
      <header class="l2-head">
        <Clock />
        <div class="actions">
          <button class="primary big" onClick={requestSwap} disabled={swapping.value}>
            {single ? (overlayOpen.value ? '▣ Back to wallpaper' : '▣ Dashboard') : '⇄ Swap'}
          </button>
          <button disabled title="Week 2">🎬 Cinema</button>
          <button onClick={toggleFullscreen}>⛶</button>
        </div>
      </header>
      <VitalsStrip />
      <div class="l2-grid">
        {ROLE === 'A' || !wall ? <Library /> : null}
        <EngineCard />
      </div>
    </div>
  );
}

function VitalsStrip() {
  const v = vitals.value;
  const p = peer.value;
  const b = v.battery;
  const pressureCls = v.pressure === 'serious' || v.pressure === 'critical' ? 'warn' : v.pressure === 'fair' ? 'amber' : 'good';
  return (
    <div class="vitals">
      <Vital label="Power" value={b ? `${Math.round(b.level * 100)}%${b.charging ? ' ⚡' : ''}` : 'n/a'} cls={b && b.level < 0.2 && !b.charging ? 'warn' : ''} />
      <Vital label="CPU" value={v.pressure} cls={pressureCls} />
      <Vital label="Network" value={v.online ? (v.net?.type ? `${v.net.type} · ${v.net.rtt ?? '?'} ms` : 'online') : 'offline'} cls={v.online ? '' : 'warn'} />
      <Vital label="Screens" value={mode.value === 'dual' ? (p.alive ? `linked · ${p.rtt ?? '–'} ms` : 'no link') : 'single'} cls={mode.value === 'dual' && !p.alive ? 'warn' : ''} />
      <Vital label="Temp / fan" value="n/a" cls="muted" />
    </div>
  );
}

function Vital({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return <div class="vital"><span class="vital-label">{label}</span><span class={`vital-value ${cls}`}>{value}</span></div>;
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
    <section class="card">
      <h2>Wallpaper engine</h2>
      <dl class="kv">
        <dt>Playing</dt><dd>{st ? `${st.width}×${st.height} · ${st.fps} fps${st.paused ? ' · paused' : ''}` : '—'}</dd>
        <dt>Loop</dt><dd>{st ? `${st.loops} loops · ${st.hitches} hitches · seam ${st.lastSeamMs} ms` : '—'}</dd>
        <dt>Dropped</dt><dd>{st ? `${st.dropped} / ${st.totalDecoded}` : '—'}</dd>
        <dt>Swaps</dt><dd>{sum ? `${sum.n} · median ${sum.med} ms · max ${sum.max} ms` : 'none yet'}{swapFails.value ? ` · ${swapFails.value} failed` : ''}</dd>
        <dt>RAM</dt><dd>{blobMB.value ? `${blobMB.value} MB clip held here` : 'no clip held here'}{vitals.value.heapMB != null ? ` · JS ${vitals.value.heapMB} MB` : ''}</dd>
        <dt>Disk</dt><dd>{diskReads.value} video read(s){lastReadMs.value ? ` · last ${lastReadMs.value} ms` : ''}</dd>
      </dl>
      {DEBUG && ROLE === 'A' && mode.value === 'dual' && (
        <p><button onClick={runAuto} disabled={auto === 'running…'}>Auto-swap ×50</button> <span class="small">{auto}</span></p>
      )}
    </section>
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
