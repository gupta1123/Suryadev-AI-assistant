import { AlertCircle, CheckCircle2, CircleDot, Clock3, type LucideIcon } from 'lucide-react';

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

  const success = ['completed', 'sent', 'delivered', 'read', 'ready', 'succeeded'].includes(normalized);
  const danger = ['failed', 'blocked', 'cancelled', 'rejected'].includes(normalized);
  const Icon = success ? CheckCircle2 : danger ? AlertCircle : Clock3;
  const tone = success ? 'success' : danger ? 'danger' : 'pending';
  const label = normalized === 'read' ? 'Delivered' : status.replaceAll('_', ' ');

  return (
    <span className={`status-badge status-badge--${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </span>
  );
}
