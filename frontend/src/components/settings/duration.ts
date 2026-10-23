export type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export const UNIT_SECONDS: Record<TimeUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 };
export const MIN_DELAY_SECONDS = 10;
export const MAX_DELAY_SECONDS = 30 * 86_400;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function splitDuration(seconds: number): { amount: string; unit: TimeUnit } {
  const unit: TimeUnit = seconds % UNIT_SECONDS.days === 0 ? 'days'
    : seconds % UNIT_SECONDS.hours === 0 ? 'hours'
      : seconds % UNIT_SECONDS.minutes === 0 ? 'minutes'
        : 'seconds';
  return { amount: String(Math.max(1, Math.round(seconds / UNIT_SECONDS[unit]))), unit };
}

/** Exact wording for a configured delay: "2 days", "90 seconds". */
export function formatDuration(seconds: number): string {
  const { amount, unit } = splitDuration(seconds);
  return `${amount} ${Number(amount) === 1 ? unit.slice(0, -1) : unit}`;
}

/** Rounded wording for a computed offset: 604 920 s → "7 days". */
export function approxDuration(seconds: number): string {
  if (seconds >= 2 * 86_400) return plural(Math.round(seconds / 86_400), 'day');
  if (seconds >= 2 * 3600) return plural(Math.round(seconds / 3600), 'hour');
  if (seconds >= 120) return plural(Math.round(seconds / 60), 'minute');
  return plural(Math.round(seconds), 'second');
}

export function reminderCountLabel(count: number): string {
  return plural(count, 'reminder');
}

export function reminderSummary(firstSeconds: number, repeatSeconds: number, maximum: number): string {
  if (maximum === 1) return `1 reminder, ${formatDuration(firstSeconds)} after the invoice`;
  return `First ${formatDuration(firstSeconds)} after the invoice, then every ${formatDuration(repeatSeconds)} · up to ${reminderCountLabel(maximum)}`;
}
