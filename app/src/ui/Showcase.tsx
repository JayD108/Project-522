// Showcase: an audio-reactive canvas on the wall. It listens to the room through the laptop's microphone (music,
// a party) and draws a slowly turning ring of light bars that pulse with the bass. Nothing is recorded or sent:
// the analyser only reads loudness per frequency band, in this window.
// No microphone (or not allowed)? It still runs, driven by a calm generated rhythm.
import { useEffect, useRef, useState } from 'preact/hooks';
import { setFx } from '../host';

const BARS = 96;

export function Showcase() {
  const cv = useRef<HTMLCanvasElement>(null);
  const [src, setSrc] = useState<'mic' | 'ambient' | 'wait'>('wait');
  const [hint, setHint] = useState(true);
  useEffect(() => {
    let stop = false, raf = 0, ctx: AudioContext | null = null, stream: MediaStream | null = null;
    let analyser: AnalyserNode | null = null;
    let data: Uint8Array<ArrayBuffer> = new Uint8Array(512);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
        ctx = new AudioContext();
        await ctx.resume().catch(() => {});
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.78;
        ctx.createMediaStreamSource(stream).connect(analyser);                // not connected to the speakers: no echo
        data = new Uint8Array(analyser.frequencyBinCount);
        setSrc(ctx.state === 'running' ? 'mic' : 'ambient');
      } catch { setSrc('ambient'); }
    })();
    const c = cv.current!;
    const g = c.getContext('2d')!;
    const level = new Float32Array(BARS);
    let hue = 28, rot = 0, last = 0, bassAvg = 0;
    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (ts - last < 33) return;                                            // ~30 fps is plenty, and kind to the CPU
      last = ts;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      let bass = 0;
      if (analyser && ctx?.state === 'running') {
        analyser.getByteFrequencyData(data);
        for (let i = 0; i < BARS; i++) {
          // Log-spaced bands: more bars for the low and mid notes people actually hear.
          const a = Math.floor(Math.pow(i / BARS, 1.7) * (data.length * 0.7)), b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / BARS, 1.7) * (data.length * 0.7)));
          let s = 0; for (let k = a; k < b; k++) s += data[k];
          const v = s / (b - a) / 255;
          level[i] += (v - level[i]) * 0.35;
        }
        for (let k = 1; k < 8; k++) bass += data[k] / 255; bass /= 7;
      } else {
        const t = ts / 1000, beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 1.6)), 6);
        for (let i = 0; i < BARS; i++) {
          const v = 0.18 + 0.16 * Math.sin(t * 0.9 + i * 0.21) * Math.sin(t * 0.37 + i * 0.05) + beat * 0.35 * Math.exp(-i / 22);
          level[i] += (Math.max(0, v) - level[i]) * 0.2;
        }
        bass = 0.2 + beat * 0.5;
      }
      bassAvg += (bass - bassAvg) * 0.08;
      const kick = Math.max(0, bass - bassAvg);
      hue = (hue + 0.05 + kick * 2) % 360;
      rot += 0.0015 + kick * 0.02;
      // Background: deep warm dark with a breathing glow.
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = 'rgba(8, 6, 10, 0.32)';                                 // trails
      g.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * (0.2 + kick * 0.06);
      const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.4);
      glow.addColorStop(0, `hsla(${hue}, 85%, 60%, ${0.10 + bassAvg * 0.25})`);
      glow.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      g.fillStyle = glow; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      const bw = Math.max(2, (2 * Math.PI * R) / BARS * 0.55);
      for (let i = 0; i < BARS; i++) {
        const ang = rot + (i / BARS) * Math.PI * 2;
        const len = R * 0.12 + level[i] * Math.min(w, h) * 0.34;
        const x0 = cx + Math.cos(ang) * R, y0 = cy + Math.sin(ang) * R;
        const x1 = cx + Math.cos(ang) * (R + len), y1 = cy + Math.sin(ang) * (R + len);
        g.strokeStyle = `hsla(${(hue + i * 1.4) % 360}, 90%, ${45 + level[i] * 30}%, ${0.55 + level[i] * 0.45})`;
        g.lineWidth = bw;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      g.beginPath(); g.arc(cx, cy, R * 0.92, 0, Math.PI * 2);
      g.strokeStyle = `hsla(${hue}, 70%, 70%, ${0.25 + kick})`; g.lineWidth = 2; g.stroke();
    };
    raf = requestAnimationFrame(draw);
    const t = setTimeout(() => setHint(false), 6000);
    return () => { stop = true; cancelAnimationFrame(raf); clearTimeout(t); stream?.getTracks().forEach((x) => x.stop()); ctx?.close().catch(() => {}); };
  }, []);
  return (
    <div class="showcase" onClick={() => setHint(true)} data-src={src}>
      <canvas ref={cv} />
      {hint && (
        <div class="sc-hint">
          <span>{src === 'mic' ? 'Listening to the room' : src === 'ambient' ? 'No microphone: ambient rhythm' : 'Starting…'}</span>
          <button onClick={(e) => { e.stopPropagation(); setFx({ showcase: false }); }}>Exit showcase</button>
        </div>
      )}
    </div>
  );
}
