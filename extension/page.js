// Jharokha Remote · page helper (runs in the page itself, not the isolated content-script world).
// Netflix and YouTube break or ignore direct <video> changes (Netflix stops with an error if you set currentTime),
// so play / pause / seek / volume go through each site's own player object. The content script asks via postMessage.
(() => {
  if (window.__jhkPage) return;
  window.__jhkPage = true;
  const nfx = () => {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      return vp.getVideoPlayerBySessionId(ids.find((s) => s.startsWith('watch')) || ids[0]) || null;
    } catch { return null; }
  };
  const yt = () => { const p = document.getElementById('movie_player'); return p && typeof p.playVideo === 'function' ? p : null; };
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__jhk !== 'player') return;
    const { op, arg } = e.data;
    let ok = false;
    const n = nfx();
    if (n) {
      ok = true;
      if (op === 'play') n.play(); else if (op === 'pause') n.pause();
      else if (op === 'seekTo') n.seek(Math.max(0, arg) * 1000);
      else if (op === 'volume') n.setVolume(Math.max(0, Math.min(1, arg / 100)));
      else if (op === 'mute') n.setMuted(!!arg);
      else ok = false;
    } else {
      const p = yt();
      if (p) {
        ok = true;
        if (op === 'play') p.playVideo(); else if (op === 'pause') p.pauseVideo();
        else if (op === 'seekTo') p.seekTo(Math.max(0, arg), true);
        else if (op === 'volume') { p.setVolume(Math.max(0, Math.min(100, arg))); if (arg > 0) p.unMute(); }
        else if (op === 'mute') { if (arg) p.mute(); else p.unMute(); }
        else ok = false;
      }
    }
    window.postMessage({ __jhk: 'player-done', id: e.data.id, ok }, '*');
  });
})();
