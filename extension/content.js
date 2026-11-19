// Jharokha Remote · content script (runs inside Netflix / YouTube / … tabs on the laptop).
// Turns phone commands into actions on the page: a visible pointer you move like a touchpad, clicks, scrolling,
// TV-style arrow navigation with a highlight ring, typing, and player controls. Reports what's playing back.
(() => {
  if (window.__jhkRemote) return;
  window.__jhkRemote = true;

  const H = location.hostname;
  const NFX = /netflix\.com$/.test(H);
  const YT = /youtube\.com$/.test(H);

  // ---------------------------------------------------------------- link to the background worker
  let port = null;
  function connect() {
    try { port = chrome.runtime.connect({ name: 'jhk' }); } catch { return; }   // extension reloaded: stay quiet
    port.onMessage.addListener((m) => { try { onCmd(m.cmd, m.arg); } catch (e) { console.debug('jhk', e); } });
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
    report(true);
  }

  // ---------------------------------------------------------------- overlay: pointer + focus ring (shadow DOM)
  const host = document.createElement('jhk-remote');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const sh = host.attachShadow({ mode: 'closed' });
  sh.innerHTML = `<style>
    .c { position: fixed; left: 0; top: 0; width: 30px; height: 30px; margin: -3px 0 0 -3px; opacity: 0; transition: opacity .3s; will-change: transform; }
    .c svg { filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
    .c.down svg { transform: scale(.85); }
    .r { position: fixed; left: 0; top: 0; border: 3px solid #e0a458; border-radius: 10px; box-shadow: 0 0 0 4px rgba(0,0,0,.45), 0 0 24px rgba(224,164,88,.6);
         opacity: 0; transition: opacity .2s, transform .15s, width .15s, height .15s; }
    .t { position: fixed; left: 50%; bottom: 8%; transform: translateX(-50%); background: rgba(10,8,6,.82); color: #f1e9dc; font: 600 20px system-ui, sans-serif;
         padding: 10px 22px; border-radius: 99px; opacity: 0; transition: opacity .25s; }
  </style>
  <div class="r"></div>
  <div class="c"><svg width="30" height="30" viewBox="0 0 30 30"><path d="M4 3l20 11-8.5 2.2L20 26l-4 2-4.4-9.6L5 24z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
  <div class="t"></div>`;
  const cur = sh.querySelector('.c');
  const ring = sh.querySelector('.r');
  const tip = sh.querySelector('.t');
  const mount = () => { const p = document.fullscreenElement || document.documentElement; if (host.parentNode !== p) p.appendChild(host); };

  let cx = innerWidth / 2, cy = innerHeight / 2;
  let hideCur = 0, hideTip = 0;
  function showCursor() {
    mount();
    cur.style.transform = `translate(${cx}px, ${cy}px)`;
    cur.style.opacity = '1';
    clearTimeout(hideCur); hideCur = setTimeout(() => { cur.style.opacity = '0'; }, 6000);
  }
  function say(text) {
    mount();
    tip.textContent = text; tip.style.opacity = '1';
    clearTimeout(hideTip); hideTip = setTimeout(() => { tip.style.opacity = '0'; }, 1400);
  }

  // ---------------------------------------------------------------- synthetic pointer events
  function under(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    return el;
  }
  function fire(el, type, x, y, buttons = 0) {
    const P = type.startsWith('pointer');
    const Ctor = P && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, {
      bubbles: !/enter|leave/.test(type), cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  }
  let hoverEl = null;
  function hover(x, y) {
    const el = under(x, y);
    if (!el) return null;
    if (el !== hoverEl) {
      if (hoverEl && hoverEl.isConnected) { fire(hoverEl, 'pointerout', x, y); fire(hoverEl, 'mouseout', x, y); fire(hoverEl, 'pointerleave', x, y); fire(hoverEl, 'mouseleave', x, y); }
      fire(el, 'pointerover', x, y); fire(el, 'mouseover', x, y); fire(el, 'pointerenter', x, y); fire(el, 'mouseenter', x, y);
      hoverEl = el;
    }
    fire(el, 'pointermove', x, y); fire(el, 'mousemove', x, y);
    return el;
  }
  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
  function clickAt(x, y) {
    const el = hover(x, y);
    if (!el) return null;
    cur.classList.add('down');
    fire(el, 'pointerdown', x, y, 1); fire(el, 'mousedown', x, y, 1);
    const f = el.closest(FOCUSABLE);
    if (f && typeof f.focus === 'function') f.focus({ preventScroll: true });
    fire(el, 'pointerup', x, y); fire(el, 'mouseup', x, y);
    fire(el, 'click', x, y);
    setTimeout(() => cur.classList.remove('down'), 120);
    return el;
  }
  function scrollAt(x, y, dx, dy) {
    let el = under(x, y);
    while (el && el !== document.body && el !== document.documentElement) {
      const s = getComputedStyle(el);
      const canY = dy && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const canX = dx && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (canY || canX) { el.scrollBy({ left: dx, top: dy }); return; }
      el = el.parentElement;
    }
    window.scrollBy({ left: dx, top: dy });
  }

  // ---------------------------------------------------------------- TV-style arrow navigation
  const NAV = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [tabindex]:not([tabindex="-1"])';
  let navEl = null;
  const visible = (el, r) => {
    if (r.width < 8 || r.height < 8) return false;
    if (r.bottom < -innerHeight || r.top > innerHeight * 2 || r.right < 0 || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05 && !el.closest('[aria-hidden="true"], [inert]') && !el.disabled;
  };
  function candidates() {
    const out = [];
    for (const el of document.querySelectorAll(NAV)) {
      if (host.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;
      out.push({ el, r });
    }
    // A clickable wrapper around one clickable child (same box): keep only the outer one.
    return out.filter((c) => !out.some((o) => o !== c && o.el.contains(c.el) && Math.abs(o.r.width - c.r.width) < 6 && Math.abs(o.r.height - c.r.height) < 6));
  }
  function nav(dir) {
    const list = candidates();
    if (!list.length) return;
    const curOk = navEl && navEl.isConnected && list.some((c) => c.el === navEl);
    const from = curOk ? navEl.getBoundingClientRect() : { left: cx, right: cx, top: cy, bottom: cy, width: 0, height: 0 };
    const fx = (from.left + from.right) / 2, fy = (from.top + from.bottom) / 2;
    let best = null, bestScore = Infinity;
    for (const c of list) {
      if (c.el === navEl) continue;
      const tx = (c.r.left + c.r.right) / 2, ty = (c.r.top + c.r.bottom) / 2;
      let main, side, overlap;
      if (dir === 'left' || dir === 'right') {
        main = dir === 'right' ? c.r.left - from.right : from.left - c.r.right;
        if ((dir === 'right' ? tx - fx : fx - tx) <= 4) continue;
        overlap = Math.min(c.r.bottom, from.bottom) - Math.max(c.r.top, from.top);
        side = overlap > 0 ? 0 : Math.abs(ty - fy);
      } else {
        main = dir === 'down' ? c.r.top - from.bottom : from.top - c.r.bottom;
        if ((dir === 'down' ? ty - fy : fy - ty) <= 4) continue;
        overlap = Math.min(c.r.right, from.right) - Math.max(c.r.left, from.left);
        side = overlap > 0 ? 0 : Math.abs(tx - fx);
      }
      const score = Math.max(0, main) + side * 2.5 + (curOk ? 0 : Math.hypot(tx - fx, ty - fy) * 0.2);
      if (score < bestScore) { bestScore = score; best = c.el; }
    }
    if (!best && !curOk) best = list[0].el;
    if (best) setNav(best);
  }
  function setNav(el) {
    navEl = el;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    drawRing();
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    hover(cx, cy);             // Netflix / YouTube show previews and controls on hover
  }
  let ringT = 0;
  function drawRing() {
    mount();
    if (!navEl || !navEl.isConnected) { ring.style.opacity = '0'; return; }
    const r = navEl.getBoundingClientRect();
    ring.style.transform = `translate(${r.left - 5}px, ${r.top - 5}px)`;
    ring.style.width = `${r.width + 4}px`; ring.style.height = `${r.height + 4}px`;
    ring.style.opacity = '1';
    clearTimeout(ringT); ringT = setTimeout(() => { ring.style.opacity = '0'; }, 8000);
  }
  addEventListener('scroll', () => { if (ring.style.opacity === '1') drawRing(); }, { passive: true, capture: true });

  // ---------------------------------------------------------------- player
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  function video() {
    const vs = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0 || v.currentSrc);
    return vs.sort((a, b) => area(b) - area(a))[0] || null;
  }
  /** On a watch page the arrows drive the player (like a TV remote); elsewhere they move the highlight. */
  const playerPage = () => {
    const v = video();
    return !!v && area(v) > innerWidth * innerHeight * 0.45 && (NFX ? /^\/watch\//.test(location.pathname) : YT ? /^\/(watch|shorts|embed)/.test(location.pathname) : true);
  };
  let reqId = 0;
  function viaPage(op, arg) {
    if (!NFX && !YT) return Promise.resolve(false);
    const id = ++reqId;
    return new Promise((res) => {
      const done = (e) => { if (e.source === window && e.data?.__jhk === 'player-done' && e.data.id === id) { removeEventListener('message', done); res(e.data.ok); } };
      addEventListener('message', done);
      postMessage({ __jhk: 'player', op, arg, id }, '*');
      setTimeout(() => { removeEventListener('message', done); res(false); }, 400);
    });
  }
  let blocked = false;
  async function player(op, arg) {
    const v = video();
    if (!v) return;
    if (op === 'toggle') op = v.paused ? 'play' : 'pause';
    if (op === 'seek') { op = 'seekTo'; arg = Math.max(0, Math.min((v.duration || 1e9) - 1, v.currentTime + arg)); }
    if (op === 'mute') arg = !v.muted;
    if (await viaPage(op, arg)) { if (op === 'play') setTimeout(() => { blocked = v.paused; }, 600); }
    else if (op === 'play') v.play().then(() => { blocked = false; }).catch(() => { blocked = true; });
    else if (op === 'pause') v.pause();
    else if (op === 'seekTo') v.currentTime = arg;
    else if (op === 'volume') { v.volume = Math.max(0, Math.min(1, arg / 100)); if (arg > 0) v.muted = false; }
    else if (op === 'mute') v.muted = arg;
    const label = { play: 'Play', pause: 'Pause', mute: arg ? 'Muted' : 'Sound on' }[op];
    if (label) say(label);
    else if (op === 'volume') say(`Volume ${Math.round(arg)}`);
    else if (op === 'seekTo') say(fmt(arg));
    setTimeout(() => report(true), 250);
  }
  const fmt = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

  // "Skip intro" / "Next episode" / "Skip ad": find the button that's showing right now.
  const SKIP = [
    '[data-uia="player-skip-intro"]', '[data-uia="player-skip-recap"]', '[data-uia="player-skip-preplay"]', '[data-uia="next-episode-seamless-button"]',
    '.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-container button',
    '[data-jhk-skip]',
  ].join(',');
  function skipButton() {
    for (const el of document.querySelectorAll(SKIP)) { const r = el.getBoundingClientRect(); if (r.width > 4 && r.height > 4) return el; }
    return null;
  }

  // ---------------------------------------------------------------- typing
  const editable = (el) => !!el && (el.isContentEditable || (el instanceof HTMLInputElement && !/^(button|submit|checkbox|radio|range|file|hidden|image|reset|color)$/.test(el.type)) || el instanceof HTMLTextAreaElement);
  function searchBox() {
    return document.querySelector('input[type=search], input[name=search_query], input[data-uia="search-box-input"], input[aria-label*="earch" i], input[placeholder*="earch" i]');
  }
  function typeText(text, enter) {
    let el = document.activeElement;
    if (!editable(el)) el = searchBox();
    if (!el) { say('Tap a text box first'); return; }
    el.focus();
    if (typeof el.select === 'function') el.select(); else document.execCommand('selectAll');
    // insertText behaves like real typing: React/Polymer sites see normal input events.
    if (!document.execCommand('insertText', false, text)) {
      const set = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
      set ? set.call(el, text) : (el.value = text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (enter) pressKey(el, 'Enter');
  }
  const KEYS = { enter: ['Enter', 13], backspace: ['Backspace', 8], escape: ['Escape', 27], space: [' ', 32], tab: ['Tab', 9] };
  function pressKey(el, key) {
    const code = Object.values(KEYS).find((k) => k[0] === key)?.[1] || 0;
    const o = { key, code: key === ' ' ? 'Space' : key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
    const goOn = el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    if (!goOn) return;
    if (key === 'Enter' && el.form) { if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit(); else el.form.submit(); }
    if (key === 'Backspace' && editable(el)) document.execCommand('delete');
  }

  // ---------------------------------------------------------------- commands
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function onCmd(cmd, arg) {
    mount();
    switch (cmd) {
      case 'report': return report(true);
      case 'move': {
        cx = clamp(cx + (+arg?.dx || 0), 0, innerWidth - 2); cy = clamp(cy + (+arg?.dy || 0), 0, innerHeight - 2);
        showCursor(); hover(cx, cy);
        if (navEl) { navEl = null; ring.style.opacity = '0'; }
        return;
      }
      case 'click': {
        showCursor();
        const el = clickAt(cx, cy);
        if (el) { const n = el.closest(NAV); if (n) { navEl = n; drawRing(); } }
        return setTimeout(() => report(true), 300);
      }
      case 'scroll': showCursor(); return scrollAt(cx, cy, clamp(+arg?.dx || 0, -3000, 3000), clamp(+arg?.dy || 0, -3000, 3000));
      case 'nav': {
        if (playerPage() && !navEl) {
          if (arg === 'left') return player('seek', -10);
          if (arg === 'right') return player('seek', 10);
          const v = video();
          if (arg === 'up') return player('volume', Math.min(100, Math.round((v.muted ? 0 : v.volume) * 100) + 10));
          if (arg === 'down') return player('volume', Math.max(0, Math.round((v.muted ? 0 : v.volume) * 100) - 10));
        }
        return nav(arg);
      }
      case 'ok': {
        if (navEl && navEl.isConnected) {
          const r = navEl.getBoundingClientRect();
          cx = r.left + r.width / 2; cy = r.top + r.height / 2;
          clickAt(cx, cy);
          if (editable(navEl)) say('Type on your phone');
        } else if (playerPage()) player('toggle');
        else nav('down');
        return setTimeout(() => report(true), 300);
      }
      case 'browse': navEl = null; return nav('down');      // leave player mode: highlight the player's buttons
      case 'back': {
        if (navEl && playerPage()) { navEl = null; ring.style.opacity = '0'; return; }
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
        history.back(); return;
      }
      case 'type': return typeText(String(arg?.text ?? ''), !!arg?.enter);
      case 'key': {
        const k = KEYS[arg];
        if (!k) return;
        const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : (navEl || document.body);
        if (arg === 'space' && playerPage() && !editable(el)) return player('toggle');
        return pressKey(el, k[0]);
      }
      case 'toggle': case 'play': case 'pause': return player(cmd);
      case 'seek': return player('seek', clamp(+arg || 0, -600, 600));
      case 'seekTo': return player('seekTo', Math.max(0, +arg || 0));
      case 'volume': return player('volume', clamp(+arg || 0, 0, 100));
      case 'mute': return player('mute');
      case 'skip': { const b = skipButton(); if (b) { b.click(); say('Skipped'); } else say('Nothing to skip'); return setTimeout(() => report(true), 300); }
      case 'fill': document.documentElement.classList.toggle('jhk-fill', !!arg); dispatchEvent(new Event('resize')); return;
    }
  }

  // YouTube in the full-screen TV window: let the player fill the window (the site's own button needs a real tap).
  const fillCss = document.createElement('style');
  fillCss.textContent = `html.jhk-fill #movie_player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483000 !important; background: #000; }
    html.jhk-fill #movie_player video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; object-fit: contain; }
    html.jhk-fill body { overflow: hidden !important; }`;
  if (YT) (document.head || document.documentElement).appendChild(fillCss);

  // ---------------------------------------------------------------- state back to the phones
  let lastJson = '', lastSent = 0;
  function report(force) {
    if (!port) return;
    const v = video();
    const sk = skipButton();
    const ae = document.activeElement;
    const s = {
      site: H.replace(/^www\./, ''), title: document.title.slice(0, 120), path: location.pathname.slice(0, 80),
      v: v ? { playing: !v.paused, t: Math.round(v.currentTime * 10) / 10 || 0, d: isFinite(v.duration) ? Math.round(v.duration) : 0, vol: Math.round(v.volume * 100), muted: v.muted } : null,
      player: playerPage(), skip: sk ? (sk.textContent || sk.getAttribute('aria-label') || 'Skip').trim().slice(0, 40) : null,
      typing: editable(ae), blocked: !!v && blocked && v.paused,
    };
    const j = JSON.stringify(s);
    if (!force && j === lastJson && Date.now() - lastSent < 5000) return;
    lastJson = j; lastSent = Date.now();
    try { port.postMessage({ t: 'state', s }); } catch { /* reconnecting */ }
  }
  setInterval(() => { if (!document.hidden) report(false); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) report(true); });

  connect();
})();
