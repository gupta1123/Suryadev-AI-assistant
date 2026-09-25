import { apiRequest } from './api';
import { fetchAllPages } from './fetch-all';
import { relationOne, type DeliveryJob, type HelpRequest, type PaymentFollowUpCase } from '../types';

export type InboxKind = 'failed' | 'reply' | 'overdue';

export type InboxItem = {
  key: string;
  kind: InboxKind;
  at: string | null;
  customer: string;
  customerId?: number;
  title: string;
  detail: string;
  job?: DeliveryJob;
  help?: HelpRequest;
  paymentCase?: PaymentFollowUpCase;
};

type InboxSnapshot = { items: InboxItem[]; loadedAt: number };

const CACHE_MS = 30_000;
let cache: InboxSnapshot | null = null;
let inflight: Promise<InboxSnapshot> | null = null;
const listeners = new Set<(count: number) => void>();

/**
 * Builds one queue of everything that needs a person, from the existing endpoints:
 * failed sends, open help requests and overdue unpaid invoices.
 */
export async function loadInbox(force = false): Promise<InboxItem[]> {
  if (!force && cache && Date.now() - cache.loadedAt < CACHE_MS) return cache.items;
  if (!inflight) {
    inflight = fetchInbox()
      .then((snapshot) => {
        cache = snapshot;
        listeners.forEach((listener) => listener(snapshot.items.length));
        return snapshot;
      })
      .finally(() => { inflight = null; });
  }
  return (await inflight).items;
}

export function invalidateInbox() {
  cache = null;
}

export function subscribeInboxCount(listener: (count: number) => void): () => void {
  listeners.add(listener);
  if (cache) listener(cache.items.length);
  return () => { listeners.delete(listener); };
}

async function fetchInbox(): Promise<InboxSnapshot> {
  const [jobsResult, helpResult, casesResult] = await Promise.allSettled([
    fetchAllPages<DeliveryJob>('/invoice-delivery/jobs'),
    fetchAllPages<HelpRequest>('/invoice-delivery/help-requests'),
    apiRequest<PaymentFollowUpCase[]>('/payment-follow-up/cases'),
  ]);
  if (jobsResult.status === 'rejected' && helpResult.status === 'rejected' && casesResult.status === 'rejected') {
    throw jobsResult.reason;
  }
  const items: InboxItem[] = [];

  if (jobsResult.status === 'fulfilled') {
    for (const job of jobsResult.value.items) {
      const message = relationOne(job.messages);
      if ((message?.status ?? job.status).toLowerCase() !== 'failed') continue;
      const invoice = relationOne(job.invoices);
      items.push({
        key: `failed-${job.id}`,
        kind: 'failed',
        at: message?.failed_at ?? job.completed_at ?? job.created_at ?? job.scheduled_at,
        customer: relationOne(job.customers)?.display_name ?? 'Unknown customer',
        customerId: job.customer_id ?? relationOne(job.customers)?.id,
        title: `${invoice?.sap_billing_document ?? `Document #${job.id}`} wasn’t delivered`,
        detail: message?.failure_reason ?? job.last_error ?? 'No reason was given.',
        job,
      });
    }
  }

  if (helpResult.status === 'fulfilled') {
    for (const help of helpResult.value.items) {
      if (help.status === 'resolved') continue;
      items.push({
        key: `reply-${help.id}`,
        kind: 'reply',
        at: help.requestedAt,
        customer: help.customer?.name ?? 'Customer',
        customerId: help.customer?.id,
        title: help.status === 'in_progress' ? 'Asked for help · someone is on it' : 'Asked for help',
        detail: help.invoice?.billingDocument ? `About invoice ${help.invoice.billingDocument}` : 'Tapped “Need Help” on a message',
        help,
      });
    }
  }

  if (casesResult.status === 'fulfilled') {
    for (const paymentCase of casesResult.value) {
      const receivable = paymentCase.receivable;
      if (!receivable || paymentCase.resolved_at || receivable.outstanding_amount <= 0 || receivable.days_overdue <= 0) continue;
      items.push({
        key: `overdue-${paymentCase.id}`,
        kind: 'overdue',
        at: receivable.due_date ? `${receivable.due_date}T00:00:00Z` : paymentCase.updated_at,
        customer: paymentCase.customer?.display_name ?? 'Customer',
        customerId: paymentCase.customer?.id,
        title: `Invoice ${paymentCase.invoice?.sap_billing_document ?? ''} is ${receivable.days_overdue} ${receivable.days_overdue === 1 ? 'day' : 'days'} late`.replace('  ', ' '),
        detail: `${new Intl.NumberFormat('en-IN', { style: 'currency', currency: receivable.currency || 'INR' }).format(receivable.outstanding_amount)} still to pay`,
        paymentCase,
      });
    }
  }

  items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { items, loadedAt: Date.now() };
}
