export function formatCurrency(amount: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date);
}

export function formatBytes(value?: number | null): string {
  if (!value) return '—';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
}

export function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

export function deliveryStatus(jobStatus: string, messageStatus?: string): string {
  return messageStatus ?? jobStatus;
}

/** 919876543210 → +91 98765 43210 */
export function formatPhone(value?: string | null): string {
  const digits = (value ?? '').replace(/\D/g, '');
  if (!digits) return '—';
  if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

/** "3 minutes ago" / "in 2 minutes". Falls back to a date for anything older than a week. */
export function formatRelative(value?: string | null, now = Date.now()): string {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds < 0 ? 'just now' : 'in a moment';
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return formatter.format(Math.round(seconds / 86_400), 'day');
  return formatDate(value);
}
