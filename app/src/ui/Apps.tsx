// Quick-launch tiles for the streaming / web apps people use most. Simple drawn marks (no downloaded logos).
// Laptop: opens the site in a new tab. Phone: "On PC" asks the laptop (one tap there), or opens it on the phone.
import { useEffect, useState } from 'preact/hooks';
import { openOnPc, remoteAck } from '../room/roomClient';

export const APPS = [
  { key: 'netflix', name: 'Netflix', url: 'https://www.netflix.com/browse' },
  { key: 'prime', name: 'Prime Video', url: 'https://www.primevideo.com/' },
  { key: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
  { key: 'google', name: 'Google', url: 'https://www.google.com/' },
] as const;

export function AppMark({ k, size = 40 }: { k: string; size?: number }) {
  if (k === 'netflix') return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#000" />
      <path d="M12 7h5l6 16V7h5v26c-1.6-.2-3.3-.3-5-.3L17 17v15.4c-1.7.1-3.4.3-5 .6z" fill="#e50914" /></svg>);
  if (k === 'prime') return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#0f79af" />
      <text x="20" y="20" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="#fff">prime</text>
      <path d="M10 25c6 4 14 4 20 0" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" /><path d="M27 23.5l3.2 1.3-1.4 3" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" /></svg>);
  if (k === 'youtube') return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#fff" />
      <rect x="6" y="11" width="28" height="19" rx="6" fill="#f00" /><path d="M17 15.5v10l8.5-5z" fill="#fff" /></svg>);
  if (k === 'google') return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#fff" />
      <path d="M28.6 20.3c0-.7-.1-1.3-.2-1.9H20v3.6h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6z" fill="#4285f4" />
      <path d="M20 29c2.4 0 4.4-.8 5.9-2.1L23 24.7c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7h-3v2.3A9 9 0 0 0 20 29z" fill="#34a853" />
      <path d="M15 21.9a5.4 5.4 0 0 1 0-3.8v-2.3h-3a9 9 0 0 0 0 8.4z" fill="#fbbc05" />
      <path d="M20 14.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 12 15.8l3 2.3c.7-2.1 2.7-3.5 5-3.5z" fill="#ea4335" /></svg>);
  return null;
}

export function AppTiles({ where, launch }: { where: 'pc' | 'phone'; launch?: (url: string) => void }) {
  const [target, setTarget] = useState<'pc' | 'phone'>('pc');
  const [sent, setSent] = useState('');
  const [pending, setPending] = useState('');
  // The server answers each "open on PC": opened directly, waiting for a tap on the laptop, or no laptop screen.
  useEffect(() => {
    const a = remoteAck.value;
    if (!pending || !a || a.cmd !== 'open') return;
    setSent(a.direct ? `Opened ${pending} on the PC.` : a.delivered ? `Sent. Tap "Open" on the laptop to start ${pending}.` : 'The laptop screen isn\'t running Jharokha right now.');
    setPending('');
  }, [remoteAck.value]);
  if (where === 'pc') return (
    <div class="apps">
      {APPS.map((a) => <button key={a.key} class="app app-main" onClick={() => (launch ? launch(a.url) : window.open(a.url, '_blank'))}><AppMark k={a.key} /><span>{a.name}</span></button>)}
    </div>
  );
  return (
    <div class="apps-wrap">
      <div class="seg" role="radiogroup" aria-label="Open on">
        <span class="small muted">Open on</span>
        <button role="radio" aria-checked={target === 'pc'} class={target === 'pc' ? 'on' : ''} onClick={() => { setTarget('pc'); setSent(''); }}>PC</button>
        <button role="radio" aria-checked={target === 'phone'} class={target === 'phone' ? 'on' : ''} onClick={() => { setTarget('phone'); setSent(''); }}>This phone</button>
      </div>
      <div class="apps">
        {APPS.map((a) => target === 'phone' ? (
          <a key={a.key} class="app" href={a.url} target="_blank" rel="noopener noreferrer"><AppMark k={a.key} /><span>{a.name}</span></a>
        ) : (
          <button key={a.key} class="app app-main" onClick={() => { if (openOnPc(a.url, a.name)) { setPending(a.name); setSent(`Opening ${a.name} on the PC…`); } else setSent('Not connected right now.'); }}>
            <AppMark k={a.key} /><span>{a.name}</span>
          </button>
        ))}
      </div>
      {sent && <p class="small muted">{sent}</p>}
    </div>
  );
}
