// Week 3 UI: Vitals Ring, server panel (vitals + live QR), "Server offline" badge.
import { useState } from 'preact/hooks';
import { mode, peer } from '../state';
import { me, qrSrc, server, serverOffline, setLanHost } from '../serverLink';
import { vitals } from './vitals';
import { arcPath, fmtUptime, ringSegments } from './ring';

const GAP = 6;   // degrees between arcs

export function VitalsRing({ mini = false }: { mini?: boolean }) {
  const segs = ringSegments(vitals.value, server.value, serverOffline.value);
  const p = peer.value;
  const worst = segs.find((s) => s.level === 'bad') || segs.find((s) => s.level === 'amber');
  return (
    <section class={`ring-card ${mini ? 'mini' : ''}`} aria-label="Vitals">
      <svg class="ring" viewBox="0 0 120 120" role="img" aria-label={segs.map((s) => `${s.label} ${s.value}`).join(', ')}>
        {segs.map((s, i) => (
          <path key={s.key} class={`arc lv-${s.level}`} d={arcPath(60, 60, 48, i * 90 + GAP / 2, (i + 1) * 90 - GAP / 2)} />
        ))}
        <text x="60" y="56" class="ring-mid">{worst ? (worst.level === 'bad' ? '!' : '•') : '✓'}</text>
        <text x="60" y="74" class="ring-sub">{worst ? worst.label : 'all good'}</text>
      </svg>
      <ul class="ring-legend">
        {segs.map((s) => (
          <li key={s.key} class={`lv-${s.level}`}>
            <span class="dot" />
            <span class="ring-label">{s.label}</span>
            <span class="ring-value">{s.value}</span>
            <span class="ring-reason">{s.reason}</span>
          </li>
        ))}
        <li class={mode.value === 'dual' && !p.alive ? 'lv-bad' : 'lv-na'}>
          <span class="dot" />
          <span class="ring-label">Screens</span>
          <span class="ring-value">{mode.value === 'dual' ? (p.alive ? `linked · ${p.rtt ?? '–'} ms` : 'no link') : 'single'}</span>
          <span class="ring-reason">Temp / fan: n/a (ChromeOS hides them)</span>
        </li>
      </ul>
    </section>
  );
}

const mb = (b: number) => (b < 2 ** 20 ? `${Math.round(b / 1024)} KB` : `${(b / 2 ** 20).toFixed(1)} MB`);

export function ServerPanel() {
  const { v, join, online, rtt } = server.value;
  const [edit, setEdit] = useState(false);
  const [ip, setIp] = useState('');
  const [err, setErr] = useState('');
  const local = !!me.value?.owner;
  const save = async (e: Event) => {
    e.preventDefault();
    try { await setLanHost(ip); setEdit(false); setErr(''); } catch (x: any) { setErr(x.message); }
  };
  return (
    <section class="card server-card">
      <div class="card-head">
        <h2>Server</h2>
        <span class={`small ${serverOffline.value ? 'warn' : online ? 'good' : 'amber'}`}>{serverOffline.value ? '● offline' : online ? '● live' : '● connecting'}</span>
      </div>
      <div class="server-grid">
        <dl class="kv">
          <dt>Uptime</dt><dd>{v ? fmtUptime(v.uptimeS) : '—'}</dd>
          <dt>Traffic</dt><dd>{v ? `${v.reqPerS} req/s · ${v.requests} total` : '—'}</dd>
          <dt>Devices</dt><dd>{v ? `${v.activeClients60s} active (60 s) · ${v.wsClients} live link${v.wsClients === 1 ? '' : 's'}` : '—'}</dd>
          <dt>Database</dt><dd>{v ? `${mb(v.dbBytes)} · ${v.sqlite.journal_mode ?? 'error'}${v.lastCheckpoint ? ' · checkpointed' : ''}` : '—'}</dd>
          <dt>Disk</dt><dd>{v?.disk ? `${v.disk.freeGB} GB free of ${v.disk.totalGB} GB` : '—'}</dd>
          <dt>Memory</dt><dd>{v ? `Linux ${v.mem.availMB} MB free · server ${v.rssMB} MB` : '—'}</dd>
          <dt>Errors</dt><dd class={v && v.errors ? 'warn' : ''}>{v ? v.errors : '—'}</dd>
          <dt>Link</dt><dd>{rtt != null ? `${rtt} ms` : '—'}</dd>
        </dl>
        {join && (
          <div class="qr-box">
            <img class="qr" src={qrSrc(join.url)} alt={`QR code for ${join.url}`} width={170} height={170} />
            <div class="qr-url">{join.host}</div>
            <div class="small muted">Or type on the phone: <b>{join.url.replace(/^http:\/\//, '')}</b></div>
            {join.source === 'crostini' && <div class="small amber">Container address: phones can't use it. Set the laptop's Wi-Fi IP ↓</div>}
            {join.source === 'seen' && <div class="small muted">Learned from a phone that connected</div>}
            {local && !edit && <button class="small-btn" onClick={() => { setEdit(true); setIp(join.source === 'manual' ? join.host : ''); }}>Set Wi-Fi IP</button>}
            {edit && (
              <form class="ip-form" onSubmit={save}>
                <input value={ip} placeholder="192.168.1.23" aria-label="Laptop Wi-Fi IP" onInput={(e) => setIp((e.target as HTMLInputElement).value)} />
                <button type="submit">Save</button>
              </form>
            )}
            {err && <div class="small warn">{err}</div>}
          </div>
        )}
      </div>
      <p class="small muted">Wi-Fi IP: Settings → Network → Wi-Fi → your network. Port forwarding: Settings → Linux → Port forwarding → 8080.</p>
    </section>
  );
}

export function OfflineBadge() {
  if (!serverOffline.value) return null;
  return <div class="offline-badge" role="alert">● Server offline</div>;
}
