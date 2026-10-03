import { AlertCircle, Check, CheckCheck, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { MessageLifecycleState } from '../lib/message-status';

/**
 * Shared building blocks for the "statement" detail pages (payment, document, customer):
 * no cards, hierarchy from type and whitespace, plain-language journeys, WhatsApp thread.
 * Colours come from the page's `data-tone` (see `.pf` in styles.css).
 */

export type PageTone = 'paid' | 'late' | 'critical' | 'due' | 'calm';

/** Staggered entrance delay for a section. */
export function rise(index: number): CSSProperties {
  return { '--i': index } as CSSProperties;
}

export const LIFECYCLE_LABEL: Record<MessageLifecycleState, string> = {
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
};

export function formatTime(value?: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
}

export function moneyParts(amount: number, currency: string): { cur: string; int: string; dec: string } {
  const parts = new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(amount);
  const join = (types: string[]) => parts.filter((part) => types.includes(part.type)).map((part) => part.value).join('');
  return { cur: join(['currency']), int: join(['integer', 'group']), dec: join(['decimal', 'fraction']) };
}

/** Eases a number up to its target so the headline amount settles in rather than popping. */
export function useCountUp(target: number): number {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const progress = Math.min(1, (time - began) / 900);
      const next = start + (target - start) * (1 - (1 - progress) ** 4);
      from.current = next;
      setValue(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

/** The headline figure: large tabular numerals with a quiet currency symbol and paise. */
export function Amount({ value, currency, available = true }: { value: number; currency: string; available?: boolean }) {
  const shown = useCountUp(value);
  const money = moneyParts(shown, currency);
  if (!available) return <p className="pf-amount">—</p>;
  return (
    <p className="pf-amount" aria-label={new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(value)}>
      <span className="pf-amount__cur" aria-hidden="true">{money.cur}</span>
      <span aria-hidden="true">{money.int}</span>
      <span className="pf-amount__dec" aria-hidden="true">{money.dec}</span>
    </p>
  );
}

export function StatementRow({ label, children, mono, wrap }: { label: string; children: ReactNode; mono?: boolean; wrap?: boolean }) {
  return (
    <div className={`pf-row${wrap ? ' pf-row--wrap' : ''}`}>
      <dt>{label}</dt>
      {!wrap && <i className="pf-leader" aria-hidden="true" />}
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  );
}

/* ---------- Journey: what happened, in plain words ---------- */

export type JourneyState = 'done' | 'good' | 'bad' | 'now' | 'next';
export type JourneyItem = {
  key: string;
  state: JourneyState;
  title: string;
  detail?: ReactNode;
  when?: string;
  chip?: { label: string; tone: MessageLifecycleState | 'scheduled' };
};

export function Journey({
  title,
  hint,
  items,
  label,
  index = 1,
}: {
  title: string;
  hint?: string;
  items: JourneyItem[];
  label: string;
  index?: number;
}) {
  const rail = useRef<HTMLOListElement>(null);
  const [edge, setEdge] = useState({ overflow: false, atStart: true, atEnd: true });

  const measure = useCallback(() => {
    const el = rail.current;
    if (!el) return;
    setEdge({
      overflow: el.scrollWidth > el.clientWidth + 2,
      atStart: el.scrollLeft <= 2,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
    });
  }, []);

  // Open on "now" (or the latest step) so the part that matters is in view, then keep the arrows in sync.
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const focus = el.querySelector<HTMLElement>('.pf-step--now') ?? el.querySelector<HTMLElement>('.pf-step:last-child');
    if (focus && el.scrollWidth > el.clientWidth) {
      el.scrollLeft = Math.max(0, focus.offsetLeft - (el.clientWidth - focus.offsetWidth) / 2);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length, measure]);

  const nudge = (direction: -1 | 1) => rail.current?.scrollBy({ left: direction * rail.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <section className="pf-section pf-rise" style={rise(index)} aria-label={title}>
      <header className="pf-section__head">
        <h3>{title}</h3>
        <span className="pf-section__tools">
          {hint && <span>{hint}</span>}
          {edge.overflow && (
            <span className="pf-nav">
              <button type="button" onClick={() => nudge(-1)} disabled={edge.atStart} aria-label="Earlier steps"><ChevronLeft size={16} aria-hidden="true" /></button>
              <button type="button" onClick={() => nudge(1)} disabled={edge.atEnd} aria-label="Later steps"><ChevronRight size={16} aria-hidden="true" /></button>
            </span>
          )}
        </span>
      </header>
      <ol
        className="pf-journey"
        aria-label={label}
        ref={rail}
        onScroll={measure}
        data-fade-start={edge.overflow && !edge.atStart ? 'on' : undefined}
        data-fade-end={edge.overflow && !edge.atEnd ? 'on' : undefined}
      >
        {items.map((item) => (
          <li key={item.key} className={`pf-step pf-step--${item.state}`}>
            <span className="pf-step__dot" aria-hidden="true">
              {item.state === 'done' && <Check size={12} strokeWidth={3} />}
              {item.state === 'good' && <CheckCheck size={13} strokeWidth={2.6} />}
              {item.state === 'bad' && <AlertCircle size={13} strokeWidth={2.6} />}
            </span>
            <div className="pf-step__body">
              <strong className="pf-step__title">{item.title}</strong>
              {(item.chip || item.when) && (
                <div className="pf-step__meta">
                  {item.when && <time>{item.when}</time>}
                  {item.chip && <span className={`pf-chip-status pf-chip-status--${item.chip.tone}`}>{item.chip.label}</span>}
                </div>
              )}
              {item.detail && <p>{item.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------- WhatsApp thread ---------- */

export function Ticks({ tone }: { tone: MessageLifecycleState }) {
  if (tone === 'failed') return <AlertCircle className="dt-ticks dt-ticks--failed" size={13} aria-label="Failed" />;
  if (tone === 'queued') return <Clock3 className="dt-ticks" size={12} aria-label="Queued" />;
  if (tone === 'sent') return <Check className="dt-ticks" size={14} aria-label="Sent" />;
  if (tone === 'read') return <CheckCheck className="dt-ticks dt-ticks--read" size={14} aria-label="Read" />;
  return <CheckCheck className="dt-ticks" size={14} aria-label="Delivered; read not confirmed" />;
}

export function PhoneFrame({
  name,
  subtitle,
  badge,
  bodyRef,
  style,
  children,
}: {
  name: string;
  subtitle?: string | null;
  badge?: string;
  bodyRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join('') || '?';
  return (
    <aside className="pf-phone pf-rise" style={style} aria-label="WhatsApp conversation">
      <header className="pf-phone__bar">
        <span className="pf-phone__avatar" aria-hidden="true">{initials}</span>
        <div>
          <strong>{name}</strong>
          {subtitle && <small className="mono">{subtitle}</small>}
        </div>
        {badge && <span className="pf-phone__count">{badge}</span>}
      </header>
      <div className="pf-phone__body" ref={bodyRef}>{children}</div>
    </aside>
  );
}

export function Bubble({
  tag,
  tone,
  time,
  scheduled,
  children,
}: {
  tag?: string;
  tone?: MessageLifecycleState;
  time?: string;
  scheduled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`pf-bubble${tone === 'failed' ? ' pf-bubble--failed' : ''}${scheduled ? ' pf-bubble--scheduled' : ''}`}>
      {tag && <b className="pf-bubble__tag">{tag}</b>}
      {children}
      {!scheduled && tone && (
        <span className="pf-bubble__meta">{time}<Ticks tone={tone} /></span>
      )}
    </div>
  );
}
