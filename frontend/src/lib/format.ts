export function formatCurrency(amount: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(
    new Date(`${value}T00:00:00Z`),
  );
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
