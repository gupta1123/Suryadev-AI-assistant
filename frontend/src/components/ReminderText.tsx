import { formatDate } from '../lib/format';

// The text the customer receives: WhatsApp template "payment_reminder_v3" (English), filled with the
// same values the backend sends. Keep in step with the approved template in MSG91.
export function ReminderText({ customerName, amount, invoiceNumber, invoiceDate }: {
  customerName?: string | undefined; amount: number; invoiceNumber?: string | undefined; invoiceDate?: string | null | undefined;
}) {
  const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  return (
    <p className="pf-template">
      {`Hello ${customerName ?? 'Customer'},\n\nThis is a payment reminder for `}<strong>₹{money}</strong>{' pending against invoice '}<strong>{invoiceNumber ?? ''}</strong>
      {' dated '}<strong>{formatDate(invoiceDate)}</strong>
      {'.\n\nPlease arrange payment at your earliest convenience. If payment is not made on or before the due date, interest will be levied at 24% per annum. If payment has already been made, please ignore this message.\n\nRegards,\nSuryadev Alloys and Power Private Limited'}
    </p>
  );
}
