import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import {
  billingDocumentAmountLabel,
  billingDocumentAttachmentMessage,
  billingDocumentLabel,
  billingDocumentMessage,
  billingDocumentSignature,
} from '../lib/billing-documents';
import {
  formatBytes,
  formatCurrency,
  formatDate,
  formatDateTime,
  toMessage,
} from '../lib/format';
import type {
  AdminUser,
  AppRoute,
  DeliveryJobDetail,
  PaymentFollowUpCase,
  DeliveryMessage,
  MessageAttempt,
} from '../types';
import { relationOne } from '../types';

type Stage = 'queued' | 'sent' | 'delivered' | 'failed';

export function DeliveryDetailPage({
  route,
  jobId,
  onNavigate,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
  jobId: number;
  onNavigate: (path: string) => void;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [job, setJob] = useState<DeliveryJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [paymentCase, setPaymentCase] = useState<PaymentFollowUpCase | null>(null);
  const [showPdf, setShowPdf] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const nextJob = await apiRequest<DeliveryJobDetail>(`/invoice-delivery/jobs/${jobId}`);
      // Keep already-signed document URLs so the PDF preview does not reload on every poll.
      setJob((currentJob) => (silent ? preserveDocumentUrls(currentJob, nextJob) : nextJob));
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  // The same invoice may also have a payment follow-up; show it on this page too.
  const paymentCaseId = job?.payment_case_id ?? null;
  useEffect(() => {
    if (!paymentCaseId) { setPaymentCase(null); return; }
    let active = true;
    apiRequest<PaymentFollowUpCase>(`/payment-follow-up/cases/${paymentCaseId}`)
      .then((nextCase) => { if (active) setPaymentCase(nextCase); })
      .catch(() => { if (active) setPaymentCase(null); });
    return () => { active = false; };
  }, [paymentCaseId]);
  useEffect(() => {
    const messageStatus = job?.messages?.[0]?.status;
    if (!job || ['delivered', 'read', 'failed', 'cancelled'].includes(messageStatus ?? job.status)) return;
    const interval = window.setInterval(() => void load(true), 2500);
    return () => window.clearInterval(interval);
  }, [job, load]);

  async function retry() {
    if (!job) return;
    setRetrying(true);
    setError('');
    try {
      await apiRequest(`/invoice-delivery/jobs/${job.id}/retry`, { method: 'POST' });
      await load(true);
    } catch (retryError) {
      setError(toMessage(retryError));
    } finally {
      setRetrying(false);
    }
  }

  const invoice = relationOne(job?.invoices);
  const customer = relationOne(job?.customers);
  const message = job?.messages?.[0];
  const attempts = message?.message_attempts ?? [];
  const latestAttempt = attempts.at(-1);
  const variables = useMemo(() => readTemplateVariables(latestAttempt), [latestAttempt]);
  const document = job?.invoice_documents?.find((item) => item.is_current) ?? job?.invoice_documents?.[0];
  const documentType = invoice?.billing_document_type ?? job?.metadata?.billing_document_type;
  const documentLabel = billingDocumentLabel(documentType);
  const stage = job ? stageOf(job, message) : 'queued';
  const failureReason = message?.failure_reason ?? latestAttempt?.error_message ?? job?.last_error;
  const amount = invoice?.total_gross_amount;
  const currency = invoice?.transaction_currency ?? 'INR';
  const who = customer?.display_name ?? 'The customer';
  const summary = job ? summarize(stage, who, documentLabel.toLowerCase(), job.metadata?.masked_recipient, message, job.created_at) : { title: '', detail: '' };
  const journey = job ? journeySteps(job, message, stage, paymentCase) : [];
  const nextStep = job ? nextStepText(stage, paymentCase) : null;

  return (
    <AppShell
      route={route}
      eyebrow={customer?.display_name ?? (job ? 'Customer unavailable' : undefined)}
      title={invoice?.sap_billing_document ? `${documentLabel} ${invoice.sap_billing_document}` : `Document #${jobId}`}
      headerLeading={(
        <BackLink fallbackPath="/documents" fallbackLabel="Documents" onNavigate={onNavigate} />
      )}
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={(
        <>
          <button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh
          </button>
          {document?.download_url && (
            <a className="button button--primary" href={document.download_url} target="_blank" rel="noreferrer">
              <Download size={16} aria-hidden="true" /> Download PDF
            </a>
          )}
        </>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}

      {loading || !job ? (
        <div className="detail-skeleton"><span /><div><span /><span /></div></div>
      ) : (
        <div className="ds">
          <section className={`ds-summary ds-summary--${stage}`} aria-label="Summary">
            <span className="ds-summary__icon"><StageIcon stage={stage} size={22} /></span>
            <div className="ds-summary__text">
              <span className="ds-kind">{documentLabel}{invoice?.sap_billing_document ? ` ${invoice.sap_billing_document}` : ''}</span>
              <h2>{summary.title}</h2>
              <p>{summary.detail}</p>
              {nextStep && <p className="ds-next"><strong>Next:</strong> {nextStep}</p>}
            </div>
            <div className="ds-summary__side">
              <span className="ds-amount">{amount !== undefined ? formatCurrency(Number(amount), currency) : '—'}</span>
              <small>{billingDocumentAmountLabel(documentType)}</small>
              <div className="ds-summary__actions">
                {stage === 'failed' && (
                  <button className="button button--primary" type="button" disabled={retrying} onClick={() => void retry()}>
                    <RotateCcw size={15} aria-hidden="true" /> {retrying ? 'Trying again…' : 'Try again'}
                  </button>
                )}
                {document?.preview_url && (
                  <button className={`button ${stage === 'failed' ? 'button--secondary' : 'button--primary'}`} type="button" onClick={() => setShowPdf((open) => !open)}>
                    <FileText size={15} aria-hidden="true" /> {showPdf ? 'Hide PDF' : 'View PDF'}
                  </button>
                )}
              </div>
            </div>
          </section>

          <ol className="ds-steps" aria-label="Journey">
            {journey.map((step) => (
              <li key={step.key} className={`ds-step ds-step--${step.state}`}>
                <span className="ds-step__dot">
                  {step.state === 'done' ? <Check size={12} strokeWidth={3} /> : step.state === 'failed' ? <AlertCircle size={13} strokeWidth={2.6} /> : null}
                </span>
                <strong>{step.label}</strong>
                <small>{step.time ? formatDateTime(step.time) : step.state === 'current' ? 'Waiting…' : step.state === 'failed' ? 'Stopped' : '—'}</small>
              </li>
            ))}
          </ol>
          {stage === 'failed' && <p className="ds-reason"><AlertCircle size={15} aria-hidden="true" /> <span><strong>Why it failed:</strong> {failureReason ?? 'No reason was given.'}</span></p>}

          {showPdf && document?.preview_url && (
            <section className="ds-pdf" aria-label={`${documentLabel} PDF`}>
              <header>
                <strong>{document.file_name ?? `${documentLabel}.pdf`}</strong>
                <span>
                  <a className="dt-link" href={document.preview_url} target="_blank" rel="noreferrer">Open in new tab <ExternalLink size={13} aria-hidden="true" /></a>
                  {document.download_url && <a className="dt-link" href={document.download_url} target="_blank" rel="noreferrer">Download <Download size={13} aria-hidden="true" /></a>}
                </span>
              </header>
              <iframe src={`${document.preview_url}#toolbar=1&navpanes=0&view=FitH`} title={`${documentLabel} ${invoice?.sap_billing_document ?? jobId}`} />
            </section>
          )}

          <div className="ds-grid">
            <section className="ds-card" aria-label="What the customer received">
              <header className="ds-card__head">
                <h3>What {customer?.display_name ?? 'the customer'} received</h3>
                <span>On WhatsApp</span>
              </header>
              <div className="dt-chat">
                <div className="dt-bubble">
                  {document && (
                    <div className="dt-attachment">
                      <span className="dt-attachment__icon"><FileText size={18} aria-hidden="true" /></span>
                      <span className="dt-attachment__name">
                        <strong>{document.file_name ?? `${documentLabel}.pdf`}</strong>
                        <small>PDF · {formatBytes(document.size_bytes)}</small>
                      </span>
                      {document.preview_url && (
                        <button type="button" onClick={() => setShowPdf(true)} aria-label="View PDF" title="View PDF">
                          <ExternalLink size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )}
                  <p>Dear {variables.var_1 ?? customer?.display_name ?? 'Customer'},</p>
                  <p>{billingDocumentMessage(
                    documentType,
                    variables.var_2 ?? invoice?.sap_billing_document ?? '—',
                    variables.var_3 ?? formatDate(invoice?.billing_document_date),
                  )}</p>
                  <p>
                    {billingDocumentAmountLabel(documentType)}:{' '}
                    <strong>{variables.var_4 ? `₹${variables.var_4}` : amount !== undefined ? formatCurrency(Number(amount), currency) : '—'}</strong>
                  </p>
                  <p>{billingDocumentAttachmentMessage(documentType)}</p>
                  <p>Thank you,<br />{billingDocumentSignature(documentType, variables.var_5 ?? 'SuryaDev')}</p>
                  <span className="dt-bubble__meta">
                    {formatTime(message?.sent_at ?? job.created_at)}
                    <MessageTicks stage={stage} />
                  </span>
                </div>
              </div>
            </section>

            <div className="ds-side">
              <section className="ds-card" aria-label="About this document">
                <header className="ds-card__head"><h3>About this document</h3></header>
                {documentType && TYPE_EXPLAINER[documentType.toUpperCase()] && (
                  <p className="ds-explainer"><span className="document-type-code">{documentType}</span> {TYPE_EXPLAINER[documentType.toUpperCase()]}</p>
                )}
                <dl className="ds-facts">
                  <div><dt>Customer</dt><dd>{customer?.id ? <button className="dt-inline-link" type="button" onClick={() => onNavigate(`/customers/${customer.id}`)}>{customer.display_name}</button> : (customer?.display_name ?? '—')}</dd></div>
                  <div><dt>Sent to</dt><dd className="mono">{job.metadata?.masked_recipient ?? '—'}</dd></div>
                  <div><dt>Document number</dt><dd>{invoice?.sap_billing_document ?? '—'}</dd></div>
                  <div><dt>Document date</dt><dd>{formatDate(invoice?.billing_document_date)}</dd></div>
                  <div><dt>{billingDocumentAmountLabel(documentType)}</dt><dd>{amount !== undefined ? formatCurrency(Number(amount), currency) : '—'}</dd></div>
                </dl>
              </section>

              {paymentCase && <PaymentPanel paymentCase={paymentCase} onOpen={() => onNavigate(`/payments/${paymentCase.id}`)} />}
            </div>
          </div>

          <details className="ds-tech">
            <summary>Technical details</summary>
            <dl className="dt-details dt-details--stacked">
              <div><dt>Reference</dt><dd>#{job.id}</dd></div>
              <div><dt>Customer code</dt><dd>{customer?.sap_customer_number ?? '—'}</dd></div>
              <div><dt>Message format</dt><dd className="mono">{job.communication_templates?.name ?? job.metadata?.template_name ?? '—'}</dd></div>
              <div><dt>WhatsApp message ID</dt><dd className="mono">{message?.provider_message_id ?? '—'}</dd></div>
              <div><dt>Send attempts</dt><dd>{attempts.length} of {job.max_attempts}</dd></div>
              <div><dt>Created</dt><dd>{formatDateTime(job.created_at)}</dd></div>
            </dl>
          </details>
        </div>
      )}
    </AppShell>
  );
}

const TYPE_EXPLAINER: Record<string, string> = {
  F2: 'A bill for goods supplied to the customer.',
  S1: 'Cancels an invoice that was sent earlier.',
  G2: 'Lowers the amount the customer owes.',
  CBRE: 'Credit for goods the customer returned.',
  L2: 'Adds an extra charge to what the customer owes.',
};

function summarize(stage: Stage, who: string, label: string, phone: string | undefined, message: DeliveryMessage | undefined, createdAt?: string) {
  const to = phone ? ` on ${phone}` : '';
  switch (stage) {
    case 'delivered':
      return { title: `${who} received this ${label}`, detail: `Delivered on WhatsApp${to} ${when(message?.delivered_at ?? message?.sent_at)}.` };
    case 'sent':
      return { title: `Sent to ${who}`, detail: `Sent on WhatsApp${to} ${when(message?.sent_at)}. Waiting for it to reach their phone.` };
    case 'failed':
      return { title: `This ${label} didn’t reach ${who}`, detail: `We tried to send it on WhatsApp${to}${message?.failed_at ? ` ${when(message.failed_at)}` : ''}. See why below.` };
    default:
      return { title: `Getting ready to send to ${who}`, detail: `Picked up from SAP ${when(createdAt)}. It will go out on WhatsApp in a moment.` };
  }
}

function when(value?: string | null): string {
  return value ? `on ${formatDateTime(value)}` : '';
}

function nextStepText(stage: Stage, paymentCase: PaymentFollowUpCase | null): string | null {
  if (stage === 'failed') return 'Check the reason, then try again. If the number is wrong, fix it in SAP first.';
  if (stage === 'queued' || stage === 'sent') return 'Nothing to do. This page updates on its own.';
  if (!paymentCase) return 'Nothing to do.';
  const receivable = paymentCase.receivable;
  if (paymentCase.resolved_at || (receivable && receivable.outstanding_amount <= 0)) return 'Paid in full. Nothing to do.';
  if (paymentCase.next_action_at) return `A payment reminder goes out ${formatDateTime(paymentCase.next_action_at)} if it isn’t paid.`;
  return receivable?.due_date ? `Payment is due ${formatDate(receivable.due_date)}.` : null;
}

type JourneyStep = { key: string; label: string; time?: string | null; state: 'done' | 'current' | 'upcoming' | 'failed' };

function journeySteps(job: DeliveryJobDetail, message: DeliveryMessage | undefined, stage: Stage, paymentCase: PaymentFollowUpCase | null): JourneyStep[] {
  const order: Stage[] = ['queued', 'sent', 'delivered'];
  const reached = stage === 'failed' ? (message?.sent_at ? 1 : 0) : order.indexOf(stage);
  const steps: JourneyStep[] = [
    { key: 'created', label: 'Created in SAP', time: job.created_at ?? job.scheduled_at, state: 'done' },
    { key: 'sent', label: 'Sent', time: message?.sent_at, state: reached >= 1 ? 'done' : 'upcoming' },
    { key: 'delivered', label: 'Delivered', time: message?.delivered_at, state: reached >= 2 ? 'done' : 'upcoming' },
  ];
  if (stage === 'failed') {
    steps[reached + 1] = { key: 'failed', label: 'Not delivered', time: message?.failed_at ?? job.completed_at, state: 'failed' };
    return steps.slice(0, reached + 2);
  }
  if (paymentCase) {
    const receivable = paymentCase.receivable;
    const paid = Boolean(paymentCase.resolved_at) || (receivable ? receivable.outstanding_amount <= 0 : false);
    steps.push({ key: 'paid', label: 'Paid', time: paid ? paymentCase.resolved_at ?? receivable?.last_synced_at : null, state: paid ? 'done' : 'upcoming' });
  }
  const next = steps.find((step) => step.state === 'upcoming');
  if (next && (next.key === 'sent' || next.key === 'delivered')) next.state = 'current';
  return steps;
}

function PaymentPanel({ paymentCase, onOpen }: { paymentCase: PaymentFollowUpCase; onOpen: () => void }) {
  const receivable = paymentCase.receivable;
  const currency = receivable?.currency ?? 'INR';
  const original = Number(receivable?.original_amount ?? paymentCase.invoice?.total_gross_amount ?? 0);
  const paid = Number(receivable?.paid_amount ?? 0);
  const outstanding = Number(receivable?.outstanding_amount ?? 0);
  const paidShare = original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0;
  const late = receivable?.days_overdue ?? 0;
  const reminders = paymentCase.jobs ?? (paymentCase.latestJob ? [paymentCase.latestJob] : []);
  const settled = Boolean(paymentCase.resolved_at) || (receivable ? outstanding <= 0 : false);

  return (
    <section className="dt-section" aria-label="Payment">
      <header className="dt-section__head">
        <h3>Payment</h3>
        <button className="dt-link" type="button" onClick={onOpen}>Open payment <ExternalLink size={13} aria-hidden="true" /></button>
      </header>
      <div className="dt-pay">
        <div className="dt-pay__top">
          <div>
            <strong className={settled ? 'text-success' : late > 0 ? 'text-danger' : ''}>
              {settled ? 'Paid in full' : `${formatCurrency(outstanding, currency)} still to pay`}
            </strong>
            <small>
              {settled ? `${formatCurrency(paid, currency)} received` : `Due ${formatDate(receivable?.due_date)}${late > 0 ? ` · ${late} ${late === 1 ? 'day' : 'days'} late` : ''}`}
            </small>
          </div>
          <span className="dt-pay__share">{paidShare}% paid</span>
        </div>
        <div className="dt-paid__track" role="img" aria-label={`${paidShare}% paid`}><span style={{ width: `${paidShare}%` }} /></div>
        {reminders.length > 0 ? (
          <ul className="dt-pay__reminders">
            {reminders.map((reminder, index) => {
              const reminderMessage = relationOne(reminder.messages);
              return (
                <li key={reminder.id}>
                  <span>Reminder {reminders.length - index}</span>
                  <small>{formatDateTime(reminderMessage?.sent_at ?? reminder.created_at)}</small>
                  <StatusBadge status={reminderMessage?.status ?? reminder.status} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="dt-pay__none">{paymentCase.next_action_at && !settled ? `First reminder goes out ${formatDateTime(paymentCase.next_action_at)}.` : 'No reminders sent.'}</p>
        )}
      </div>
    </section>
  );
}

function stageOf(job: DeliveryJobDetail, message?: DeliveryMessage): Stage {
  const status = (message?.status ?? job.status).toLowerCase();
  if (status === 'failed' || status === 'cancelled' || job.status === 'failed') return 'failed';
  if (status === 'read') return 'delivered';
  if (status === 'delivered' || message?.delivered_at) return 'delivered';
  if (status === 'sent' || message?.sent_at) return 'sent';
  return 'queued';
}

function StageIcon({ stage, size }: { stage: Stage; size: number }) {
  if (stage === 'failed') return <AlertCircle size={size} aria-hidden="true" />;
  if (stage === 'queued') return <Clock3 size={size} aria-hidden="true" />;
  if (stage === 'sent') return <Check size={size} strokeWidth={2.6} aria-hidden="true" />;
  return <CheckCheck size={size} strokeWidth={2.4} aria-hidden="true" />;
}

function MessageTicks({ stage }: { stage: Stage }) {
  if (stage === 'failed') return <AlertCircle className="dt-ticks dt-ticks--failed" size={13} aria-label="Failed" />;
  if (stage === 'queued') return <Clock3 className="dt-ticks" size={12} aria-label="Queued" />;
  if (stage === 'sent') return <Check className="dt-ticks" size={14} aria-label="Sent" />;
  return <CheckCheck className="dt-ticks" size={14} aria-label="Delivered" />;
}

function preserveDocumentUrls(
  currentJob: DeliveryJobDetail | null,
  nextJob: DeliveryJobDetail,
): DeliveryJobDetail {
  if (!currentJob?.invoice_documents?.length || !nextJob.invoice_documents?.length) {
    return nextJob;
  }

  const currentDocuments = new Map(
    currentJob.invoice_documents.map((document) => [document.id, document]),
  );

  return {
    ...nextJob,
    invoice_documents: nextJob.invoice_documents.map((document) => {
      const currentDocument = currentDocuments.get(document.id);
      if (!currentDocument) return document;
      return {
        ...document,
        preview_url: currentDocument.preview_url ?? document.preview_url,
        download_url: currentDocument.download_url ?? document.download_url,
      };
    }),
  };
}

function formatTime(value?: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
}

function readTemplateVariables(attempt?: MessageAttempt): Record<string, string> {
  const root = asRecord(attempt?.request_payload);
  const payload = asRecord(root?.payload);
  const template = asRecord(payload?.template);
  const recipients = template?.to_and_components;
  const recipient = Array.isArray(recipients) ? asRecord(recipients[0]) : undefined;
  const components = asRecord(recipient?.components);
  const variables: Record<string, string> = {};
  for (let index = 1; index <= 5; index += 1) {
    const namedComponent = asRecord(components?.[`body_var_${index}`]);
    const positionalComponent = asRecord(components?.[`body_${index}`]);
    const value = namedComponent?.value ?? positionalComponent?.value;
    if (typeof value === 'string') variables[`var_${index}`] = value;
  }
  return variables;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
