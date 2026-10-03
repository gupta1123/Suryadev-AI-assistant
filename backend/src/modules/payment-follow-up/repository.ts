import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  env,
  isAllowedPaymentRecipient,
  isPaymentFollowUpTestConfigured,
  paymentTestRecipients,
} from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { persistInvoiceRecord, withDisplayRecipient } from '../invoice-delivery/repository.js';
import type { PaymentTestPreview, PaymentTestRunResult } from './domain.js';
import {
  assertAllowedPaymentRecipient,
  automaticPaymentCycleId,
  createScheduledPaymentReminderIdempotencyKey,
  paymentReminderDelayMs,
  withCurrentAging,
} from './policy.js';
import { formatPhone } from '../invoice-delivery/policy.js';
import { auditUserId, getReminderSettings } from './settings.js';
import { paymentDetailsForStorage, type PaymentDetails } from './payment-details.js';

const TEST_POLICY_NAME = 'Local controlled payment follow-up test';
const TEST_STAGE_CODE = 'due_today';

type PaymentConfiguration = {
  templateId: number;
  policyId: number;
  stageId: number;
};

export type PaymentScheduleResult = {
  enqueued: boolean;
  reason: 'not_due' | 'already_claimed' | 'payment_closed' | 'reminder_cap_reached' | 'duplicate' | 'enqueued';
  jobId?: number;
};

export async function preparePaymentEndToEndTest(
  preview: PaymentTestPreview,
  cycleId: string,
  startedBy?: string,
): Promise<PaymentTestRunResult> {
  assertAllowedPaymentRecipient(preview.recipient);
  const client = getSupabaseServerClient();
  const invoice = await persistInvoiceRecord(client, preview.candidate, preview.invoiceSource);
  const { data: existingCase, error: existingCaseError } = await client
    .from('payment_follow_up_cases')
    .select('id,status')
    .eq('invoice_id', invoice.invoiceId)
    .maybeSingle();
  if (existingCaseError) throw new Error(existingCaseError.message);
  if (existingCase) {
    const { data: existingReceivable, error: existingReceivableError } = await client
      .from('invoice_receivables')
      .select('raw_data')
      .eq('invoice_id', invoice.invoiceId)
      .maybeSingle();
    if (existingReceivableError) throw new Error(existingReceivableError.message);
    const existingMetadata =
      existingReceivable && isRecord(existingReceivable.raw_data)
        ? existingReceivable.raw_data
        : {};
    if (existingMetadata.payment_test_cycle_id === cycleId) {
      return {
        caseId: Number(existingCase.id),
        jobId: null,
        duplicate: true,
        status: String(existingCase.status),
      };
    }
    if (existingCase.status === 'active') {
      throw new HttpError(409, 'A controlled payment follow-up test is already active');
    }
  }
  const { data: pendingInvoiceJob, error: pendingInvoiceJobError } = await client
    .from('communication_jobs')
    .select('id')
    .eq('primary_invoice_id', invoice.invoiceId)
    .eq('job_type', 'manual_resend')
    .in('status', ['queued', 'processing'])
    .contains('metadata', { payment_e2e_test: true })
    .limit(1)
    .maybeSingle();
  if (pendingInvoiceJobError) throw new Error(pendingInvoiceJobError.message);
  if (pendingInvoiceJob) {
    throw new HttpError(409, 'The controlled invoice send is already in progress');
  }

  const runId = await createAgentRun(client, startedBy);

  try {
    const reminderSettings = await getReminderSettings();
    const configuration = await ensurePaymentConfiguration(client);
    const now = new Date().toISOString();
    const receivableValues = {
      invoice_id: invoice.invoiceId,
      original_amount: preview.receivable.originalAmount,
      outstanding_amount: preview.receivable.outstandingAmount,
      paid_amount: preview.receivable.paidAmount,
      currency: preview.receivable.currency,
      due_date: preview.receivable.dueDate,
      payment_status: preview.receivable.paymentStatus,
      aging_bucket: preview.receivable.agingBucket,
      days_overdue: preview.receivable.daysOverdue,
      last_synced_at: now,
      raw_data: {
        source: 'test_fixture',
        environment: 'deployed_controlled_test',
        reason: preview.invoiceSource === 'sap'
          ? 'SAP receivables API is not authorized in QAS'
          : 'Controlled simulated receivable for automated delivery testing',
        invoice_source: preview.invoiceSource,
        approved_recipient: preview.recipient,
        payment_test_cycle_id: cycleId,
        payment_handoff: 'waiting_for_invoice_sent_status',
      },
    };
    await requiredSingle(
      client
        .from('invoice_receivables')
        .upsert(receivableValues, { onConflict: 'invoice_id' })
        .select('invoice_id')
        .single(),
      'Unable to store the test receivable',
    );
    await requiredSingle(
      client
        .from('receivable_snapshots')
        .insert({
          invoice_id: invoice.invoiceId,
          observed_at: now,
          original_amount: preview.receivable.originalAmount,
          outstanding_amount: preview.receivable.outstandingAmount,
          paid_amount: preview.receivable.paidAmount,
          currency: preview.receivable.currency,
          due_date: preview.receivable.dueDate,
          payment_status: preview.receivable.paymentStatus,
          aging_bucket: preview.receivable.agingBucket,
          days_overdue: preview.receivable.daysOverdue,
          raw_data: receivableValues.raw_data,
        })
        .select('id')
        .single(),
      'Unable to create the receivable snapshot',
    );
    const paymentCase = await requiredSingle(
      client
        .from('payment_follow_up_cases')
        .upsert(
          {
            invoice_id: invoice.invoiceId,
            reminder_policy_id: configuration.policyId,
            current_stage_id: configuration.stageId,
            status: 'paused',
            next_action_at: null,
            paused_until: null,
            last_reminder_at: null,
            resolved_at: null,
          },
          { onConflict: 'invoice_id' },
        )
        .select('id')
        .single(),
      'Unable to create the payment follow-up case',
    );

    await client.from('audit_logs').insert({
      actor_type: 'agent',
      action: 'controlled_payment_e2e_test_prepared',
      entity_type: 'payment_follow_up_case',
      entity_id: String(paymentCase.id),
      after_data: {
        case_id: Number(paymentCase.id),
        invoice: preview.candidate.billingDocument,
        amount: preview.receivable.outstandingAmount,
        due_date: preview.receivable.dueDate,
        masked_recipient: preview.maskedRecipient,
        payment_test_cycle_id: cycleId,
        waiting_for: 'invoice_sent_status',
        first_delay_seconds: reminderSettings.firstReminderDelaySeconds,
        repeat_delay_seconds: reminderSettings.repeatReminderDelaySeconds,
      },
      metadata: { controlled_test: true, payment_test_cycle_id: cycleId },
    });
    await finishAgentRun(client, runId, 'succeeded', 1, 1, 0);
    return {
      caseId: Number(paymentCase.id),
      jobId: null,
      duplicate: false,
      status: 'waiting_for_invoice',
    };
  } catch (error) {
    await finishAgentRun(client, runId, 'failed', 1, 0, 1, errorMessage(error));
    throw error;
  }
}

export async function activatePaymentTestAfterInvoiceSent(
  preview: PaymentTestPreview,
  input: { cycleId: string; invoiceJobId: number; sentAt: string },
): Promise<{ caseId: number; firstActionAt: string; duplicate: boolean }> {
  assertAllowedPaymentRecipient(preview.recipient);
  const client = getSupabaseServerClient();
  const invoice = await persistInvoiceRecord(client, preview.candidate, preview.invoiceSource);
  return activatePreparedPaymentTestAfterInvoiceSent({
    ...input,
    invoiceId: invoice.invoiceId,
    recipient: preview.recipient,
  });
}

export async function activatePreparedPaymentTestAfterInvoiceSent(input: {
  cycleId: string;
  invoiceJobId: number;
  invoiceId: number;
  recipient: string;
  sentAt: string;
}): Promise<{ caseId: number; firstActionAt: string; duplicate: boolean }> {
  assertAllowedPaymentRecipient(input.recipient);
  const client = getSupabaseServerClient();
  const { data: invoiceJob, error: invoiceJobError } = await client
    .from('communication_jobs')
    .select('id,job_type,status,metadata')
    .eq('id', input.invoiceJobId)
    .eq('primary_invoice_id', input.invoiceId)
    .single();
  if (invoiceJobError || !invoiceJob) {
    throw new Error(invoiceJobError?.message ?? 'Controlled invoice job was not found');
  }
  const jobMetadata = isRecord(invoiceJob.metadata) ? invoiceJob.metadata : {};
  const isManualTestHandoff =
    invoiceJob.job_type === 'manual_resend' &&
    jobMetadata.payment_e2e_test === true &&
    jobMetadata.payment_test_cycle_id === input.cycleId;
  const isAutomaticInvoiceHandoff =
    invoiceJob.job_type === 'invoice_delivery' &&
    input.cycleId === automaticPaymentCycleId(Number(invoiceJob.id)) &&
    String(jobMetadata.actual_recipient ?? '').replace(/\D/g, '') === input.recipient;
  const isSimulatedInvoiceHandoff =
    invoiceJob.job_type === 'invoice_delivery' &&
    jobMetadata.payment_simulation_test === true &&
    jobMetadata.payment_test_cycle_id === input.cycleId &&
    String(jobMetadata.actual_recipient ?? '').replace(/\D/g, '') === input.recipient;
  if (
    invoiceJob.status !== 'completed' ||
    (!isManualTestHandoff && !isAutomaticInvoiceHandoff && !isSimulatedInvoiceHandoff)
  ) {
    throw new Error('Payment follow-up activation refused an invalid invoice handoff');
  }

  const { data: receivable, error: receivableError } = await client
    .from('invoice_receivables')
    .select('raw_data')
    .eq('invoice_id', input.invoiceId)
    .single();
  if (receivableError || !receivable) {
    throw new Error(receivableError?.message ?? 'Controlled receivable was not found');
  }
  const receivableMetadata = isRecord(receivable.raw_data) ? receivable.raw_data : {};
  if (receivableMetadata.payment_test_cycle_id !== input.cycleId) {
    throw new Error('Payment follow-up activation refused a stale test cycle');
  }

  const { data: paymentCase, error: caseError } = await client
    .from('payment_follow_up_cases')
    .select('id,status,next_action_at')
    .eq('invoice_id', input.invoiceId)
    .single();
  if (caseError || !paymentCase) {
    throw new Error(caseError?.message ?? 'Controlled payment case was not found');
  }
  if (paymentCase.status === 'active' && paymentCase.next_action_at) {
    return {
      caseId: Number(paymentCase.id),
      firstActionAt: String(paymentCase.next_action_at),
      duplicate: true,
    };
  }

  const sentAt = Date.parse(input.sentAt);
  if (!Number.isFinite(sentAt)) throw new Error('Invalid invoice sent timestamp');
  const reminderSettings = await getReminderSettings();
  const firstActionAt = new Date(
    sentAt + paymentReminderDelayMs(
      0,
      reminderSettings.firstReminderDelaySeconds,
      reminderSettings.repeatReminderDelaySeconds,
    ),
  ).toISOString();
  const { data: activated, error: updateError } = await client
    .from('payment_follow_up_cases')
    .update({
      status: 'active',
      next_action_at: firstActionAt,
      paused_until: null,
      last_reminder_at: null,
      resolved_at: null,
    })
    .eq('id', paymentCase.id)
    .eq('status', 'paused')
    .is('next_action_at', null)
    .select('id')
    .maybeSingle();
  if (updateError) throw new Error(`Unable to activate the payment schedule: ${updateError.message}`);
  if (!activated) {
    const { data: current, error: currentError } = await client
      .from('payment_follow_up_cases')
      .select('id,next_action_at')
      .eq('id', paymentCase.id)
      .single();
    if (currentError || !current?.next_action_at) {
      throw new Error(currentError?.message ?? 'Payment schedule activation was not applied');
    }
    return {
      caseId: Number(current.id),
      firstActionAt: String(current.next_action_at),
      duplicate: true,
    };
  }
  await client.from('audit_logs').insert({
    actor_type: 'agent',
    action: 'controlled_payment_schedule_activated_after_invoice_sent',
    entity_type: 'payment_follow_up_case',
    entity_id: String(paymentCase.id),
    after_data: {
      invoice_job_id: input.invoiceJobId,
      invoice_sent_at: input.sentAt,
      first_action_at: firstActionAt,
      first_delay_seconds: reminderSettings.firstReminderDelaySeconds,
      payment_test_cycle_id: input.cycleId,
    },
    metadata: { controlled_test: true, payment_test_cycle_id: input.cycleId },
  });
  return { caseId: Number(paymentCase.id), firstActionAt, duplicate: false };
}

export async function listPaymentCases(): Promise<Record<string, unknown>[]> {
  const client = getSupabaseServerClient();
  const { data: cases, error } = await client
    .from('payment_follow_up_cases')
    .select('id,invoice_id,status,next_action_at,last_reminder_at,resolved_at,created_at,updated_at')
    .order('id', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Unable to load payment follow-up cases: ${error.message}`);
  if (!cases?.length) return [];
  const invoiceIds = cases.map((row) => Number(row.invoice_id));
  const caseIds = cases.map((row) => Number(row.id));
  const [invoiceResult, receivableResult, jobsResult] = await Promise.all([
    client
      .from('invoices')
      .select('id,sap_billing_document,billing_document_date,transaction_currency,total_gross_amount,sold_to_customer_id')
      .in('id', invoiceIds),
    client
      .from('invoice_receivables')
      .select('invoice_id,original_amount,outstanding_amount,paid_amount,currency,due_date,payment_status,aging_bucket,days_overdue,last_synced_at,raw_data')
      .in('invoice_id', invoiceIds),
    client
      .from('communication_jobs')
      .select('id,payment_follow_up_case_id,status,attempt_count,last_error,completed_at,created_at,metadata,messages(id,status,sent_at,delivered_at,read_at,failed_at,failure_reason)')
      .eq('job_type', 'payment_reminder')
      .in('payment_follow_up_case_id', caseIds)
      .order('id', { ascending: false }),
  ]);
  const firstError = invoiceResult.error ?? receivableResult.error ?? jobsResult.error;
  if (firstError) throw new Error(`Unable to load payment follow-up details: ${firstError.message}`);
  const customerIds = (invoiceResult.data ?? []).map((row) => Number(row.sold_to_customer_id));
  const { data: customers, error: customerError } = await client
    .from('customers')
    .select('id,sap_customer_number,display_name')
    .in('id', customerIds);
  if (customerError) throw new Error(`Unable to load payment customers: ${customerError.message}`);

  const invoices = new Map((invoiceResult.data ?? []).map((row) => [Number(row.id), row]));
  const receivables = new Map((receivableResult.data ?? []).map((row) => [Number(row.invoice_id), withCurrentAging(row)]));
  const customerMap = new Map((customers ?? []).map((row) => [Number(row.id), row]));
  const caseCycles = new Map(
    cases.map((paymentCase) => [
      Number(paymentCase.id),
      currentCycleId(receivables.get(Number(paymentCase.invoice_id))),
    ]),
  );
  const latestJobs = new Map<number, Record<string, unknown>>();
  for (const job of jobsResult.data ?? []) {
    const caseId = Number(job.payment_follow_up_case_id);
    if (!latestJobs.has(caseId) && inCycle(job, caseCycles.get(caseId))) latestJobs.set(caseId, job);
  }

  return cases.map((paymentCase) => {
    const invoice = invoices.get(Number(paymentCase.invoice_id));
    const customer = invoice ? customerMap.get(Number(invoice.sold_to_customer_id)) : undefined;
    const job = latestJobs.get(Number(paymentCase.id));
    return {
      ...paymentCase,
      invoice: invoice ?? null,
      customer: customer ?? null,
      receivable: receivables.get(Number(paymentCase.invoice_id)) ?? null,
      latestJob: job ? sanitizeJob(job) : null,
    };
  });
}

// A demo invoice can be run many times. Each run stores its cycle ID on the
// receivable, so only that run's reminders belong to the case as shown today.
function currentCycleId(receivable: Record<string, unknown> | undefined): string | undefined {
  const rawData = receivable && isRecord(receivable.raw_data) ? receivable.raw_data : {};
  return typeof rawData.payment_test_cycle_id === 'string' ? rawData.payment_test_cycle_id : undefined;
}

function inCycle(job: Record<string, unknown>, cycleId: string | undefined): boolean {
  if (!cycleId) return true;
  return isRecord(job.metadata) && job.metadata.payment_test_cycle_id === cycleId;
}

export async function getPaymentCase(caseId: number): Promise<Record<string, unknown>> {
  const client = getSupabaseServerClient();
  const { data: paymentCase, error: caseError } = await client
    .from('payment_follow_up_cases')
    .select('id,invoice_id,status,next_action_at,last_reminder_at,resolved_at,created_at,updated_at')
    .eq('id', caseId)
    .maybeSingle();
  if (caseError) throw new Error(`Unable to load the payment follow-up case: ${caseError.message}`);
  if (!paymentCase) throw new HttpError(404, 'Payment follow-up case not found');

  const invoiceId = Number(paymentCase.invoice_id);
  const [invoiceResult, receivableResult, jobsResult] = await Promise.all([
    client
      .from('invoices')
      .select('id,sap_billing_document,billing_document_date,transaction_currency,total_gross_amount,sold_to_customer_id')
      .eq('id', invoiceId)
      .maybeSingle(),
    client
      .from('invoice_receivables')
      .select('invoice_id,original_amount,outstanding_amount,paid_amount,currency,due_date,payment_status,aging_bucket,days_overdue,last_synced_at,raw_data')
      .eq('invoice_id', invoiceId)
      .maybeSingle(),
    client
      .from('communication_jobs')
      .select(
        'id,status,attempt_count,max_attempts,last_error,completed_at,created_at,metadata,messages(id,status,body,provider_message_id,sent_at,delivered_at,read_at,failed_at,failure_reason,message_attempts(id,attempt_number,status,provider_request_id,response_status,error_code,error_message,started_at,finished_at))',
      )
      .eq('job_type', 'payment_reminder')
      .eq('payment_follow_up_case_id', caseId)
      .order('id', { ascending: false }),
  ]);
  const firstError = invoiceResult.error ?? receivableResult.error ?? jobsResult.error;
  if (firstError) throw new Error(`Unable to load payment follow-up details: ${firstError.message}`);

  const invoice = invoiceResult.data ?? null;
  const receivable = receivableResult.data ? withCurrentAging(receivableResult.data) : undefined;
  const jobs = jobsResult.data ?? [];
  const currentJobs = (jobs ?? []).filter((job) => inCycle(job, currentCycleId(receivable)));
  const rawData = receivable && isRecord(receivable.raw_data) ? receivable.raw_data : {};
  const running =
    paymentCase.status === 'active' ||
    currentJobs.some((job) => ACTIVE_JOB_STATUSES.includes(String(job.status)));
  const customerId = invoice ? Number(invoice.sold_to_customer_id) : 0;
  const [customerResult, restartRecipient] = await Promise.all([
    customerId
      ? client
        .from('customers')
        .select('id,sap_customer_number,display_name')
        .eq('id', customerId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    running || !receivable || !customerId
      ? null
      : findRestartRecipient(client, customerId, rawData),
  ]);
  if (customerResult.error) throw new Error(`Unable to load the payment customer: ${customerResult.error.message}`);
  const sentTo = currentJobs
    .map((job) => (isRecord(job.metadata) ? String(job.metadata.actual_recipient ?? '') : ''))
    .find(Boolean);
  let whatsappNumber =
    String(rawData.approved_recipient ?? '') ||
    sentTo ||
    restartRecipient?.recipient || '';
  if (!whatsappNumber && customerId) whatsappNumber = await findCustomerWhatsapp(client, customerId);
  return {
    ...paymentCase,
    invoice,
    customer: customerResult.data ?? null,
    receivable: receivable ?? null,
    latestJob: currentJobs[0] ? sanitizeJob(currentJobs[0]) : null,
    jobs: currentJobs.map(sanitizeJob),
    restartable: Boolean(restartRecipient),
    whatsappNumber: whatsappNumber ? formatPhone(whatsappNumber) : null,
  };
}

async function findCustomerWhatsapp(client: SupabaseClient, customerId: number): Promise<string> {
  const { data, error } = await client
    .from('customer_contacts')
    .select('normalized_value')
    .eq('customer_id', customerId)
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Unable to load the customer's WhatsApp number: ${error.message}`);
  return data ? String(data.normalized_value) : '';
}

// The number a restarted run will message: the one this invoice already used,
// or else the customer's active WhatsApp contact, and only if it is approved.
async function findRestartRecipient(
  client: SupabaseClient,
  customerId: number,
  rawData: Record<string, unknown>,
): Promise<{ recipient: string; contactId: number } | null> {
  const { data: contacts, error } = await client
    .from('customer_contacts')
    .select('id,normalized_value,is_primary')
    .eq('customer_id', customerId)
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .eq('do_not_contact', false)
    .order('is_primary', { ascending: false });
  if (error) throw new Error(`Unable to check the customer's WhatsApp contacts: ${error.message}`);
  const approved = (contacts ?? []).filter((contact) => isAllowedPaymentRecipient(String(contact.normalized_value)));
  const previous = String(rawData.approved_recipient ?? '');
  const chosen = approved.find((contact) => contact.normalized_value === previous) ?? approved[0];
  return chosen ? { recipient: String(chosen.normalized_value), contactId: Number(chosen.id) } : null;
}

const ACTIVE_JOB_STATUSES = ['pending', 'awaiting_approval', 'queued', 'processing'];

// Demo helper: set a stored invoice back to unpaid and start a fresh reminder
// run from now. Nothing is fetched from SAP and the invoice is not re-sent.
export async function restartPaymentCase(
  caseId: number,
  restartedBy?: { id: string; username: string },
): Promise<Record<string, unknown>> {
  const current = await getPaymentCase(caseId);
  if (!current.restartable) {
    throw new HttpError(
      409,
      current.status === 'active'
        ? 'Reminders are still running for this invoice. Mark it as paid or wait for the last reminder first.'
        : 'Reminders cannot be restarted for this invoice because the customer has no approved test WhatsApp number.',
    );
  }
  const client = getSupabaseServerClient();
  const invoiceId = Number(current.invoice_id);
  const { data: receivable, error: receivableError } = await client
    .from('invoice_receivables')
    .select('original_amount,currency,due_date,raw_data')
    .eq('invoice_id', invoiceId)
    .single();
  if (receivableError || !receivable) {
    throw new Error(`Unable to load the receivable: ${receivableError?.message ?? 'Receivable not found'}`);
  }
  const { payment_confirmation: _previousConfirmation, ...previousRawData } =
    isRecord(receivable.raw_data) ? receivable.raw_data : {};
  const invoice = isRecord(current.invoice) ? current.invoice : {};
  const target = await findRestartRecipient(client, Number(invoice.sold_to_customer_id), previousRawData);
  if (!target) {
    throw new HttpError(409, 'This customer has no active WhatsApp contact on the approved test numbers.');
  }
  const recipient = target.recipient;
  assertAllowedPaymentRecipient(recipient);

  const now = new Date();
  const cycleId = `restart-${caseId}-${randomUUID()}`;
  const rawData = {
    ...previousRawData,
    approved_recipient: recipient,
    payment_test_cycle_id: cycleId,
    restarted_at: now.toISOString(),
    restarted_by: restartedBy?.username ?? null,
  };
  const unpaid = withCurrentAging({
    due_date: receivable.due_date,
    outstanding_amount: Number(receivable.original_amount),
  });
  const receivableValues = {
    outstanding_amount: receivable.original_amount,
    paid_amount: 0,
    payment_status: 'open',
    aging_bucket: unpaid.aging_bucket,
    days_overdue: unpaid.days_overdue,
  };
  const { error: updateError } = await client
    .from('invoice_receivables')
    .update({
      ...receivableValues,
      payment_detected_at: null,
      last_synced_at: now.toISOString(),
      raw_data: rawData,
    })
    .eq('invoice_id', invoiceId);
  if (updateError) throw new Error(`Unable to reset the invoice to unpaid: ${updateError.message}`);
  const { error: snapshotError } = await client.from('receivable_snapshots').insert({
    invoice_id: invoiceId,
    observed_at: now.toISOString(),
    original_amount: receivable.original_amount,
    currency: receivable.currency,
    due_date: receivable.due_date,
    ...receivableValues,
    raw_data: rawData,
  });
  if (snapshotError) throw new Error(`Unable to record the restart snapshot: ${snapshotError.message}`);

  const reminderSettings = await getReminderSettings();
  const firstActionAt = new Date(
    now.getTime() + reminderSettings.firstReminderDelaySeconds * 1000,
  ).toISOString();
  const { data: restarted, error: caseError } = await client
    .from('payment_follow_up_cases')
    .update({
      status: 'active',
      next_action_at: firstActionAt,
      paused_until: null,
      last_reminder_at: null,
      resolved_at: null,
    })
    .eq('id', caseId)
    .neq('status', 'active')
    .select('id')
    .maybeSingle();
  if (caseError) throw new Error(`Unable to restart payment reminders: ${caseError.message}`);
  if (!restarted) throw new HttpError(409, 'Reminders were already restarted for this invoice.');

  await client.from('audit_logs').insert({
    actor_type: 'user',
    actor_user_id: auditUserId(restartedBy?.id),
    action: 'payment_reminders_restarted',
    entity_type: 'payment_follow_up_case',
    entity_id: String(caseId),
    before_data: { status: current.status },
    after_data: { status: 'active', first_action_at: firstActionAt, payment_test_cycle_id: cycleId },
    metadata: { controlled_test: true, username: restartedBy?.username ?? null },
  });
  return getPaymentCase(caseId);
}

export async function markPaymentReminderAwaitingSent(
  caseId: number,
  cycleId: string,
  jobId: number,
): Promise<void> {
  const client = getSupabaseServerClient();
  const { error } = await client
    .from('payment_follow_up_cases')
    .update({ status: 'paused', next_action_at: null, paused_until: null })
    .eq('id', caseId)
    .neq('status', 'resolved');
  if (error) throw new Error(`Unable to pause payment follow-up until sent status: ${error.message}`);
  await client.from('audit_logs').insert({
    actor_type: 'agent',
    action: 'controlled_payment_reminder_awaiting_sent_status',
    entity_type: 'payment_follow_up_case',
    entity_id: String(caseId),
    after_data: { reminder_job_id: jobId },
    metadata: { controlled_test: true, payment_test_cycle_id: cycleId },
  });
}

export async function scheduleNextPaymentReminderFromSentAt(
  caseId: number,
  cycleId: string,
  jobId: number,
  sentAt: string,
): Promise<{ duplicate: boolean; capped: boolean; nextActionAt: string | null }> {
  const parsedSentAt = Date.parse(sentAt);
  if (!Number.isFinite(parsedSentAt)) throw new Error('Invalid payment reminder sent timestamp');
  const client = getSupabaseServerClient();
  const { data: job, error: jobError } = await client
    .from('communication_jobs')
    .select('id,job_type,payment_follow_up_case_id,status,metadata')
    .eq('id', jobId)
    .eq('job_type', 'payment_reminder')
    .eq('payment_follow_up_case_id', caseId)
    .single();
  if (jobError || !job) {
    throw new Error(jobError?.message ?? 'Payment reminder job was not found for sent handoff');
  }
  const jobMetadata = isRecord(job.metadata) ? job.metadata : {};
  if (
    job.status !== 'completed' ||
    jobMetadata.payment_test_cycle_id !== cycleId
  ) {
    throw new Error('Payment reminder sent handoff failed its controlled test boundary');
  }
  const { data: paymentCase, error: caseError } = await client
    .from('payment_follow_up_cases')
    .select('id,last_reminder_at,next_action_at,status')
    .eq('id', caseId)
    .single();
  if (caseError || !paymentCase) {
    throw new Error(caseError?.message ?? 'Payment follow-up case was not found');
  }
  if (paymentCase.status === 'resolved') {
    return { duplicate: true, capped: false, nextActionAt: null };
  }
  if (paymentCase.status === 'active' && paymentCase.next_action_at) {
    return {
      duplicate: true,
      capped: false,
      nextActionAt: String(paymentCase.next_action_at),
    };
  }
  const previousSentAt = paymentCase.last_reminder_at
    ? Date.parse(String(paymentCase.last_reminder_at))
    : Number.NaN;
  if (Number.isFinite(previousSentAt) && previousSentAt >= parsedSentAt) {
    return {
      duplicate: true,
      capped: paymentCase.status === 'paused' && !paymentCase.next_action_at,
      nextActionAt: paymentCase.next_action_at ? String(paymentCase.next_action_at) : null,
    };
  }
  const { count, error: countError } = await client
    .from('communication_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('job_type', 'payment_reminder')
    .eq('payment_follow_up_case_id', caseId)
    .contains('metadata', { payment_test_cycle_id: cycleId });
  if (countError) throw new Error(`Unable to count payment reminders: ${countError.message}`);
  const reminderCount = count ?? 0;
  const reminderSettings = await getReminderSettings();
  const capped = reminderCount >= reminderSettings.maximumReminders;
  const next = new Date(parsedSentAt + reminderSettings.repeatReminderDelaySeconds * 1000);
  const { error } = await client
    .from('payment_follow_up_cases')
    .update({
      last_reminder_at: new Date(parsedSentAt).toISOString(),
      next_action_at: capped ? null : next.toISOString(),
      status: capped ? 'paused' : 'active',
      paused_until: null,
    })
    .eq('id', caseId)
    .neq('status', 'resolved');
  if (error) throw new Error(`Unable to update the payment follow-up schedule: ${error.message}`);
  await client.from('audit_logs').insert({
    actor_type: 'agent',
    action: capped ? 'controlled_payment_test_cap_reached' : 'controlled_payment_reminder_rescheduled',
    entity_type: 'payment_follow_up_case',
    entity_id: String(caseId),
    after_data: {
      reminder_count: reminderCount,
      reminder_job_id: jobId,
      reminder_sent_at: new Date(parsedSentAt).toISOString(),
      next_action_at: capped ? null : next.toISOString(),
      repeat_delay_seconds: reminderSettings.repeatReminderDelaySeconds,
    },
    metadata: {
      controlled_test: true,
      payment_test_cycle_id: cycleId,
      reminder_job_id: jobId,
    },
  });
  return {
    duplicate: false,
    capped,
    nextActionAt: capped ? null : next.toISOString(),
  };
}

export async function markPaymentCasePaid(
  caseId: number,
  markedBy?: { id: string; username: string },
  paymentDetails: PaymentDetails = {},
): Promise<Record<string, unknown>> {
  const client = getSupabaseServerClient();
  const { data: paymentCase, error: caseError } = await client
    .from('payment_follow_up_cases')
    .select('id,invoice_id,status')
    .eq('id', caseId)
    .maybeSingle();
  if (caseError) throw new Error(`Unable to load the payment case: ${caseError.message}`);
  if (!paymentCase) throw new HttpError(404, 'Payment follow-up case not found');
  if (paymentCase.status === 'resolved') return getPaymentCase(caseId);

  const markedAt = new Date().toISOString();
  const { data: resolved, error: resolveError } = await client
    .from('payment_follow_up_cases')
    .update({ status: 'resolved', next_action_at: null, paused_until: null, resolved_at: markedAt })
    .eq('id', caseId)
    .neq('status', 'resolved')
    .select('id')
    .maybeSingle();
  if (resolveError) throw new Error(`Unable to stop payment reminders: ${resolveError.message}`);
  if (!resolved) return getPaymentCase(caseId);

  const [cancelResult, receivableResult] = await Promise.all([
    client
      .from('communication_jobs')
      .update({ status: 'cancelled', last_error: 'Invoice marked as paid' })
      .eq('job_type', 'payment_reminder')
      .eq('payment_follow_up_case_id', caseId)
      .in('status', ['pending', 'awaiting_approval', 'queued'])
      .select('id'),
    client
      .from('invoice_receivables')
      .select('original_amount,outstanding_amount,currency,due_date,raw_data')
      .eq('invoice_id', paymentCase.invoice_id)
      .maybeSingle(),
  ]);
  const { data: cancelledJobs, error: cancelError } = cancelResult;
  if (cancelError) throw new Error(`Unable to cancel queued payment reminders: ${cancelError.message}`);
  const { data: receivable, error: receivableError } = receivableResult;
  if (receivableError) throw new Error(`Unable to load the receivable: ${receivableError.message}`);
  if (receivable) {
    const rawData = {
      ...(isRecord(receivable.raw_data) ? receivable.raw_data : {}),
      payment_confirmation: {
        source: 'marked_paid_in_dashboard',
        marked_by: markedBy?.username ?? null,
        confirmed_at: markedAt,
        outstanding_before: Number(receivable.outstanding_amount),
        ...paymentDetailsForStorage(paymentDetails),
      },
    };
    const settledValues = {
      outstanding_amount: 0,
      paid_amount: receivable.original_amount,
      payment_status: 'paid',
      aging_bucket: 'closed',
      days_overdue: 0,
    };
    const { error: updateError } = await client
      .from('invoice_receivables')
      .update({ ...settledValues, payment_detected_at: markedAt, last_synced_at: markedAt, raw_data: rawData })
      .eq('invoice_id', paymentCase.invoice_id);
    if (updateError) throw new Error(`Unable to mark the invoice paid: ${updateError.message}`);
    const { error: snapshotError } = await client.from('receivable_snapshots').insert({
      invoice_id: paymentCase.invoice_id,
      observed_at: markedAt,
      original_amount: receivable.original_amount,
      currency: receivable.currency,
      due_date: receivable.due_date,
      ...settledValues,
      raw_data: rawData,
    });
    if (snapshotError) throw new Error(`Unable to record the paid snapshot: ${snapshotError.message}`);
  }

  const [updatedCase] = await Promise.all([
    getPaymentCase(caseId),
    client.from('audit_logs').insert({
      actor_type: 'user',
      actor_user_id: auditUserId(markedBy?.id),
      action: 'payment_marked_paid',
      entity_type: 'payment_follow_up_case',
      entity_id: String(caseId),
      before_data: {
        status: paymentCase.status,
        outstanding_amount: receivable ? Number(receivable.outstanding_amount) : null,
      },
      after_data: {
        status: 'resolved',
        resolved_at: markedAt,
        cancelled_reminder_job_ids: (cancelledJobs ?? []).map((job) => Number(job.id)),
        payment_details: paymentDetailsForStorage(paymentDetails),
      },
      metadata: { username: markedBy?.username ?? null },
    }),
  ]);
  return updatedCase;
}

export async function isPaymentCaseResolved(caseId: number): Promise<boolean> {
  const { data, error } = await getSupabaseServerClient()
    .from('payment_follow_up_cases')
    .select('status')
    .eq('id', caseId)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Payment follow-up case was not found');
  return data.status === 'resolved';
}

export async function skipResolvedPaymentReminderJob(jobId: number): Promise<void> {
  const { error } = await getSupabaseServerClient()
    .from('communication_jobs')
    .update({
      status: 'skipped',
      last_error: 'Invoice was marked as paid before this reminder was sent',
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);
  if (error) throw new Error(`Unable to skip the payment reminder: ${error.message}`);
}

// A reminder's "sent" status can be applied by any backend sharing this
// database, including one that does not schedule this case. If a delivered
// reminder never got its follow-up scheduled, schedule it here.
export async function repairStalledPaymentSchedules(now = new Date()): Promise<number[]> {
  const client = getSupabaseServerClient();
  const { data: cases, error } = await client
    .from('payment_follow_up_cases')
    .select('id,invoice_id,last_reminder_at')
    .eq('status', 'paused')
    .is('next_action_at', null);
  if (error) throw new Error(`Unable to check paused payment cases: ${error.message}`);
  const repaired: number[] = [];
  const recentCutoff = now.getTime() - 24 * 60 * 60 * 1000;
  for (const paymentCase of cases ?? []) {
    const { data: receivable } = await client
      .from('invoice_receivables')
      .select('raw_data')
      .eq('invoice_id', paymentCase.invoice_id)
      .maybeSingle();
    const rawData = receivable && isRecord(receivable.raw_data) ? receivable.raw_data : {};
    const cycleId = typeof rawData.payment_test_cycle_id === 'string' ? rawData.payment_test_cycle_id : '';
    if (!cycleId || !isAllowedPaymentRecipient(String(rawData.approved_recipient ?? ''))) continue;

    const { data: job } = await client
      .from('communication_jobs')
      .select('id,status,messages(sent_at)')
      .eq('job_type', 'payment_reminder')
      .eq('payment_follow_up_case_id', paymentCase.id)
      .contains('metadata', { payment_test_cycle_id: cycleId })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    const message = Array.isArray(job?.messages) ? job.messages[0] : job?.messages;
    const sentAt = message?.sent_at ? String(message.sent_at) : '';
    if (!job || job.status !== 'completed' || !sentAt) continue;
    const sentTime = Date.parse(sentAt);
    const lastReminderTime = paymentCase.last_reminder_at ? Date.parse(String(paymentCase.last_reminder_at)) : Number.NaN;
    if (sentTime < recentCutoff || (Number.isFinite(lastReminderTime) && lastReminderTime >= sentTime)) continue;

    const result = await scheduleNextPaymentReminderFromSentAt(Number(paymentCase.id), cycleId, Number(job.id), sentAt);
    if (!result.duplicate) repaired.push(Number(paymentCase.id));
  }
  return repaired;
}

export async function preparePaymentTestSchedule(): Promise<void> {
  assertLocalPaymentSchedulerBoundary();
  const client = getSupabaseServerClient();
  const invoice = await findConfiguredTestInvoice(client);
  if (!invoice) return;
  const cycleId = await getPaymentTestCycleId(client, Number(invoice.id));
  if (!cycleId) return;
  const { data: paymentCase, error: caseError } = await client
    .from('payment_follow_up_cases')
    .select('id,status,last_reminder_at,next_action_at')
    .eq('invoice_id', invoice.id)
    .maybeSingle();
  if (caseError) throw new Error(`Unable to load the controlled payment case: ${caseError.message}`);
  if (!paymentCase || paymentCase.status === 'resolved') return;
  const reminderCount = await countPaymentReminders(client, Number(paymentCase.id), cycleId);
  const reminderSettings = await getReminderSettings();
  if (reminderCount >= reminderSettings.maximumReminders) {
    const { error } = await client
      .from('payment_follow_up_cases')
      .update({ status: 'paused', next_action_at: null, paused_until: null })
      .eq('id', paymentCase.id);
    if (error) throw new Error(`Unable to stop the completed controlled payment test: ${error.message}`);
    return;
  }
  if (!paymentCase.last_reminder_at) return;
  const now = Date.now();
  const intervalMs = paymentReminderDelayMs(
    reminderCount,
    reminderSettings.firstReminderDelaySeconds,
    reminderSettings.repeatReminderDelaySeconds,
  );
  const currentNextAction = paymentCase.next_action_at
    ? Date.parse(String(paymentCase.next_action_at))
    : Number.NaN;
  const scheduleUsesOldInterval =
    !Number.isFinite(currentNextAction) || currentNextAction > now + intervalMs * 2;
  const nextActionAt = scheduleUsesOldInterval
    ? new Date(now + intervalMs).toISOString()
    : String(paymentCase.next_action_at);
  const { error } = await client
    .from('payment_follow_up_cases')
    .update({ status: 'active', next_action_at: nextActionAt, paused_until: null })
    .eq('id', paymentCase.id)
    .neq('status', 'resolved');
  if (error) throw new Error(`Unable to prepare the controlled payment schedule: ${error.message}`);
}

export async function enqueueNextDuePaymentReminder(): Promise<PaymentScheduleResult> {
  assertLocalPaymentSchedulerBoundary();
  const client = getSupabaseServerClient();
  const now = new Date();
  let caseQuery = client
    .from('payment_follow_up_cases')
    .select('id,invoice_id,status,next_action_at')
    .eq('status', 'active')
    .lte('next_action_at', now.toISOString())
    .order('next_action_at', { ascending: true })
    .limit(1);
  const { data: eligibleReceivables, error: eligibleError } = await client
    .from('invoice_receivables')
    .select('invoice_id,raw_data');
  if (eligibleError) {
    throw new Error(`Unable to identify controlled payment receivables: ${eligibleError.message}`);
  }
  const eligibleInvoiceIds = (eligibleReceivables ?? [])
    .filter((row) => isRecord(row.raw_data) && isAllowedPaymentRecipient(String(row.raw_data.approved_recipient ?? '')))
    .map((row) => Number(row.invoice_id));
  if (eligibleInvoiceIds.length === 0) return { enqueued: false, reason: 'not_due' };
  caseQuery = caseQuery.in('invoice_id', eligibleInvoiceIds);
  const { data: paymentCase, error: caseError } = await caseQuery.maybeSingle();
  if (caseError) throw new Error(`Unable to inspect the payment schedule: ${caseError.message}`);
  if (!paymentCase?.next_action_at) return { enqueued: false, reason: 'not_due' };
  const { data: invoice, error: invoiceError } = await client
    .from('invoices')
    .select('id,sap_billing_document,sold_to_customer_id')
    .eq('id', paymentCase.invoice_id)
    .single();
  if (invoiceError || !invoice) {
    throw new Error(`Unable to load the due payment invoice: ${invoiceError?.message ?? 'Invoice not found'}`);
  }

  const { data: receivable, error: receivableError } = await client
    .from('invoice_receivables')
    .select('original_amount,outstanding_amount,paid_amount,currency,due_date,payment_status,aging_bucket,days_overdue,raw_data')
    .eq('invoice_id', invoice.id)
    .single();
  if (receivableError || !receivable) {
    throw new Error(`Unable to recheck the receivable before sending: ${receivableError?.message ?? 'Receivable not found'}`);
  }
  const status = String(receivable.payment_status);
  const outstandingAmount = Number(receivable.outstanding_amount);
  const currentAging = withCurrentAging(receivable);
  const receivableMetadata = isRecord(receivable.raw_data) ? receivable.raw_data : {};
  const cycleId = String(receivableMetadata.payment_test_cycle_id ?? '');
  if (!cycleId) {
    throw new Error('Controlled payment cycle is missing from the receivable status');
  }
  const approvedRecipient = String(receivableMetadata.approved_recipient ?? '').replace(/\D/g, '');
  const isSimulatedPaymentTest = receivableMetadata.invoice_source === 'fixture';
  if (!isAllowedPaymentRecipient(approvedRecipient)) {
    throw new Error('Controlled payment schedule refused a case outside the approved test boundary');
  }
  await client.from('audit_logs').insert({
    actor_type: 'agent',
    action: 'controlled_payment_status_checked',
    entity_type: 'payment_follow_up_case',
    entity_id: String(paymentCase.id),
    after_data: { payment_status: status, outstanding_amount: outstandingAmount },
    metadata: {
      controlled_test: true,
      scheduled_for: String(paymentCase.next_action_at),
      payment_test_cycle_id: cycleId,
    },
  });
  if (['paid', 'written_off', 'cancelled'].includes(status) || outstandingAmount <= 0) {
    const { error } = await client
      .from('payment_follow_up_cases')
      .update({ status: 'resolved', next_action_at: null, resolved_at: now.toISOString() })
      .eq('id', paymentCase.id);
    if (error) throw new Error(`Unable to resolve the paid case: ${error.message}`);
    return { enqueued: false, reason: 'payment_closed' };
  }

  const caseId = Number(paymentCase.id);
  const reminderCount = await countPaymentReminders(client, caseId, cycleId);
  const reminderSettings = await getReminderSettings();
  if (reminderCount >= reminderSettings.maximumReminders) {
    await pausePaymentTestAtCap(client, caseId, reminderCount, reminderSettings.maximumReminders, cycleId);
    return { enqueued: false, reason: 'reminder_cap_reached' };
  }

  const scheduledFor = String(paymentCase.next_action_at);
  const claimUntil = new Date(now.getTime() + 60_000).toISOString();
  const { data: claimed, error: claimError } = await client
    .from('payment_follow_up_cases')
    .update({ next_action_at: claimUntil })
    .eq('id', caseId)
    .eq('status', 'active')
    .eq('next_action_at', scheduledFor)
    .select('id')
    .maybeSingle();
  if (claimError) throw new Error(`Unable to claim the scheduled payment case: ${claimError.message}`);
  if (!claimed) return { enqueued: false, reason: 'already_claimed' };

  const runId = await createAgentRun(client, undefined, 'scheduled');
  try {
    const customerId = Number(invoice.sold_to_customer_id);
    const { data: contact, error: contactError } = await client
      .from('customer_contacts')
      .select('id,normalized_value')
      .eq('customer_id', customerId)
      .eq('channel', 'whatsapp')
      .eq('normalized_value', approvedRecipient)
      .eq('is_active', true)
      .eq('do_not_contact', false)
      .maybeSingle();
    if (contactError || !contact) {
      throw new Error(`Approved SAP customer contact is unavailable: ${contactError?.message ?? 'Contact not found'}`);
    }
    assertAllowedPaymentRecipient(String(contact.normalized_value));

    const configuration = await ensurePaymentConfiguration(client);

    const snapshot = await requiredSingle(
      client
        .from('receivable_snapshots')
        .insert({
          invoice_id: invoice.id,
          observed_at: now.toISOString(),
          original_amount: receivable.original_amount,
          outstanding_amount: outstandingAmount,
          paid_amount: receivable.paid_amount,
          currency: receivable.currency,
          due_date: receivable.due_date,
          payment_status: status,
          aging_bucket: currentAging.aging_bucket,
          days_overdue: currentAging.days_overdue,
          raw_data: receivable.raw_data,
        })
        .select('id')
        .single(),
      'Unable to capture the rechecked receivable status',
    );
    const reminderNumber = reminderCount + 1;
    const idempotencyKey = createScheduledPaymentReminderIdempotencyKey({
      billingDocument: String(invoice.sap_billing_document),
      scheduledFor,
      recipient: approvedRecipient,
      reminderNumber,
    });
    const { data: insertedJob, error: jobError } = await client
      .from('communication_jobs')
      .insert({
        agent_run_id: runId,
        job_type: 'payment_reminder',
        customer_id: customerId,
        primary_invoice_id: invoice.id,
        payment_follow_up_case_id: caseId,
        receivable_snapshot_id: snapshot.id,
        reminder_stage_id: configuration.stageId,
        contact_id: contact.id,
        template_id: configuration.templateId,
        channel: 'whatsapp',
        source_version: reminderNumber,
        status: 'queued',
        approval_status: 'not_required',
        max_attempts: 3,
        idempotency_key: idempotencyKey,
        metadata: {
          controlled_test: true,
          invoice_source: isSimulatedPaymentTest ? 'fixture' : 'sap_qas',
          receivable_source: 'test_fixture',
          actual_recipient: approvedRecipient,
          masked_recipient: formatPhone(approvedRecipient),
          due_date: receivable.due_date,
          outstanding_amount: outstandingAmount,
          template_name: env.MSG91_PAYMENT_TEMPLATE_NAME,
          reminder_number: reminderNumber,
          payment_test_cycle_id: cycleId,
          payment_simulation_test: isSimulatedPaymentTest,
          status_checked_at: now.toISOString(),
          scheduled_for: scheduledFor,
        },
      })
      .select('id')
      .single();
    if (jobError?.code === '23505') {
      await finishAgentRun(client, runId, 'succeeded', 1, 1, 0);
      return { enqueued: false, reason: 'duplicate' };
    }
    if (jobError || !insertedJob) {
      throw new Error(jobError?.message ?? 'Unable to enqueue the scheduled payment reminder');
    }
    const { error: linkError } = await client.from('communication_job_invoices').insert({
      communication_job_id: insertedJob.id,
      invoice_id: invoice.id,
      receivable_snapshot_id: snapshot.id,
    });
    if (linkError && linkError.code !== '23505') throw new Error(linkError.message);
    await client.from('audit_logs').insert({
      actor_type: 'agent',
      action: 'controlled_payment_reminder_queued',
      entity_type: 'communication_job',
      entity_id: String(insertedJob.id),
      after_data: {
        case_id: caseId,
        invoice: invoice.sap_billing_document,
        reminder_number: reminderNumber,
        outstanding_amount: outstandingAmount,
        masked_recipient: formatPhone(approvedRecipient),
      },
      metadata: {
        controlled_test: true,
        trigger_type: 'scheduled',
        payment_test_cycle_id: cycleId,
      },
    });
    await finishAgentRun(client, runId, 'succeeded', 1, 1, 0);
    return { enqueued: true, reason: 'enqueued', jobId: Number(insertedJob.id) };
  } catch (error) {
    await finishAgentRun(client, runId, 'failed', 1, 0, 1, errorMessage(error));
    await client
      .from('payment_follow_up_cases')
      .update({
        next_action_at: new Date(
          Date.now() + reminderSettings.repeatReminderDelaySeconds * 1000,
        ).toISOString(),
      })
      .eq('id', caseId)
      .eq('status', 'active');
    throw error;
  }
}

function assertLocalPaymentSchedulerBoundary(): void {
  if (
    paymentTestRecipients.size === 0 ||
    (env.NODE_ENV === 'production' && !env.PAYMENT_TEST_DEPLOYMENT_ENABLED) ||
    env.DELIVERY_MODE !== 'test' ||
    !env.PAYMENT_FOLLOW_UP_ENABLED ||
    !env.PAYMENT_FOLLOW_UP_SEND_ENABLED ||
    env.PAYMENT_RECEIVABLE_SOURCE !== 'test_fixture' ||
    (!env.PAYMENT_SIMULATION_AUTO_FOLLOW_UP && !isPaymentFollowUpTestConfigured)
  ) {
    throw new Error('Scheduled payment reminders are disabled outside the controlled payment test');
  }
}

async function findConfiguredTestInvoice(client: SupabaseClient): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from('invoices')
    .select('id,sap_billing_document,sold_to_customer_id')
    .eq('sap_billing_document', env.PAYMENT_TEST_INVOICE)
    .maybeSingle();
  if (error) throw new Error(`Unable to load the configured test invoice: ${error.message}`);
  return data;
}

async function getPaymentTestCycleId(
  client: SupabaseClient,
  invoiceId: number,
): Promise<string | null> {
  const { data, error } = await client
    .from('invoice_receivables')
    .select('raw_data')
    .eq('invoice_id', invoiceId)
    .maybeSingle();
  if (error) throw new Error(`Unable to load the controlled payment cycle: ${error.message}`);
  const metadata = data && isRecord(data.raw_data) ? data.raw_data : {};
  const cycleId = String(metadata.payment_test_cycle_id ?? '');
  return cycleId || null;
}

async function countPaymentReminders(
  client: SupabaseClient,
  caseId: number,
  cycleId: string,
): Promise<number> {
  const { count, error } = await client
    .from('communication_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('job_type', 'payment_reminder')
    .eq('payment_follow_up_case_id', caseId)
    .contains('metadata', { payment_test_cycle_id: cycleId });
  if (error) throw new Error(`Unable to count payment reminders: ${error.message}`);
  return count ?? 0;
}

async function pausePaymentTestAtCap(
  client: SupabaseClient,
  caseId: number,
  reminderCount: number,
  maximumReminders: number,
  cycleId: string,
): Promise<void> {
  const { error } = await client
    .from('payment_follow_up_cases')
    .update({ status: 'paused', next_action_at: null, paused_until: null })
    .eq('id', caseId);
  if (error) throw new Error(`Unable to stop the completed controlled payment test: ${error.message}`);
  await client.from('audit_logs').insert({
    actor_type: 'agent',
    action: 'controlled_payment_test_cap_reached',
    entity_type: 'payment_follow_up_case',
    entity_id: String(caseId),
    after_data: { reminder_count: reminderCount, maximum_reminders: maximumReminders },
    metadata: { controlled_test: true, payment_test_cycle_id: cycleId },
  });
}

async function ensurePaymentConfiguration(client: SupabaseClient): Promise<PaymentConfiguration> {
  const provider = await requiredSingle(
    client
      .from('provider_integrations')
      .select('id')
      .eq('provider', 'msg91')
      .eq('channel', 'whatsapp')
      .single(),
    'MSG91 provider integration was not found',
  );
  const template = await requiredSingle(
    client
      .from('communication_templates')
      .upsert(
        {
          code: 'payment_due_whatsapp_en',
          purpose: 'payment_reminder',
          channel: 'whatsapp',
          locale: 'en',
          name: 'Payment due reminder - English',
          body_template: 'Hello {{1}}, payment of INR {{2}} is pending against invoice {{3}} dated {{4}}. Regards, Team {{5}}.',
          provider_integration_id: provider.id,
          provider_template_id: env.MSG91_PAYMENT_TEMPLATE_NAME,
          version: 1,
          status: 'approved',
          required_variables: ['body_1', 'body_2', 'body_3', 'body_4', 'body_5'],
        },
        { onConflict: 'code,channel,locale,version' },
      )
      .select('id')
      .single(),
    'Unable to configure the payment reminder template',
  );
  let { data: policy, error: policyError } = await client
    .from('reminder_policies')
    .select('id')
    .eq('name', TEST_POLICY_NAME)
    .limit(1)
    .maybeSingle();
  if (policyError) throw new Error(policyError.message);
  let policyId = policy ? Number(policy.id) : null;
  if (!policy) {
    const result = await requiredSingle(
      client
        .from('reminder_policies')
        .insert({
          name: TEST_POLICY_NAME,
          description: 'One-invoice, one-recipient policy used only during controlled validation.',
          consolidation_mode: 'per_invoice',
          is_active: true,
          criteria: { environment: 'controlled_test', receivable_source: 'test_fixture' },
        })
        .select('id')
        .single(),
      'Unable to configure the local payment reminder policy',
    );
    policyId = Number(result.id);
  }
  if (!policyId) throw new Error('Local payment reminder policy is unavailable');
  const stage = await requiredSingle(
    client
      .from('reminder_policy_stages')
      .upsert(
        {
          reminder_policy_id: policyId,
          code: TEST_STAGE_CODE,
          name: 'Due today',
          timing_basis: 'on_due',
          offset_days: 0,
          severity: 'due',
          requires_approval: false,
          attach_invoice: false,
          attach_account_statement: false,
          max_delivery_attempts: 3,
          sort_order: 1,
          is_active: true,
        },
        { onConflict: 'reminder_policy_id,code' },
      )
      .select('id')
      .single(),
    'Unable to configure the due-today reminder stage',
  );
  const { error: linkError } = await client.from('reminder_stage_templates').upsert(
    {
      reminder_stage_id: stage.id,
      channel: 'whatsapp',
      template_id: template.id,
      is_enabled: true,
    },
    { onConflict: 'reminder_stage_id,channel' },
  );
  if (linkError) throw new Error(linkError.message);
  return {
    templateId: Number(template.id),
    policyId,
    stageId: Number(stage.id),
  };
}

async function createAgentRun(
  client: SupabaseClient,
  startedBy?: string,
  triggerType: 'manual' | 'scheduled' = 'manual',
): Promise<number> {
  const row = await requiredSingle(
    client
      .from('agent_runs')
      .insert({
        agent_type: 'payment_follow_up',
        trigger_type: triggerType,
        started_by: startedBy && /^[0-9a-f-]{36}$/i.test(startedBy) ? startedBy : null,
        status: 'running',
        metadata: { controlled_test: true, receivable_source: 'test_fixture' },
      })
      .select('id')
      .single(),
    'Unable to create the payment follow-up run',
  );
  return Number(row.id);
}

async function finishAgentRun(
  client: SupabaseClient,
  id: number,
  status: 'succeeded' | 'failed',
  examined: number,
  succeeded: number,
  failed: number,
  summary?: string,
): Promise<void> {
  await client
    .from('agent_runs')
    .update({
      status,
      finished_at: new Date().toISOString(),
      records_examined: examined,
      records_succeeded: succeeded,
      records_failed: failed,
      error_summary: summary ?? null,
    })
    .eq('id', id);
}

async function requiredSingle(
  query: PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>,
  message: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await query;
  if (error || !data) throw new Error(error?.message ?? message);
  return data;
}

function sanitizeJob<T extends Record<string, unknown>>(job: T): T {
  if (!job.metadata || typeof job.metadata !== 'object') return job;
  return { ...job, metadata: withDisplayRecipient(job.metadata) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown payment follow-up error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
