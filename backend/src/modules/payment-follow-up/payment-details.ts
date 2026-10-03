import { z } from 'zod';

export const PAYMENT_METHODS = [
  'bank_transfer',
  'upi',
  'cheque',
  'cash',
  'card',
  'other',
] as const;

function optionalTrimmedString(maximumLength: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed || undefined;
    },
    z.string().max(maximumLength).optional(),
  );
}

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function todayInIndia(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export const paymentDetailsSchema = z.object({
  paymentDate: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid payment date')
      .refine(isCalendarDate, 'Use a valid payment date')
      .refine((value) => value <= todayInIndia(), 'Payment date cannot be in the future')
      .optional(),
  ),
  paymentMethod: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(PAYMENT_METHODS).optional(),
  ),
  referenceNumber: optionalTrimmedString(120),
  notes: optionalTrimmedString(500),
}).strict();

export type PaymentDetails = z.infer<typeof paymentDetailsSchema>;

export function paymentDetailsForStorage(details: PaymentDetails): Record<string, string> {
  return {
    ...(details.paymentDate ? { payment_date: details.paymentDate } : {}),
    ...(details.paymentMethod ? { payment_method: details.paymentMethod } : {}),
    ...(details.referenceNumber ? { reference_number: details.referenceNumber } : {}),
    ...(details.notes ? { notes: details.notes } : {}),
  };
}
