import { AlertCircle, Check, CheckCheck, CheckCircle2, CircleDot, Clock3, type LucideIcon } from 'lucide-react';

// Help-request lifecycle states get their own tones so open work stands out from finished work.
const HELP_TONES: Record<string, { tone: string; icon: LucideIcon; label: string }> = {
  open: { tone: 'open', icon: CircleDot, label: 'Open' },
  in_progress: { tone: 'progress', icon: Clock3, label: 'In progress' },
  resolved: { tone: 'resolved', icon: CheckCircle2, label: 'Resolved' },
};

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const help = HELP_TONES[normalized];
  if (help) {
    const HelpIcon = help.icon;
    return (
      <span className={`status-badge status-badge--${help.tone}`}>
        <HelpIcon size={13} aria-hidden="true" />
        {help.label}
      </span>
    );
  }

  if (normalized === 'read') {
    return (
      <span className="status-badge status-badge--read">
        <CheckCheck size={13} aria-hidden="true" />
        Read
      </span>
    );
  }

  if (normalized === 'delivered') {
    return (
      <span className="status-badge status-badge--delivered">
        <CheckCheck size={13} aria-hidden="true" />
        Delivered
      </span>
    );
  }

  if (normalized === 'sent') {
    return (
      <span className="status-badge status-badge--sent">
        <Check size={13} aria-hidden="true" />
        Sent
      </span>
    );
  }

  const success = ['completed', 'ready', 'succeeded'].includes(normalized);
  const danger = ['failed', 'blocked', 'cancelled', 'rejected'].includes(normalized);
  const Icon = success ? CheckCircle2 : danger ? AlertCircle : Clock3;
  const tone = success ? 'success' : danger ? 'danger' : 'pending';
  const label = status.replaceAll('_', ' ');

  return (
    <span className={`status-badge status-badge--${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </span>
  );
}
