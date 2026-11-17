import { getSupabaseServerClient } from '../../lib/supabase.js';
import { SapODataClient, escapeODataString } from '../invoice-delivery/sap-client.js';
import { getAutoSettings, serverCanSendReminders, type AutoSettings } from './auto-settings.js';
import { listEligiblePaymentInvoices, startManualPaymentJourney } from './manual-journeys.js';
import { clearingLetter, paymentStateFromSap, type PaymentState } from './payment-status.js';
import { holdPaymentCase, markPaymentCasePaid } from './repository.js';
import { getReminderSettings } from './settings.js';

const AUTO_USER = 'automatic';
const RUN_EVERY_MS = 60_000;
const MAX_STARTS_PER_RUN = 5;
const MAX_STARTS_PER_HOUR = 30;
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;

type Row = Record<string, unknown>;
type EligibleRow = Awaited<ReturnType<typeof listEligiblePaymentInvoices>>[number];

const SKIP_REASON: Partial<Record<PaymentState, string>> = {
  partly_paid: 'Partly paid in SAP, so it is not started automatically',
  paid: 'Fully paid in SAP',
  cancelled: 'Cancelled in SAP',
  unknown: 'SAP did not report a payment status',
  unavailable: 'SAP could not be read just now',
};

/** Whether the automatic start would begin a journey for this invoice. The reason is plain words for the confirm screen. */
export function decideAutoStart(row: Pick<EligibleRow, 'payment' | 'dueDate' | 'customerNumber'>, settings: Pick<AutoSettings, 'goLiveDate' | 'customers'>): { start: boolean; reason: string | null } {
  if (!settings.customers[row.customerNumber]) return { start: false, reason: 'This customer is not set to automatic' };
  if (row.payment !== 'not_paid') return { start: false, reason: SKIP_REASON[row.payment] ?? 'Not shown as unpaid in SAP' };
  if (settings.goLiveDate && row.dueDate < settings.goLiveDate) return { start: false, reason: `Reached its start day before the go-live date (${settings.goLiveDate})` };
  return { start: true, reason: null };
}

/** What switching one customer to automatic would do. Read-only; the customer is treated as automatic only for this answer. */
export async function previewAutoStart(customerNumber: string) {
  const [settings, rules, rows] = await Promise.all([getAutoSettings(), getReminderSettings(true), listEligiblePaymentInvoices()]);
  const hypothetical = { goLiveDate: settings.goLiveDate, customers: { ...settings.customers, [customerNumber]: { enabledAt: '', enabledBy: null } } };
  const mine = rows.filter((row) => row.customerNumber === customerNumber);
  const wouldStart: Array<{ invoiceNumber: string; invoiceDate: string; dueDate: string; amount: number; currency: string }> = [];
  const skipped: Array<{ invoiceNumber: string; invoiceDate: string; amount: number; currency: string; reason: string }> = [];
  for (const row of mine) {
    const decision = decideAutoStart(row, hypothetical);
    if (decision.start) wouldStart.push({ invoiceNumber: row.invoiceNumber, invoiceDate: row.invoiceDate, dueDate: row.dueDate, amount: row.amount, currency: row.currency });
    else skipped.push({ invoiceNumber: row.invoiceNumber, invoiceDate: row.invoiceDate, amount: row.amount, currency: row.currency, reason: decision.reason ?? 'Skipped' });
  }
  const last4 = mine[0]?.recipient ? String(mine[0].recipient).replace(/\D/g, '').slice(-4) : null;
  return {
    masterOn: settings.enabled, goLiveDate: settings.goLiveDate, alreadyAutomatic: Boolean(settings.customers[customerNumber]),
    serverCanSend: serverCanSendReminders(), toLast4: last4,
    timing: { dueDays: rules.dueDays, firstDelaySeconds: rules.firstReminderDelaySeconds, repeatDelaySeconds: rules.repeatReminderDelaySeconds, maximum: rules.maximumReminders },
    wouldStart, skipped,
  };
}

async function readSapHeader(number: string): Promise<Row | null> {
  const rows = await new SapODataClient().collection('API_BILLING_DOCUMENT_SRV', 'A_BillingDocument', { filter: `BillingDocument eq '${escapeODataString(number)}'`, top: 1 });
  return (rows[0] as Row | undefined) ?? null;
}

const failedAt = new Map<string, number>();

async function startedLastHour(): Promise<number> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error } = await getSupabaseServerClient().from('audit_logs').select('id', { count: 'exact', head: true })
    .eq('action', 'manual_payment_journey_started').eq('metadata->>username', AUTO_USER).gte('created_at', since);
  if (error) throw new Error('Unable to count recent automatic starts');
  return count ?? 0;
}

/** Starts journeys by itself for automatic customers, only for invoices SAP shows as not paid. Every normal start check still runs. */
export async function runAutoStart(): Promise<{ started: string[]; skipped: number }> {
  const settings = await getAutoSettings();
  if (!settings.enabled || Object.keys(settings.customers).length === 0 || !serverCanSendReminders()) return { started: [], skipped: 0 };
  const room = MAX_STARTS_PER_HOUR - await startedLastHour();
  if (room <= 0) { console.warn('Automatic payment reminders: hourly start limit reached'); return { started: [], skipped: 0 }; }
  const rows = await listEligiblePaymentInvoices();
  const todo = rows.filter((row) => decideAutoStart(row, settings).start && !((failedAt.get(row.invoiceNumber) ?? 0) > Date.now()));
  const started: string[] = [];
  for (const row of todo.slice(0, Math.min(MAX_STARTS_PER_RUN, room))) {
    try {
      // The list can be a few minutes old, so ask SAP again right before starting.
      const header = await readSapHeader(row.invoiceNumber);
      if (!header || paymentStateFromSap(header).state !== 'not_paid') continue;
      await startManualPaymentJourney(row.invoiceNumber, { confirmedUnpaid: true, outstandingAmount: row.amount, expectedDueDays: row.dueDays }, AUTO_USER);
      started.push(row.invoiceNumber);
    } catch (error) {
      failedAt.set(row.invoiceNumber, Date.now() + RETRY_AFTER_FAILURE_MS);
      console.error(`Automatic payment reminder could not start for ${row.invoiceNumber}:`, error instanceof Error ? error.message : error);
    }
  }
  if (started.length) console.log(`Automatic payment reminders started: ${started.join(', ')}`);
  return { started, skipped: todo.length - started.length };
}

/**
 * Looks at running journeys in SAP. Fully paid: the journey is closed as paid ("SAP shows cleared").
 * Partly paid after the journey began: it is paused for the team, because the amount in the message is now wrong.
 */
export async function syncJourneysWithSap(): Promise<{ cleared: number[]; held: number[] }> {
  const client = getSupabaseServerClient();
  const cases = await client.from('payment_follow_up_cases').select('id,invoice_id,status').in('status', ['active', 'paused']);
  if (cases.error) throw new Error('Unable to read running journeys');
  if (!cases.data?.length) return { cleared: [], held: [] };
  const invoiceIds = cases.data.map((row) => Number(row.invoice_id));
  const [receivables, invoices] = await Promise.all([
    client.from('invoice_receivables').select('invoice_id,raw_data').in('invoice_id', invoiceIds),
    client.from('invoices').select('id,sap_billing_document').in('id', invoiceIds),
  ]);
  if (receivables.error || invoices.error) throw new Error('Unable to read running journeys');
  const raw = new Map((receivables.data ?? []).map((row) => [Number(row.invoice_id), (row.raw_data ?? {}) as Row]));
  const number = new Map((invoices.data ?? []).map((row) => [Number(row.id), String(row.sap_billing_document)]));
  const work = cases.data.filter((row) => {
    const data = raw.get(Number(row.invoice_id));
    return data?.manual_payment_journey === true && !data.journey_hold && number.has(Number(row.invoice_id));
  });
  const cleared: number[] = [];
  const held: number[] = [];
  for (let start = 0; start < work.length; start += 4) {
    await Promise.all(work.slice(start, start + 4).map(async (row) => {
      const invoiceId = Number(row.invoice_id);
      try {
        const header = await readSapHeader(number.get(invoiceId)!);
        if (!header) return;
        const state = paymentStateFromSap(header).state;
        const data = raw.get(invoiceId)!;
        if (state === 'paid') {
          await markPaymentCasePaid(Number(row.id), undefined, { notes: 'SAP shows this invoice as fully paid' }, 'sap_cleared');
          cleared.push(Number(row.id));
        } else if (state === 'partly_paid' && data.sap_clearing_baseline === 'A') {
          await holdPaymentCase(Number(row.id), 'partly_paid_in_sap', { username: AUTO_USER });
          held.push(Number(row.id));
        } else if (data.sap_clearing_baseline === undefined && (state === 'not_paid' || state === 'partly_paid')) {
          // Journeys that began before this check existed: note what SAP shows now, so a later change can be recognised.
          await client.from('invoice_receivables').update({ raw_data: { ...data, sap_clearing_baseline: clearingLetter(header) } }).eq('invoice_id', invoiceId);
        }
      } catch (error) {
        console.error(`Could not check SAP payment status for journey ${row.id}:`, error instanceof Error ? error.message : error);
      }
    }));
  }
  if (cleared.length) console.log(`Journeys closed because SAP shows them paid: ${cleared.join(', ')}`);
  if (held.length) console.log(`Journeys paused because SAP shows them partly paid: ${held.join(', ')}`);
  return { cleared, held };
}

let lastRun = 0;
let running = false;

/** Called from the scheduler tick. At most one run at a time, at most once a minute. */
export async function runPaymentAutomationIfDue(): Promise<void> {
  if (running || Date.now() - lastRun < RUN_EVERY_MS) return;
  running = true;
  lastRun = Date.now();
  try {
    // Stopping a paid journey comes first and runs whether or not automatic start is on.
    await syncJourneysWithSap();
    await runAutoStart();
  } catch (error) {
    console.error('Payment automation failed', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}
