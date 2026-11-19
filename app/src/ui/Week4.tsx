// Week 4 UI: approval tray (pops up on Layer 2), Access card (devices, kill switch, quiet hours, audit), Pair notice.
import { useState } from 'preact/hooks';
import { accessState, decide, me, server, setKill, setNetGuard, setQuiet, type Device } from '../serverLink';
import { toast } from '../state';
import { castDecide, fun } from '../room/roomClient';

const ago = (t: number | null) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const run = (p: Promise<unknown>) => p.catch((e) => toast(String(e.message || e), 6000));

/** Shown on every Layer 2 when someone scanned the QR and is waiting. */
export function ApprovalTray() {
  const a = accessState.value;
  const pending = a?.devices.filter((d) => d.status === 'pending') ?? [];
  const casts = me.value?.owner ? fun.value?.casts ?? [] : [];
  if (!pending.length && !casts.length) return null;
  return (
    <div class="tray" role="alertdialog" aria-label="Join requests">
      {pending.map((d) => (
        <div class="tray-row" key={d.id}>
          <div class="tray-who"><b>{d.name}</b> wants to join <span class="muted small">· {d.ua || 'phone'} · {ago(d.createdAt)}</span></div>
          <div class="tray-btns">
            <button class="primary" onClick={() => run(decide(d.id, 'approve', 'collaborator'))}>✓ Collaborator</button>
            <button onClick={() => run(decide(d.id, 'approve', 'viewer'))}>Viewer</button>
            <button onClick={() => run(decide(d.id, 'approve', 'owner'))}>Owner</button>
            <button class="deny" onClick={() => run(decide(d.id, 'deny'))} aria-label={`Deny ${d.name}`}>✕</button>
          </div>
        </div>
      ))}
      {casts.map((c) => (
        <div class="tray-row" key={c.id}>
          <div class="tray-who"><b>{c.by}</b> wants to put <b>{c.title}</b> on the wall <span class="muted small">· {c.site}</span></div>
          <div class="tray-btns">
            <button class="primary" onClick={() => run(castDecide(c.id, true))}>Show on wall</button>
            <button class="deny" onClick={() => run(castDecide(c.id, false))} aria-label="Deny">✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** On Layer 1 (wallpaper) a small pill so a request isn't missed while the dashboard is hidden. */
export function RequestPill() {
  const n = (accessState.value?.pending ?? 0) + (me.value?.owner ? fun.value?.casts.length ?? 0 : 0);
  if (!n) return null;
  return <div class="req-pill">{n} request{n > 1 ? 's' : ''} waiting · press S</div>;
}

export function PairCard() {
  const m = me.value;
  if (!m || m.owner) return null;
  return (
    <section class="card pair-card">
      <h2>Pair this screen</h2>
      <p>This screen isn't an owner yet, so server vitals, join requests and the kill switch are hidden.</p>
      <p>In the <b>Linux terminal</b> run <code>npm run pair</code> (in the jharokha folder). It reopens this page already paired.</p>
    </section>
  );
}

function roleLabel(d: Device) {
  return d.status === 'pending' ? 'waiting' : d.role ?? '';
}

export function AccessCard() {
  const a = accessState.value;
  const [showAll, setShowAll] = useState(false);
  if (!a || !me.value?.owner) return null;
  const approved = a.devices.filter((d) => d.status === 'approved');
  const audit = showAll ? a.audit : a.audit.slice(0, 6);
  return (
    <section class="card access-card">
      <div class="card-head">
        <h2>Access</h2>
        <span class="small muted">{approved.length + a.pending} / {a.max} devices</span>
      </div>
      <h3 class="sub-h">Who can connect</h3>
      <WhoCanConnect />
      <h3 class="sub-h">Safety</h3>
      <div class="kill-row">
        <button class={`kill ${a.kill ? 'on' : ''}`} aria-pressed={a.kill}
          onClick={() => run(setKill(!a.kill))}>{a.kill ? 'Owner-only mode ON: tap to reopen' : 'Kill switch'}</button>
        <span class="small muted">{a.kill ? 'Guests are blocked and disconnected.' : 'Kicks everyone except owners.'}</span>
      </div>
      <div class="quiet-row">
        <label class="switch">
          <input type="checkbox" checked={a.quiet.enabled} onChange={(e) => run(setQuiet({ enabled: (e.target as HTMLInputElement).checked }))} />
          Quiet hours
        </label>
        <input type="time" value={a.quiet.start} aria-label="Quiet hours start" onChange={(e) => run(setQuiet({ start: (e.target as HTMLInputElement).value }))} />
        <span class="muted">to</span>
        <input type="time" value={a.quiet.end} aria-label="Quiet hours end" onChange={(e) => run(setQuiet({ end: (e.target as HTMLInputElement).value }))} />
        {a.quiet.now && <span class="small amber">now: friends are read-only</span>}
      </div>
      <table class="dev-table">
        <tbody>
          {approved.length === 0 && <tr><td class="muted small">No one has joined yet. They scan the QR in the Server card.</td></tr>}
          {approved.map((d) => (
            <tr key={d.id}>
              <th>{d.name}</th>
              <td>
                {d.id === me.value?.id ? <span class={`role-tag r-${d.role}`}>{roleLabel(d)}</span> : (
                  <select class="role-sel" value={d.role ?? ''} aria-label={`Role for ${d.name}`} onChange={(e) => run(decide(d.id, 'role', (e.target as HTMLSelectElement).value))}>
                    <option value="owner">Owner</option><option value="collaborator">Collaborator</option><option value="viewer">Viewer</option>
                  </select>
                )}
              </td>
              <td class="small muted">{d.ua} · seen {ago(d.lastSeen)}</td>
              <td>{d.id === me.value?.id
                ? <span class="small muted">this screen</span>
                : <button class="small-btn" onClick={() => run(decide(d.id, 'revoke'))} aria-label={`Remove ${d.name}`}>Kick out</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 class="sub-h">Audit log</h3>
      <ul class="audit">
        {audit.map((e, i) => (
          <li key={i}><span class="muted">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> <b>{e.actor}</b> {e.action}{e.target ? ` · ${e.target}` : ''}{e.detail ? ` · ${e.detail}` : ''}</li>
        ))}
      </ul>
      {a.audit.length > 6 && <button class="small-btn" onClick={() => setShowAll(!showAll)}>{showAll ? 'Less' : `All ${a.audit.length}`}</button>}
      {!server.value.online && <p class="small amber">Not live: reconnecting…</p>}
    </section>
  );
}

/** "Same Wi-Fi only" vs "Anywhere" for the internet link, with what we know about the room's network. */
export function WhoCanConnect() {
  const n = accessState.value?.net;
  if (!n || !me.value?.owner) return null;
  const tunnelOn = server.value.join?.source === 'tunnel';
  return (
    <div class="who">
      <div class="who-opts" role="radiogroup" aria-label="Who can connect">
        <button role="radio" aria-checked={n.mode === 'wifi'} class={`who-opt ${n.mode === 'wifi' ? 'on' : ''}`} onClick={() => run(setNetGuard({ mode: 'wifi' }))}>
          <b>Same Wi-Fi only</b><span class="small muted">Phones must be on the room's Wi-Fi. Mobile data is refused.</span>
        </button>
        <button role="radio" aria-checked={n.mode === 'anywhere'} class={`who-opt ${n.mode === 'anywhere' ? 'on' : ''}`} onClick={() => run(setNetGuard({ mode: 'anywhere' }))}>
          <b>Anywhere</b><span class="small muted">People you approved can use the room from any network. New people still need the QR.</span>
        </button>
      </div>
      <p class="small muted">
        Room network: {n.room.length ? n.room.join(' · ') : 'checking…'}{n.laptop.v4 ? ` (laptop's public address ${n.laptop.v4})` : ''}.
        {' '}Joining always needs the QR on this screen (its code changes every 10 min).{!tunnelOn && ' The internet link is off right now.'}
      </p>
      {n.mode === 'wifi' && n.blocked.length > 0 && (
        <div class="blocked">
          <div class="small"><b>Refused recently</b> (not on the room's Wi-Fi):</div>
          <ul>
            {n.blocked.slice(0, 4).map((b) => (
              <li key={b.at}>
                <span class="small">{b.ip} · {b.ua.includes('Android') ? 'Android' : b.ua.includes('iPhone') ? 'iPhone' : 'device'} · {ago(b.at)}</span>
                {b.prefix && <button class="small-btn" onClick={() => run(setNetGuard({ trust: b.prefix! }))} title="e.g. the same Wi-Fi seen over IPv6, or a second building">Trust this network</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {n.trusted.length > 0 && (
        <div class="small muted">Also trusted: {n.trusted.map((t) => <span key={t} class="tag-t">{t} <button class="link-btn" onClick={() => run(setNetGuard({ untrust: t }))}>remove</button></span>)}</div>
      )}
    </div>
  );
}
