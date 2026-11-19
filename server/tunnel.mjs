// "Share over the internet": a Cloudflare quick tunnel (no account) for when phones can't reach the laptop on Wi-Fi
// (port forwarding off, or hostel client isolation). OFF by default; an owner turns it on from the dashboard.
// Phones then use https://<random>.trycloudflare.com/join from any network. The access rules still apply:
// strangers only see the join page until an owner approves them (see index.mjs, viaTunnel).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTunnel({ port, kvGet, kvSet, log = () => {}, onChange = () => {} }) {
  let proc = null;
  let state = { status: 'off', url: null, error: null, since: null };
  let restartTimer = null;

  const bin = () => {
    if (process.env.JHK_CLOUDFLARED) return fs.existsSync(process.env.JHK_CLOUDFLARED) ? process.env.JHK_CLOUDFLARED : null;
    // ~/.local/bin first: that's where `npm run tunnel:install` puts it (systemd's PATH doesn't include it).
    const local = path.join(os.homedir(), '.local', 'bin', 'cloudflared');
    if (fs.existsSync(local)) return local;
    try { return execFileSync('which', ['cloudflared'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
  };
  const set = (patch) => { state = { ...state, ...patch }; onChange(state); };
  const status = () => ({ ...state, available: !!bin(), wanted: !!kvGet('tunnelWanted') });

  function start() {
    const b = bin();
    if (!b) { set({ status: 'unavailable', error: 'cloudflared is not installed (npm run tunnel:install)' }); return; }
    if (proc) return;
    set({ status: 'starting', url: null, error: null, since: Date.now() });
    // --no-autoupdate: never replace itself; --url: only this one local service is exposed.
    proc = spawn(b, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const scan = (buf) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(buf));
      if (m && state.url !== m[0]) { set({ status: 'on', url: m[0], error: null }); log(`tunnel on: ${m[0]}`); }
    };
    proc.on('error', (e) => { proc = null; set({ status: 'unavailable', url: null, error: `cannot start cloudflared: ${e.message}` }); });
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('exit', (code) => {
      proc = null;
      const wanted = !!kvGet('tunnelWanted');
      set({ status: wanted ? 'starting' : 'off', url: null, error: wanted ? `tunnel stopped (code ${code}), retrying` : null });
      if (wanted) { clearTimeout(restartTimer); restartTimer = setTimeout(start, 5000); }
    });
  }

  function stop() {
    clearTimeout(restartTimer);
    if (proc) { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
    proc = null;
    set({ status: 'off', url: null, error: null, since: null });
  }

  function setWanted(on) {
    kvSet('tunnelWanted', !!on);
    if (on) start(); else stop();
    return status();
  }

  if (kvGet('tunnelWanted')) start();
  return { status, setWanted, stop, url: () => (state.status === 'on' ? state.url : null), host: () => (state.url ? new URL(state.url).host : null) };
}
