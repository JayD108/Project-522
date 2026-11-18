// Web-visible vitals (v2 §2). Temperature/fan/voltage are deliberately not exposed by ChromeOS → "n/a".
import { signal } from '@preact/signals';

export interface Vitals {
  battery: { level: number; charging: boolean } | null;
  pressure: string;          // nominal | fair | serious | critical | n/a
  heapMB: number | null;
  online: boolean;
  net: { type?: string; downlink?: number; rtt?: number } | null;
}

export const vitals = signal<Vitals>({ battery: null, pressure: 'n/a', heapMB: null, online: navigator.onLine, net: null });

let started = false;
export function startVitals() {
  if (started) return;
  started = true;
  let battery: any = null;
  (navigator as any).getBattery?.().then((b: any) => { battery = b; }).catch(() => {});
  let pressure = 'n/a';
  const PO = (window as any).PressureObserver;
  if (PO) {
    try {
      const po = new PO((recs: any[]) => { pressure = recs[recs.length - 1].state; });
      po.observe('cpu', { sampleInterval: 2000 }).catch(() => { pressure = 'n/a'; });
    } catch { /* unsupported source */ }
  }
  const tick = () => {
    const c = (navigator as any).connection;
    const mem = (performance as any).memory;
    vitals.value = {
      battery: battery ? { level: battery.level, charging: battery.charging } : null,
      pressure,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 2 ** 20) : null,
      online: navigator.onLine,
      net: c ? { type: c.effectiveType, downlink: c.downlink, rtt: c.rtt } : null,
    };
  };
  tick();
  setInterval(tick, 1000);   // HUD rule: 1 Hz, never per frame
}
