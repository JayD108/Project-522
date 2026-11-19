// Week 5 room UI, shared by the dashboard (Layer 2) and the phone page (room.html).
import { useEffect, useState } from 'preact/hooks';
import {
  NOTE_COLORS, DOOR_OPTIONS, addNote, ago, boardReady, boardWritable, clearDone, deleteDrop, door, dropUrl, drops, fmtBytes,
  notes, removeNote, setDoor, toggleDone, uploadDrop, castDrop, type Drop, type Note,
} from '../room/roomClient';
import { Modal } from './Modal';
import { accessState, me, qrSrc, server, setLanHost, setTunnel } from '../serverLink';
import { Icon } from './Icon';
import { WhoCanConnect } from './Week4';

const run = (p: Promise<unknown>, onErr?: (m: string) => void) => p.catch((e) => onErr?.(String(e.message || e)));

// ---------------------------------------------------------------- board
export function BoardEditor({ by, compact = false }: { by: string; compact?: boolean }) {
  const [text, setText] = useState('');
  const [color, setColor] = useState<string>('amber');
  const list = notes.value;
  const canWrite = boardWritable.value;
  const submit = (e: Event) => { e.preventDefault(); addNote(text, color, by); setText(''); };
  const anyDone = list.some((n) => n.done);
  return (
    <div class="board">
      {canWrite ? (
        <form class="note-form" onSubmit={submit}>
          <input value={text} maxLength={280} placeholder="Add a note for the room…" aria-label="New note"
            onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          <div class="swatches" role="radiogroup" aria-label="Note colour">
            {NOTE_COLORS.map((c) => (
              <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c}
                class={`swatch n-${c} ${color === c ? 'on' : ''}`} onClick={() => setColor(c)} />
            ))}
          </div>
          <button type="submit" class="primary" disabled={!text.trim()}><Icon name="plus" /> Add</button>
        </form>
      ) : (
        <p class="small amber">Read-only right now (viewer, or quiet hours).</p>
      )}
      {!boardReady.value && <p class="muted small">Loading the board…</p>}
      {boardReady.value && list.length === 0 && <p class="muted small empty">Nothing on the board yet. Notes show up on every screen and phone at once.</p>}
      <ul class={`notes ${compact ? 'compact' : ''}`}>
        {list.map((n) => <NoteItem key={n.id} n={n} canWrite={canWrite} />)}
      </ul>
      {anyDone && canWrite && <button class="link-btn" onClick={clearDone}>Clear done</button>}
    </div>
  );
}

function NoteItem({ n, canWrite }: { n: Note; canWrite: boolean }) {
  return (
    <li class={`note n-${n.color} ${n.done ? 'done' : ''}`}>
      {canWrite && (
        <button class="note-check" aria-label={n.done ? 'Mark not done' : 'Mark done'} aria-pressed={n.done} onClick={() => toggleDone(n.id)}>
          {n.done && <Icon name="check" size={14} />}
        </button>
      )}
      <div class="note-body">
        <div class="note-text">{n.text}</div>
        <div class="note-meta">{n.by} · {ago(n.at)}</div>
      </div>
      {canWrite && <button class="icon-btn" aria-label="Delete note" onClick={() => removeNote(n.id)}><Icon name="x" size={16} /></button>}
    </li>
  );
}

/** The wall version: sticky notes, big type, no controls. */
export function BoardWall({ max = 12 }: { max?: number }) {
  const list = notes.value.filter((n) => !n.done).slice(0, max);
  if (!list.length) return <div class="wall-empty">The room board is empty. Add a note from the laptop or a phone.</div>;
  return (
    <ul class="sticky-grid">
      {list.map((n, i) => (
        <li key={n.id} class={`sticky n-${n.color}`} style={{ '--tilt': `${((i * 37) % 5) - 2}deg` }}>
          <div class="sticky-text">{n.text}</div>
          <div class="sticky-by">{n.by}</div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- door sign
const DOOR_TONE: Record<string, string> = { 'Come in': 'good', 'Knock first': 'amber', Busy: 'bad', Studying: 'amber', Sleeping: 'night', Away: 'muted' };
export const doorTone = (s?: string) => DOOR_TONE[s || ''] || 'muted';

export function DoorBadge({ big = false }: { big?: boolean }) {
  const d = door.value;
  if (!d) return null;
  return (
    <div class={`door-badge tone-${doorTone(d.status)} ${big ? 'big' : ''}`}>
      <Icon name="door" size={big ? 44 : 18} />
      <div>
        <div class="door-status">{d.status}</div>
        {d.note && <div class="door-note">{d.note}</div>}
      </div>
    </div>
  );
}

export function DoorPicker() {
  const d = door.value;
  const [note, setNote] = useState(d?.note || '');
  const [err, setErr] = useState('');
  useEffect(() => { setNote(d?.note || ''); }, [d?.at]);
  if (!me.value?.owner) return <DoorBadge />;
  return (
    <div class="door-picker">
      <div class="chips" role="radiogroup" aria-label="Door sign">
        {DOOR_OPTIONS.map((o) => (
          <button key={o} role="radio" aria-checked={d?.status === o} class={`chip tone-${doorTone(o)} ${d?.status === o ? 'on' : ''}`}
            onClick={() => run(setDoor(o, note), setErr)}>{o}</button>
        ))}
      </div>
      <form class="row" onSubmit={(e) => { e.preventDefault(); run(setDoor(d?.status || 'Come in', note), setErr); }}>
        <input value={note} maxLength={80} placeholder="Optional note, e.g. back at 6" aria-label="Door note" onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        <button type="submit">Set</button>
      </form>
      {err && <p class="small warn">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- drop zone
export function DropZone({ canWrite = true, you }: { canWrite?: boolean; you?: string | null }) {
  const [prog, setProg] = useState<{ name: string; f: number } | null>(null);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const owner = !!me.value?.owner;
  const send = async (files: FileList | File[]) => {
    setErr('');
    for (const f of Array.from(files)) {
      setProg({ name: f.name, f: 0 });
      try { await uploadDrop(f, (x) => setProg({ name: f.name, f: x })); }
      catch (e: any) { setErr(`${f.name}: ${e.message}`); }
    }
    setProg(null);
  };
  const list = drops.value;
  const [view, setView] = useState<Drop | null>(null);
  return (
    <div class={`drops ${over ? 'over' : ''}`}
      onDragOver={(e) => { if (canWrite) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (canWrite && e.dataTransfer?.files.length) send(e.dataTransfer.files); }}>
      {canWrite && (
        <label class="drop-target">
          <Icon name="upload" size={22} />
          <span>{prog ? `Uploading ${prog.name}… ${Math.round(prog.f * 100)}%` : 'Drop files here or tap to choose'}</span>
          <input type="file" multiple hidden onChange={(e) => { const fs = (e.target as HTMLInputElement).files; if (fs) send(fs); (e.target as HTMLInputElement).value = ''; }} />
          {prog && <span class="bar"><span style={{ width: `${prog.f * 100}%` }} /></span>}
        </label>
      )}
      {err && <p class="small warn">{err}</p>}
      {list.length === 0 ? <p class="muted small empty">No files. Anything dropped here is kept for 7 days.</p> : (
        <ul class="drop-list">
          {list.map((d) => (
            <li key={d.id}>
              <span class={`ftype ft-${fileKind(d)}`}>{FT_LABEL[fileKind(d)]}</span>
              <div class="drop-main">
                <button class="drop-name" onClick={() => setView(d)} title="Open">{d.name}</button>
                <div class="drop-meta">{fmtBytes(d.bytes)} · {d.byName} · {ago(d.at)} · {Math.max(0, Math.ceil((d.expiresAt - Date.now()) / 86400000))} d left</div>
              </div>
              {owner && (fileKind(d) === 'image' || fileKind(d) === 'video') && (
                <button class="small-btn" onClick={() => run(castDrop(d.id), setErr)} title="Show it on the wall"><Icon name="cinema" size={14} /> Wall</button>
              )}
              <a class="icon-btn" href={dropUrl(d.id)} download={d.name} aria-label={`Download ${d.name}`}><Icon name="download" size={16} /></a>
              {(owner || d.byDev === you) && (
                <button class="icon-btn" aria-label={`Delete ${d.name}`} onClick={() => run(deleteDrop(d.id), setErr)}><Icon name="trash" size={16} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {view && <FileViewer d={view} onClose={() => setView(null)} />}
    </div>
  );
}

type FK = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';
const FT_LABEL: Record<FK, string> = { image: 'IMG', video: 'VID', audio: 'AUD', pdf: 'PDF', text: 'TXT', other: 'FILE' };
export function fileKind(d: Pick<Drop, 'mime' | 'name'>): FK {
  const m = d.mime || '', n = d.name.toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(m) || /\.(png|jpe?g|gif|webp|avif)$/.test(n)) return 'image';
  if (/^video\//.test(m) || /\.(mp4|webm|mov)$/.test(n)) return 'video';
  if (/^audio\//.test(m) || /\.(mp3|m4a|ogg|wav|opus)$/.test(n)) return 'audio';
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (m === 'text/plain' || /\.(txt|md|csv|log)$/.test(n)) return 'text';
  return 'other';
}

/** Open a dropped file right here: picture, video, audio, PDF or text. Anything else: download. */
export function FileViewer({ d, onClose }: { d: Drop; onClose: () => void }) {
  const k = fileKind(d);
  const src = dropUrl(d.id, true);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (k !== 'text') return;
    fetch(src).then((r) => r.text()).then((t) => setText(t.length > 200_000 ? t.slice(0, 200_000) + '\n…' : t)).catch(() => setText('(could not load)'));
  }, [d.id]);
  return (
    <Modal label={d.name} onClose={onClose} wide>
      <div class="viewer">
        <div class="viewer-head"><b>{d.name}</b><span class="small muted">{fmtBytes(d.bytes)} · {d.byName} · {ago(d.at)}</span></div>
        <div class={`viewer-body vk-${k}`}>
          {k === 'image' && <img src={src} alt={d.name} />}
          {k === 'video' && <video src={src} controls autoPlay playsInline />}
          {k === 'audio' && <audio src={src} controls autoPlay />}
          {k === 'pdf' && <iframe src={src} title={d.name} />}
          {k === 'text' && <pre>{text ?? 'Loading…'}</pre>}
          {k === 'other' && <p class="muted">This kind of file can't be previewed here.</p>}
        </div>
        <div class="row"><a class="btn" href={dropUrl(d.id)} download={d.name}><Icon name="download" size={16} /> Download</a></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- people + connect a phone
export function People() {
  const a = accessState.value;
  const ppl = (a?.devices || []).filter((d) => d.status === 'approved');
  const recent = ppl.filter((d) => d.lastSeen && Date.now() - d.lastSeen < 10 * 60000);
  return (
    <div class="people">
      <div class="people-count"><b>{ppl.length}</b> member{ppl.length === 1 ? '' : 's'}{recent.length ? <> · <span class="good">{recent.length} online</span></> : null}</div>
      <ul class="avatars">
        {ppl.slice(0, 8).map((d) => (
          <li key={d.id} class={d.lastSeen && Date.now() - d.lastSeen < 10 * 60000 ? 'on' : ''} title={`${d.name} · ${d.role}`}>
            <span class="av">{d.name.slice(0, 1).toUpperCase()}</span><span class="av-name">{d.name}</span>
          </li>
        ))}
      </ul>
      {!!a?.pending && <div class="small amber">{a.pending} waiting for approval</div>}
    </div>
  );
}

/** Live checklist for "the QR does nothing": what we know and what to try next. */
export function ConnectPhone({ onClose }: { onClose?: () => void }) {
  const j = server.value.join;
  const reach = j?.reach?.lastOutside;
  const [ip, setIp] = useState('');
  const [err, setErr] = useState('');
  const owner = !!me.value?.owner;
  const ipOk = j && (j.source === 'manual' || j.source === 'seen');
  const reached = !!reach && Date.now() - reach.at < 7 * 86400000;
  const viaInternet = j?.source === 'tunnel';
  return (
    <div class={`connect ${viaInternet ? 'internet' : ''}`}>
      <div class="connect-qr">
        {j ? <img class="qr big" src={qrSrc(j.url)} alt={`QR code for ${j.url}`} width={300} height={300} /> : <div class="qr big ph" />}
        <div class="connect-url">{j ? j.url.replace(/^http:\/\//, '') : '…'}</div>
        <div class="small muted">Scan with the phone camera, or type this in the phone's browser.</div>
      </div>
      <div class="connect-right">
      <InternetShare />
      <WhoCanConnect />
      {viaInternet && reach?.via === 'internet' && <p class="small good">✓ A phone came in over the internet {ago(reach.at)}.</p>}
      <details class="wifi-steps" open={!viaInternet}>
      <summary>{viaInternet ? 'Wi-Fi route (not needed while sharing over the internet)' : 'Join over the Wi-Fi'}</summary>
      <ol class="steps">
        <li class={ipOk ? 'ok' : 'todo'}>
          <b>Laptop's Wi-Fi address</b>
          {ipOk ? <span> · {j!.host}</span> : <span> · not set (Linux can't see it)</span>}
          <div class="small muted">ChromeOS Settings → Network → Wi-Fi → your network → IP address.</div>
          {owner && (
            <form class="row" onSubmit={(e) => { e.preventDefault(); run(setLanHost(ip).then(() => setIp('')), setErr); }}>
              <input value={ip} placeholder={j?.host?.split(':')[0] || '192.168.1.23'} aria-label="Laptop Wi-Fi IP" onInput={(e) => setIp((e.target as HTMLInputElement).value)} />
              <button type="submit">Save</button>
            </form>
          )}
          {err && <div class="small warn">{err}</div>}
        </li>
        <li class={reached ? 'ok' : 'todo'}>
          <b>Port forwarding 8080</b>
          <div class="small muted">Settings → About ChromeOS → Linux development environment → Port forwarding → Add → 8080, TCP → turn it on.</div>
        </li>
        <li class={reached ? 'ok' : 'todo'}>
          <b>Same Wi-Fi on the phone</b>
          <div class="small muted">Not mobile data, not a guest network.</div>
        </li>
        <li class={reached ? 'ok' : 'wait'}>
          <b>A phone reached this laptop</b>
          {reached
            ? <span class="good"> · yes, {ago(reach!.at)} from {reach!.ip}</span>
            : <span class="amber"> · not yet: no phone has ever got through</span>}
          {!reached && (
            <div class="small muted">
              Steps 1–3 done and still nothing? The Wi-Fi blocks phone-to-laptop traffic (common in hostels).
              Fix: turn on a <b>phone hotspot</b>, connect the laptop to it, then set the new Wi-Fi address above. Friends join the hotspot while in the room.
            </div>
          )}
        </li>
      </ol>
      </details>
      </div>
      {onClose && <button class="close-x icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>}
    </div>
  );
}

/** Plan B when the Wi-Fi blocks phones: a Cloudflare quick tunnel, switched on by an owner. */
export function InternetShare() {
  const t = server.value.join?.tunnel;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  if (!me.value?.owner || !t) return null;
  const toggle = async (on: boolean) => {
    setBusy(true); setErr('');
    try { await setTunnel(on); } catch (e: any) { setErr(e.message); }
    setBusy(false); setConfirm(false);
  };
  return (
    <section class={`share-net ${t.status}`}>
      <div class="share-head">
        <Icon name="wifi" size={18} />
        <b>Share over the internet</b>
        <span class={`pill ${t.status === 'on' ? 'good' : t.status === 'starting' ? 'amber' : 'muted'}`}>
          {t.status === 'on' ? 'on' : t.status === 'starting' ? 'starting…' : t.status === 'unavailable' || !t.available ? 'not installed' : 'off'}
        </span>
      </div>
      {!t.available ? (
        <p class="small muted">For when the Wi-Fi won't let phones in. One-time setup: in the Linux terminal run <code>npm run tunnel:install</code>, then come back here.</p>
      ) : t.status === 'on' ? (
        <>
          <p class="small">Phones on <b>any</b> network (Wi-Fi or mobile data) can open the QR. Strangers only see the join page until you approve them.</p>
          <div class="share-url">{t.url}/join</div>
          <button onClick={() => toggle(false)} disabled={busy}>Stop sharing</button>
        </>
      ) : t.status === 'starting' ? (
        <p class="small muted">Connecting to Cloudflare… {t.error || ''}</p>
      ) : confirm ? (
        <div class="share-confirm">
          <p class="small">This gives the room a public <code>https://…trycloudflare.com</code> address. Anyone with the link can ask to join; only people you approve get in. The kill switch still works. Turn it off when you don't need it.</p>
          <div class="row"><button class="primary" onClick={() => toggle(true)} disabled={busy}>Yes, share it</button><button onClick={() => setConfirm(false)}>Cancel</button></div>
        </div>
      ) : (
        <>
          <p class="small muted">Wi-Fi not working? Phones can join through a free Cloudflare link instead, even on mobile data.</p>
          <button onClick={() => setConfirm(true)}>Share over the internet…</button>
        </>
      )}
      {err && <p class="small warn">{err}</p>}
    </section>
  );
}
