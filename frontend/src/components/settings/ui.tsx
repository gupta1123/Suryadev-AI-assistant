import type { ReactNode } from 'react';

export type Tone = 'ok' | 'test' | 'warn' | 'bad' | 'off';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`st-pill st-pill--${tone}`}>{children}</span>;
}

export function Card({
  title,
  description,
  action,
  flush = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="st-card">
      <header className="st-card__head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className={flush ? 'st-card__body st-card__body--flush' : 'st-card__body'}>{children}</div>
    </section>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="st-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => <span key={index} />)}
    </div>
  );
}

/** Announces a short result ("Saved") to screen readers without moving focus. */
export function LiveNote({ tone = 'ok', children }: { tone?: 'ok' | 'bad'; children: ReactNode }) {
  return <p className={`st-live st-live--${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>{children}</p>;
}
