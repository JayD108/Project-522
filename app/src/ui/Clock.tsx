import { useEffect, useState } from 'preact/hooks';

export function Clock({ size = 'big' }: { size?: 'big' | 'small' }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick on the second boundary, once per second.
    let t = 0;
    const loop = () => { setNow(new Date()); t = window.setTimeout(loop, 1000 - (Date.now() % 1000)); };
    t = window.setTimeout(loop, 1000 - (Date.now() % 1000));
    return () => clearTimeout(t);
  }, []);
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (size === 'small') return <div class="clock-small">{time}</div>;
  return (
    <div class="clock">
      <div class="clock-time">{time}</div>
      <div class="clock-date">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    </div>
  );
}
