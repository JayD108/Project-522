import { currentId, library } from '../state';
import { deleteWallpaper, importWallpapers, loadSamples, selectWallpaper } from '../host';
import { codecVerdict } from '../engine/sniff';

const mb = (b: number) => `${(b / 2 ** 20).toFixed(0)} MB`;

export function Library() {
  const list = library.value;
  return (
    <section class="card library">
      <div class="card-head">
        <h2>Wallpapers</h2>
        <label class="btn">
          + Import
          <input type="file" accept="video/mp4,video/webm" multiple hidden
            onChange={(e) => { const f = (e.target as HTMLInputElement).files; if (f) importWallpapers(Array.from(f)); (e.target as HTMLInputElement).value = ''; }} />
        </label>
      </div>
      {list.length === 0 && (
        <p class="muted">
          No wallpapers yet. Import an H.264 or VP9 clip (encode with <code>tools/encode.sh</code>), or{' '}
          <button onClick={loadSamples}>Load sample wallpapers</button>
        </p>
      )}
      <ul class="wp-list">
        {list.map((w) => {
          const v = codecVerdict(w.codec);
          return (
            <li key={w.id} class={w.id === currentId.value ? 'on' : ''}>
              <button class="wp-pick" onClick={() => selectWallpaper(w.id)} title={w.warn || ''}>
                <span class="wp-name">{w.name}</span>
                <span class="wp-meta">
                  {w.width}×{w.height} · {w.duration.toFixed(0)} s · {mb(w.bytes)} ·{' '}
                  <span class={v === 'ok' ? 'good' : 'warn'}>{w.codec}</span>
                  {w.warn && <span class="warn"> · ⚠</span>}
                </span>
              </button>
              <button class="icon" aria-label={`Delete ${w.name}`} onClick={() => { if (confirm(`Delete ${w.name}?`)) deleteWallpaper(w.id); }}>✕</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
