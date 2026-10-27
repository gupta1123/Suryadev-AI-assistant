import { useEffect, useState, type ReactNode } from 'react';
import { apiRequest } from '../lib/api';
import { toMessage } from '../lib/format';
import { MarketingCopyMessage, type MarketingCopyDetail } from '../pages/MarketingManagerDetailPage';
import type { MarketingCopyInfo } from '../types';

/** Read-only previews: manager content comes from its stored send snapshot. */
export function DocumentMessagePreviews({ info, children }: { info?: MarketingCopyInfo; children: ReactNode }) {
  const [audience, setAudience] = useState<'customer' | 'manager'>('customer');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [copy, setCopy] = useState<MarketingCopyDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const copies = info?.copies ?? [];
  const selected = copies.find((item) => item.id === selectedId) ?? copies[0];

  useEffect(() => {
    setCopy(null);
    setError('');
    if (audience !== 'manager' || !selected) return;
    let active = true;
    apiRequest<MarketingCopyDetail>(`/invoice-delivery/marketing-copies/${selected.id}`)
      .then((next) => { if (active) setCopy(next); })
      .catch((cause) => { if (active) setError(toMessage(cause)); });
    return () => { active = false; };
  }, [audience, selected?.id, selected?.status, selected?.attempt_count, selected?.accepted_at, retry]);

  return <aside className="dd-message-previews" aria-label="Document message previews">
    <div className="dd-preview-switch" role="group" aria-label="Message recipient">
      <button type="button" aria-pressed={audience === 'customer'} onClick={() => setAudience('customer')}>Customer</button>
      <button type="button" aria-pressed={audience === 'manager'} onClick={() => setAudience('manager')}>Marketing manager</button>
    </div>
    {audience === 'customer' ? children : <>
      {copies.length > 1 && <label className="dd-copy-select">Manager copy
        <select value={selected?.id ?? ''} onChange={(event) => setSelectedId(Number(event.target.value))}>
          {copies.map((item) => <option key={item.id} value={item.id}>{item.recipient} · Copy #{item.id}</option>)}
        </select>
      </label>}
      {!selected ? <div className="dd-preview-empty"><strong>No manager copy queued</strong><p>No sent manager message is available for this document.</p></div>
        : error ? <div className="dd-preview-empty" role="alert"><p>Unable to load the manager preview: {error}</p><button className="pf-btn pf-btn--ghost" type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button></div>
        : !copy || copy.id !== selected.id ? <div className="dd-preview-empty" role="status">Loading manager message…</div>
        : <MarketingCopyMessage copy={copy} />}
    </>}
  </aside>;
}
