// Layer 2 wallpaper switcher, the "stacked layers" banner, and Week 8 hardening (thermal guard, snapshots, logs).
import { currentId, layer, library, mode, rotateMin, stackInfo, stackOverlay, stacked, thermalHold } from '../state';
import { selectWallpaper, setRotate, setStacked, stepWallpaper, unstack } from '../host';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------- wallpaper switcher (Layer 2)
/** Change the wallpaper without leaving Layer 2: posters, ◀ ▶, and an optional rotation timer.
 *  Works on either screen (the monitor asks the laptop window, which owns the library). */
export function WallpaperSwitcher({ wall = false }: { wall?: boolean }) {
  const list = library.value;
  const cur = currentId.value;
  if (!list.length) return wall ? null : <p class="muted small">No wallpapers yet: import one in the Wallpapers tab.</p>;
  return (
    <div class={`wp-switch ${wall ? 'wall' : ''}`} role="group" aria-label="Change wallpaper">
      <button class="wp-arrow" onClick={() => stepWallpaper(-1)} aria-label="Previous wallpaper ([)" title="Previous wallpaper ([)"><Icon name="prev" size={wall ? 22 : 18} /></button>
      <ul class="wp-strip">
        {list.map((w) => (
          <li key={w.id}>
            <button class={`wp-thumb ${w.id === cur ? 'on' : ''}`} aria-pressed={w.id === cur} aria-label={`Wallpaper: ${w.name}`} title={w.name}
              onClick={() => selectWallpaper(w.id)}>
              {w.thumb ? <img src={w.thumb} alt="" width={wall ? 128 : 96} height={wall ? 72 : 54} /> : <span class="wp-ph"><Icon name="image" size={20} /></span>}
              {!wall && <span class="wp-tn">{w.name.replace(/\.(mp4|webm)$/i, '')}</span>}
            </button>
          </li>
        ))}
      </ul>
      <button class="wp-arrow" onClick={() => stepWallpaper(1)} aria-label="Next wallpaper (])" title="Next wallpaper (])"><Icon name="next" size={wall ? 22 : 18} /></button>
    </div>
  );
}

export function RotateSelect() {
  return (
    <label class="rotate-sel small">
      <Icon name="shuffle" size={14} />
      <select value={rotateMin.value} aria-label="Change wallpaper automatically" onChange={(e) => setRotate(+(e.target as HTMLSelectElement).value)}>
        <option value={0}>Keep this one</option><option value={5}>Next every 5 min</option><option value={15}>Next every 15 min</option>
        <option value={30}>Next every 30 min</option><option value={60}>Next every hour</option><option value={120}>Next every 2 h</option>
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------- stacked layers
/** On the dashboard-only screen: why we stacked, and the way back. On the stacked screen: a small chip. */
export function StackBanner() {
  if (!stacked.value || mode.value !== 'dual') return null;
  const info = stackInfo.value;
  if (layer.value === 'L1') {
    return (
      <div class="stack-chip" role="status">
        <Icon name="layers" size={14} /> Stacked: dashboard over the wallpaper
        <button class="small-btn" onClick={() => setStacked(true, '', null, !stackOverlay.value)}>{stackOverlay.value ? 'Hide' : 'Show'} (S)</button>
        <button class="small-btn" onClick={unstack}>Back to swapping</button>
      </div>
    );
  }
  return (
    <div class="banner stack-banner" role="status">
      <Icon name="layers" size={18} />
      <span><b>Both layers are on the other screen.</b> {info?.reason ? `Swaps got slow (${info.reason}), so the wallpaper stays put and the dashboard is drawn over it.` : 'The wallpaper stays put and the dashboard is drawn over it.'} Swap now shows or hides it.</span>
      <button onClick={() => setStacked(true, '', null, !stackOverlay.value)}>{stackOverlay.value ? 'Hide there' : 'Show there'}</button>
      <button class="primary" onClick={unstack}>Back to swapping</button>
    </div>
  );
}

export function ThermalBadge() {
  if (!thermalHold.value) return null;
  return <div class="thermal-badge" role="status"><Icon name="thermo" size={14} /> Wallpaper paused: the laptop is working hard</div>;
}

