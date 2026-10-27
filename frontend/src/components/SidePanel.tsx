import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

/** A right-hand panel for one focused task. Esc and the backdrop close it unless `busy`. */
export function SidePanel({
  title,
  subtitle,
  children,
  footer,
  onClose,
  busy = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const guard = useRef({ onClose, busy });
  guard.current = { onClose, busy };

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !guard.current.busy) guard.current.onClose();
    }
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, []);

  return (
    <div className="side-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <aside className="side-panel" role="dialog" aria-modal="true" aria-labelledby="side-panel-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="side-panel__head">
          <div>
            <h2 id="side-panel-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button ref={closeRef} className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Close panel">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="side-panel__body">{children}</div>
        {footer && <footer className="side-panel__foot">{footer}</footer>}
      </aside>
    </div>
  );
}
