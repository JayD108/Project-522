// Shared modal: Esc / backdrop click closes; focus moves into it.
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon';

export function Modal({ onClose, children, label, wide = false }: { onClose: () => void; children: any; label: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', k, true);
    ref.current?.focus();
    return () => removeEventListener('keydown', k, true);
  }, []);
  return (
    <div class="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        <button class="modal-x icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        {children}
      </div>
    </div>
  );
}
