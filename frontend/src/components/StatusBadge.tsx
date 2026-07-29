import { AlertCircle, CheckCircle2, Clock3 } from 'lucide-react';

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const success = ['completed', 'sent', 'delivered', 'read', 'ready', 'succeeded'].includes(normalized);
  const danger = ['failed', 'blocked', 'cancelled', 'rejected'].includes(normalized);
  const Icon = success ? CheckCircle2 : danger ? AlertCircle : Clock3;
  const tone = success ? 'success' : danger ? 'danger' : 'pending';

  return (
    <span className={`status-badge status-badge--${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {status.replaceAll('_', ' ')}
    </span>
  );
}
