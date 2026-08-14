import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { persistInvoiceRecord } from '../invoice-delivery/repository.js';
import type { PaymentTestPreview, PaymentTestRunResult } from './domain.js';
import {
  assertHardPaymentRecipient,
  createScheduledPaymentReminderIdempotencyKey,
  paymentReminderDelayMs,
  PAYMENT_HARD_TEST_RECIPIENT,
} from './policy.js';
import { maskPhone } from '../invoice-delivery/policy.js';

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

export async function persistPaymentTestAndSchedule(
  preview: PaymentTestPreview,
  startedBy?: string,
): Promise<PaymentTestRunResult> {
  assertHardPaymentRecipient(preview.recipient);
  const client = getSupabaseServerClient();
  const invoice = await persistInvoiceRecord(client, preview.candidate, 'sap');
  const { data: existingCase, error: existingCaseError } = await client
    .from('payment_follow_up_cases')
    .select('id,status')
    .eq('invoice_id', invoice.invoiceId)
    .maybeSingle();
  if (existingCaseError) throw new Error(existingCaseError.message);
  if (existingCase) {
    const { data: existingJob, error: existingJobError } = await client
      .from('communication_jobs')
      .select('id')
      .eq('job_type', 'payment_reminder')
      .eq('payment_follow_up_case_id', existingCase.id)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingJobError) throw new Error(existingJobError.message);
    return {
      caseId: Number(existingCase.id),
      jobId: existingJob ? Number(existingJob.id) : null,
      duplicate: true,
      status: String(existingCase.status),
    };
  }

  const runId = await createAgentRun(client, startedBy);

  try {
    const configuration = await ensurePaymentConfiguration(client);
    const now = new Date().toISOString();
    const firstActionAt = new Date(
      Date.now() + paymentReminderDelayMs(
        0,
        env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS,
        env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
      ),
    ).toISOString();
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
        reason: 'SAP receivables API is not authorized in QAS',
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
            status: 'active',
            next_action_at: firstActionAt,
            paused_until: null,
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
      action: 'controlled_payment_reminder_test_scheduled',
      entity_type: 'payment_follow_up_case',
      entity_id: String(paymentCase.id),
      after_data: {
        case_id: Number(paymentCase.id),
        invoice: preview.candidate.billingDocument,
        amount: preview.receivable.outstandingAmount,
        due_date: preview.receivable.dueDate,
        masked_recipient: preview.maskedRecipient,
        first_action_at: firstActionAt,
        first_delay_seconds: env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS,
        repeat_delay_seconds: env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
      },
      metadata: { controlled_test: true },
    });
    await finishAgentRun(client, runId, 'succeeded', 1, 1, 0);
    return {
      caseId: Number(paymentCase.id),
      jobId: null,
      duplicate: false,
      status: 'scheduled',
    };
  } catch (error) {
    await finishAgentRun(client, runId, 'failed', 1, 0, 1, errorMessage(error));
    throw error;
  }
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
      .select('id,payment_follow_up_case_id,status,attempt_count,last_error,completed_at,created_at,messages(id,status,sent_at,delivered_at,failed_at,failure_reason)')
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
  const receivables = new Map((receivableResult.data ?? []).map((row) => [Number(row.invoice_id), row]));
  const customerMap = new Map((customers ?? []).map((row) => [Number(row.id), row]));
  const latestJobs = new Map<number, Record<string, unknown>>();
  for (const job of jobsResult.data ?? []) {
    const caseId = Number(job.payment_follow_up_case_id);
    if (!latestJobs.has(caseId)) latestJobs.set(caseId, job);
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

export async function getPaymentCase(caseId: number): Promise<Record<string, unknown>> {
  const paymentCase = (await listPaymentCases()).find((row) => Number(row.id) === caseId);
  if (!paymentCase) throw new HttpError(404, 'Payment follow-up case not found');
  const { data: jobs, error } = await getSupabaseServerClient()
    .from('communication_jobs')
    .select(
      'id,status,attempt_count,max_attempts,last_error,completed_at,created_at,metadata,messages(id,status,body,provider_message_id,sent_at,delivered_at,failed_at,failure_reason,message_attempts(id,attempt_number,status,provider_request_id,response_status,error_code,error_message,started_at,finished_at))',
    )
    .eq('job_type', 'payment_reminder')
    .eq('payment_follow_up_case_id', caseId)
    .order('id', { ascending: false });
  if (error) throw new Error(`Unable to load payment reminder history: ${error.message}`);
  return { ...paymentCase, jobs: (jobs ?? []).map(sanitizeJob) };
}

export async function markPaymentReminderScheduledNext(caseId: number): Promise<void> {
  const now = new Date();
  const client = getSupabaseServerClient();
  const { count, error: countError } = await client
    .from('communication_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('job_type', 'payment_reminder')
    .eq('payment_follow_up_case_id', caseId);
  if (countError) throw new Error(`Unable to count payment reminders: ${countError.message}`);
  const reminderCount = count ?? 0;
  const capped = reminderCount >= env.PAYMENT_TEST_MAX_REMINDERS;
  const next = new Date(
    now.getTime() + paymentReminderDelayMs(
      reminderCount,
      env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS,
      env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
    ),
  );
  const { error } = await client
    .from('payment_follow_up_cases')
    .update({
      last_reminder_at: now.toISOString(),
      next_action_at: capped ? null : next.toISOString(),
      status: capped ? 'paused' : 'active',
      paused_until: null,
    })
    .eq('id', caseId);
  if (error) throw new Error(`Unable to update the payment follow-up schedule: ${error.message}`);
  await client.from('audit_logs').insert({
    actor_type: 'agent',
    action: capped ? 'controlled_payment_test_cap_reached' : 'controlled_payment_reminder_rescheduled',
    entity_type: 'payment_follow_up_case',
    entity_id: String(caseId),
    after_data: {
      reminder_count: reminderCount,
      next_action_at: capped ? null : next.toISOString(),
      repeat_delay_seconds: env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
    },
    metadata: { controlled_test: true },
  });
}

export async function preparePaymentTestSchedule(): Promise<void> {
  assertLocalPaymentSchedulerBoundary();
  const client = getSupabaseServerClient();
  const invoice = await findConfiguredTestInvoice(client);
  if (!invoice) return;
  const { data: paymentCase, error: caseError } = await client
    .from('payment_follow_up_cases')
    .select('id,status,last_reminder_at,next_action_at')
    .eq('invoice_id', invoice.id)
    .maybeSingle();
  if (caseError) throw new Error(`Unable to load the controlled payment case: ${caseError.message}`);
  if (!paymentCase) return;
  const reminderCount = await countPaymentReminders(client, Number(paymentCase.id));
  if (reminderCount >= env.PAYMENT_TEST_MAX_REMINDERS) {
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
    env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS,
    env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
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
    .eq('id', paymentCase.id);
  if (error) throw new Error(`Unable to prepare the controlled payment schedule: ${error.message}`);
}

export async function enqueueNextDuePaymentReminder(): Promise<PaymentScheduleResult> {
  assertLocalPaymentSchedulerBoundary();
  const client = getSupabaseServerClient();
  const invoice = await findConfiguredTestInvoice(client);
  if (!invoice) return { enqueued: false, reason: 'not_due' };
  const now = new Date();
  const { data: paymentCase, error: caseError } = await client
    .from('payment_follow_up_cases')
    .select('id,invoice_id,status,next_action_at')
    .eq('invoice_id', invoice.id)
    .eq('status', 'active')
    .lte('next_action_at', now.toISOString())
    .maybeSingle();
  if (caseError) throw new Error(`Unable to inspect the payment schedule: ${caseError.message}`);
  if (!paymentCase?.next_action_at) return { enqueued: false, reason: 'not_due' };

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
  await client.from('audit_logs').insert({
    actor_type: 'agent',
    action: 'controlled_payment_status_checked',
    entity_type: 'payment_follow_up_case',
    entity_id: String(paymentCase.id),
    after_data: { payment_status: status, outstanding_amount: outstandingAmount },
    metadata: { controlled_test: true, scheduled_for: String(paymentCase.next_action_at) },
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
  const reminderCount = await countPaymentReminders(client, caseId);
  if (reminderCount >= env.PAYMENT_TEST_MAX_REMINDERS) {
    await pausePaymentTestAtCap(client, caseId, reminderCount);
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
      .eq('normalized_value', PAYMENT_HARD_TEST_RECIPIENT)
      .eq('is_active', true)
      .eq('do_not_contact', false)
      .maybeSingle();
    if (contactError || !contact) {
      throw new Error(`Approved SAP customer contact is unavailable: ${contactError?.message ?? 'Contact not found'}`);
    }
    assertHardPaymentRecipient(String(contact.normalized_value));

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
          aging_bucket: receivable.aging_bucket,
          days_overdue: receivable.days_overdue,
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
      recipient: PAYMENT_HARD_TEST_RECIPIENT,
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
          invoice_source: 'sap_qas',
          receivable_source: 'test_fixture',
          actual_recipient: PAYMENT_HARD_TEST_RECIPIENT,
          masked_recipient: maskPhone(PAYMENT_HARD_TEST_RECIPIENT),
          due_date: receivable.due_date,
          outstanding_amount: outstandingAmount,
          template_name: env.MSG91_PAYMENT_TEMPLATE_NAME,
          reminder_number: reminderNumber,
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
        masked_recipient: maskPhone(PAYMENT_HARD_TEST_RECIPIENT),
      },
      metadata: { controlled_test: true, trigger_type: 'scheduled' },
    });
    await finishAgentRun(client, runId, 'succeeded', 1, 1, 0);
    return { enqueued: true, reason: 'enqueued', jobId: Number(insertedJob.id) };
  } catch (error) {
    await finishAgentRun(client, runId, 'failed', 1, 0, 1, errorMessage(error));
    await client
      .from('payment_follow_up_cases')
      .update({
        next_action_at: new Date(
          Date.now() + env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS * 1000,
        ).toISOString(),
      })
      .eq('id', caseId)
      .eq('status', 'active');
    throw error;
  }
}

function assertLocalPaymentSchedulerBoundary(): void {
  if (
    (env.NODE_ENV === 'production' && !env.PAYMENT_TEST_DEPLOYMENT_ENABLED) ||
    env.DELIVERY_MODE !== 'test' ||
    !env.PAYMENT_FOLLOW_UP_ENABLED ||
    !env.PAYMENT_FOLLOW_UP_SEND_ENABLED ||
    env.PAYMENT_RECEIVABLE_SOURCE !== 'test_fixture' ||
    env.PAYMENT_TEST_RECIPIENT.replace(/\D/g, '') !== PAYMENT_HARD_TEST_RECIPIENT
  ) {
    throw new Error('Scheduled payment reminders are disabled outside the single-recipient controlled test');
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

async function countPaymentReminders(client: SupabaseClient, caseId: number): Promise<number> {
  const { count, error } = await client
    .from('communication_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('job_type', 'payment_reminder')
    .eq('payment_follow_up_case_id', caseId);
  if (error) throw new Error(`Unable to count payment reminders: ${error.message}`);
  return count ?? 0;
}

async function pausePaymentTestAtCap(
  client: SupabaseClient,
  caseId: number,
  reminderCount: number,
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
    after_data: { reminder_count: reminderCount, maximum_reminders: env.PAYMENT_TEST_MAX_REMINDERS },
    metadata: { controlled_test: true },
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
  const metadata = { ...(job.metadata as Record<string, unknown>) };
  delete metadata.actual_recipient;
  return { ...job, metadata };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown payment follow-up error';
}
