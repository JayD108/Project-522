// Minimal headless-Chrome driver over the DevTools protocol (Node's built-in WebSocket, no Puppeteer).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find a Chrome/Chromium/Edge binary. Order: $CHROME_PATH, then the usual install locations. */
export function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const win = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  for (const p of process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : []) if (fs.existsSync(p)) return p;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { const p = execFileSync('which', [name], { encoding: 'utf8' }).trim(); if (p) return p; } catch { /* not found */ }
  }
  return null;
}

export function chromeVersion(bin) {
  try {
    if (process.platform === 'win32') {
      // chrome.exe --version prints nothing on Windows; read the file version instead.
      return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${bin}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
    }
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

export class Session {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.wait = new Map();
    this.errors = [];      // uncaught page exceptions
    this.console = [];     // console.error / warn lines
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)(m); this.wait.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception?.description || d.text || 'exception').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        this.console.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 300));
      }
    };
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.wait.set(id, r));
  }
  /** Evaluate in the page with a user gesture; throws with the page's error message. */
  async ev(expr, timeoutMs = 60000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, userGesture: true, returnByValue: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ timeout: true }))]);
    if (r.timeout) throw new Error(`page evaluation timed out after ${timeoutMs} ms`);
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description || 'evaluation failed').split('\n')[0]);
    return r.result?.result?.value;
  }
  /** Poll `expr` until truthy. Returns true/false. */
  async until(expr, ms = 15000, every = 200) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (await this.ev(expr, 5000)) return true; } catch { /* page may be navigating */ }
      await sleep(every);
    }
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

/**
 * Launch headless Chrome. `screens` like '{1536x864}{2560x1440}' emulates multiple displays.
 * Returns { port, version, browser (Session), pageTargets(), attach(target), close() }.
 */
export async function launch({ bin, port, screens, origin, grant = [], secureOrigins = [], extraArgs = [] }) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'jhk-test-chrome-'));
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
  ];
  if (screens) args.push(`--screen-info=${screens}`);
  // Tests that reach the server on a LAN address need it treated like localhost (OPFS etc. need a secure context).
  if (secureOrigins.length) args.push(`--unsafely-treat-insecure-origin-as-secure=${secureOrigins.join(',')}`);
  args.push(...extraArgs);
  args.push('about:blank');
  const proc = spawn(bin, args, { stdio: 'ignore' });
  let exited = null;
  proc.on('exit', (code) => { exited = code; });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    if (exited !== null) throw new Error(`Chrome exited immediately (code ${exited})${screens ? ': maybe --screen-info is not supported by this Chrome' : ''}`);
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); }
  }
  if (!ver) { proc.kill(); throw new Error('Chrome DevTools endpoint did not come up within 15 s'); }

  const browser = new Session(ver.webSocketDebuggerUrl);
  await browser.ready;
  for (const name of grant) {
    const r = await browser.send('Browser.setPermission', { origin, permission: { name }, setting: 'granted' });
    if (r.error) throw new Error(`could not grant ${name}: ${r.error.message}`);
  }
  const pageTargets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page');
  const attach = async (target) => {
    const s = new Session(target.webSocketDebuggerUrl);
    await s.ready;
    await s.send('Runtime.enable');
    return s;
  };
  return {
    port, version: ver.Browser, browser, pageTargets, attach,
    async close() {
      browser.close();
      proc.kill();
      await sleep(500);
      try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
    },
  };
}
