// A non-overridable safety floor, independent of polling settings, exact-ID
// allowlists, delivery mode, retries, fixtures and customer approval.
export const DOCUMENT_SEND_CUTOFF = '2026-10-20';
export const DOCUMENT_SEND_CUTOFF_INSTANT = '2026-10-19T18:30:00.000Z'; // 20 Oct, 00:00 IST

export type DocumentSendDates = {
  documentDate: string | null | undefined;
  documentCreatedAt: string | null | undefined;
};

export function documentDateBlocker(dates: DocumentSendDates, enabledAt?: string | null): string | null {
  const day = dates.documentDate ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    return 'document date is missing or invalid; sending is blocked';
  }
  if (day < DOCUMENT_SEND_CUTOFF) return `document is dated before ${DOCUMENT_SEND_CUTOFF}; sending is blocked`;
  const raw = dates.documentCreatedAt ?? '';
  // Require an explicit timezone rather than guessing the server's local zone.
  const created = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(created)) return 'document creation time is missing or invalid; sending is blocked';
  if (created < Date.parse(DOCUMENT_SEND_CUTOFF_INSTANT)) return `document was created before ${DOCUMENT_SEND_CUTOFF}; sending is blocked`;
  if (enabledAt !== undefined) {
    const approved = enabledAt ? Date.parse(enabledAt) : NaN;
    if (!Number.isFinite(approved) || created < approved) return 'document was created before this customer was enabled';
  }
  return null;
}
