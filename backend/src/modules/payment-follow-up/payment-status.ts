export type PaymentState = 'not_paid' | 'partly_paid' | 'paid' | 'cancelled' | 'unknown' | 'unavailable';

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

/**
 * SAP's own clearing status on the invoice header. The client confirmed it on 17 test invoices:
 * A = not paid, B = partly paid, C = fully paid, and a cancelled invoice has none.
 */
export function paymentStateFromSap(header: Row): { state: PaymentState; label: string } {
  const cancelled = header.BillingDocumentIsCancelled === true || header.BillingDocumentIsCancelled === 'true' || Boolean(text(header.CancelledBillingDocument));
  if (cancelled) return { state: 'cancelled', label: 'Cancelled in SAP' };
  switch (text(header.InvoiceClearingStatus).toUpperCase()) {
    case 'A': return { state: 'not_paid', label: 'Not paid in SAP' };
    case 'B': return { state: 'partly_paid', label: 'Partly paid in SAP' };
    case 'C': return { state: 'paid', label: 'Fully paid in SAP' };
    default: return { state: 'unknown', label: 'SAP gave no payment status' };
  }
}

/** The SAP header facts shown for an invoice. Read once while the eligible list is built and reused by the details panel. */
export function sapFactsFromHeader(header: Row, createdAt: string | null) {
  return {
    ...paymentStateFromSap(header),
    clearingStatus: text(header.InvoiceClearingStatus) || null,
    paymentTerms: text(header.CustomerPaymentTerms) || null,
    createdAt,
    documentType: text(header.BillingDocumentType) || null,
    currency: text(header.TransactionCurrency) || null,
  };
}

export type SapInvoiceFacts = ReturnType<typeof sapFactsFromHeader>;

/** The letter SAP reported ('A', 'B', 'C') or '' for none. Kept on a journey to tell whether payment arrived after it started. */
export function clearingLetter(header: Row): string {
  return text(header.InvoiceClearingStatus).toUpperCase();
}
