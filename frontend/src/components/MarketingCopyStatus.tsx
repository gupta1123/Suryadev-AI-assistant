import type { MarketingCopyInfo } from '../types';
import { formatDateTime } from '../lib/format';

const COPY_LABEL = {
  pending: 'Queued', processing: 'Sending', accepted: 'Accepted by WhatsApp provider',
  failed: 'Copy failed', unknown: 'Outcome unknown - needs checking',
};

export function MarketingCopyStatus({ info }: { info?: MarketingCopyInfo }) {
  if (!info) return null;
  return (
    <section className="marketing-copy" aria-label="Marketing manager copy" aria-live="polite">
      <strong>Marketing manager copy</strong>
      {!info.copies.length ? (
        <p>{info.recipient} · {info.enabled ? 'No copy queued for this message' : 'Copy sending is not enabled'}</p>
      ) : info.copies.map((copy) => (
        <div key={copy.id}>
          <p><span className="mono">{copy.recipient}</span> · <span data-copy-status={copy.status}>{COPY_LABEL[copy.status]}</span></p>
          {copy.accepted_at && <small>{formatDateTime(copy.accepted_at)} · Delivery and read receipt not tracked here</small>}
          {copy.last_error && <details><summary>Copy details</summary><small>{copy.last_error}</small></details>}
        </div>
      ))}
      <small>Separate from the customer's delivery and read status.</small>
    </section>
  );
}
