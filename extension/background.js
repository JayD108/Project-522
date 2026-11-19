// Jharokha Remote · background (MV3 service worker).
// Keeps one WebSocket to the Jharokha server on this laptop (ws://localhost:8080/ws, trusted because it comes
// from this machine). Phones send commands through the server; we pass them to the streaming tab's content script,
// or handle them here (open / close / full screen / search). The tab reports its state back the same way.

const SITE_HOSTS = /(^|\.)(netflix\.com|primevideo\.com|youtube\.com|hotstar\.com|jiocinema\.com|sonyliv\.com|zee5\.com|disneyplus\.com)$|^www\.google\.com$|^open\.spotify\.com$/;
const ports = new Map();          // tabId → content-script port
let ws = null;
let cfg = null;
let appTabId = null;              // the tab we opened for the room ("the TV tab")
let appWinId = null;
let lastState = null;

const isSite = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && SITE_HOSTS.test(u.hostname); } catch { return false; } };

async function config() {
  if (cfg) return cfg;
  try { cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json(); } catch { cfg = {}; }
  cfg.server ||= 'ws://localhost:8080/ws';
  return cfg;
}
async function restore() {
  try { const s = await chrome.storage.session.get(['appTabId', 'appWinId']); appTabId ??= s.appTabId ?? null; appWinId ??= s.appWinId ?? null; } catch { /* */ }
}
const remember = () => chrome.storage.session.set({ appTabId, appWinId }).catch(() => {});

function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

async function connect() {
  if (ws && ws.readyState <= 1) return;
  const { server } = await config();
  await restore();
  try { ws = new WebSocket(server); } catch { ws = null; return; }
  const me = ws;
  me.onopen = () => { send({ t: 'iam', role: 'X', v: chrome.runtime.getManifest().version }); send({ t: 'app-state', s: lastState }); };
  me.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onServer(m).catch(() => {}); };
  me.onclose = () => { if (ws === me) ws = null; setTimeout(connect, 3000); };
  me.onerror = () => {};
}
// Activity every 20 s keeps the service worker (and the socket) alive; the alarm brings it back if Chrome slept it.
setInterval(() => { if (ws?.readyState === 1) send({ t: 'ping', ts: Date.now() }); else connect(); }, 20000);
chrome.alarms.create('jhk-keep', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(async () => {
  connect();
  // Tabs that were already open before the install get the content script too.
  for (const t of await chrome.tabs.query({})) {
    if (t.id != null && t.url && isSite(t.url)) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {});
  }
});
connect();

// ------------------------------------------------------------------ which tab do we drive?
async function targetTab() {
  await restore();
  if (appTabId != null) {
    const t = await chrome.tabs.get(appTabId).catch(() => null);
    if (t) return t;
    appTabId = null; appWinId = null; remember();
  }
  // Otherwise: the visible streaming tab in the last focused window.
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t && t.url && isSite(t.url) ? t : null;
}

/** Where the Jharokha wall window is (the monitor), so the TV tab opens on that screen. */
async function wallBounds() {
  const tabs = await chrome.tabs.query({});
  const wall = tabs.find((t) => /\/app\/.*[?&]w=B/.test(t.url || '')) || null;
  if (!wall) return null;
  const w = await chrome.windows.get(wall.windowId).catch(() => null);
  return w ? { left: w.left, top: w.top, width: w.width, height: w.height } : null;
}

async function openApp(url) {
  if (!isSite(url)) return;
  const cur = await targetTab();
  if (cur && cur.id === appTabId) {
    await chrome.tabs.update(cur.id, { url, active: true });
    await chrome.windows.update(cur.windowId, { focused: true });
    return;
  }
  // A window of its own, full screen like a TV, on the monitor when there is one.
  const b = await wallBounds();
  const win = await chrome.windows.create({ url, focused: true, type: 'normal', ...(b || {}) });
  appWinId = win.id; appTabId = win.tabs?.[0]?.id ?? null; remember();
  await chrome.windows.update(win.id, { state: 'fullscreen' }).catch(() => {});
}

function searchUrl(host, q) {
  const e = encodeURIComponent(q);
  if (/netflix\.com$/.test(host)) return `https://www.netflix.com/search?q=${e}`;
  if (/youtube\.com$/.test(host)) return `https://www.youtube.com/results?search_query=${e}`;
  if (/primevideo\.com$/.test(host)) return `https://www.primevideo.com/search/?phrase=${e}`;
  if (/hotstar\.com$/.test(host)) return `https://www.hotstar.com/in/explore?search_query=${e}`;
  if (/spotify\.com$/.test(host)) return `https://open.spotify.com/search/${e}`;
  if (/google\.com$/.test(host)) return `https://www.google.com/search?q=${e}`;
  return null;
}
const HOME = { 'netflix.com': 'https://www.netflix.com/browse', 'youtube.com': 'https://www.youtube.com/', 'primevideo.com': 'https://www.primevideo.com/' };

async function onServer(m) {
  if (m.t === 'open' && typeof m.url === 'string') return openApp(m.url);
  if (m.t !== 'app') return;
  const tab = await targetTab();
  if (!tab) { send({ t: 'app-state', s: null }); return; }
  const host = new URL(tab.url).hostname;
  switch (m.cmd) {
    case 'close': {
      if (tab.id === appTabId && appWinId != null) await chrome.windows.remove(appWinId).catch(() => chrome.tabs.remove(tab.id));
      else await chrome.tabs.remove(tab.id).catch(() => {});
      appTabId = null; appWinId = null; remember();
      lastState = null; send({ t: 'app-state', s: null });
      return;
    }
    case 'fullscreen': {
      const w = await chrome.windows.get(tab.windowId);
      const on = w.state !== 'fullscreen';
      await chrome.windows.update(tab.windowId, { state: on ? 'fullscreen' : 'maximized' });
      ports.get(tab.id)?.postMessage({ cmd: 'fill', arg: on });
      return;
    }
    case 'search': {
      const u = searchUrl(host, String(m.arg || ''));
      if (u) await chrome.tabs.update(tab.id, { url: u });
      else ports.get(tab.id)?.postMessage({ cmd: 'type', arg: { text: String(m.arg || ''), enter: true } });
      return;
    }
    case 'home': {
      const k = Object.keys(HOME).find((h) => host === h || host.endsWith('.' + h));
      await chrome.tabs.update(tab.id, { url: k ? HOME[k] : `https://${host}/` });
      return;
    }
    case 'reload': await chrome.tabs.reload(tab.id); return;
    case 'focus': await chrome.windows.update(tab.windowId, { focused: true }); return;
    default: {
      const p = ports.get(tab.id);
      if (p) p.postMessage({ cmd: m.cmd, arg: m.arg });
      else chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  }
}

// ------------------------------------------------------------------ content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'jhk' || port.sender?.tab?.id == null) return;
  const id = port.sender.tab.id;
  ports.set(id, port);
  port.onDisconnect.addListener(() => { if (ports.get(id) === port) ports.delete(id); });
  port.onMessage.addListener(async (m) => {
    if (m?.t !== 'state') return;
    const t = await targetTab();
    if (!t || t.id !== id) return;          // only the tab we drive reports
    lastState = { ...m.s, tv: id === appTabId };
    send({ t: 'app-state', s: lastState });
  });
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === appTabId) { appTabId = null; appWinId = null; remember(); lastState = null; send({ t: 'app-state', s: null }); }
});
chrome.tabs.onActivated.addListener(() => { setTimeout(async () => { const t = await targetTab(); if (t) ports.get(t.id)?.postMessage({ cmd: 'report' }); else if (lastState) { lastState = null; send({ t: 'app-state', s: null }); } }, 300); });
