import { AlertCircle, Download, ExternalLink, FileText, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { Amount, Bubble, Journey, PhoneFrame, formatTime, rise, type JourneyItem, type PageTone } from '../components/statement';
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
import { messageLifecycleState, type MessageLifecycleState } from '../lib/message-status';
import type {
  AdminUser,
  AppRoute,
  DeliveryJobDetail,
  PaymentFollowUpCase,
  DeliveryMessage,
  MessageAttempt,
} from '../types';
import { relationOne } from '../types';

type Stage = MessageLifecycleState;

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
    if (!job || ['read', 'failed', 'cancelled'].includes(messageStatus ?? job.status)) return;
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
  const nextStep = job ? nextStepText(stage, paymentCase) : null;

  const tone: PageTone = stage === 'failed' ? 'critical' : stage === 'read' || stage === 'delivered' ? 'paid' : 'calm';
  const pill = ({ read: 'Read by customer', delivered: 'Delivered', sent: 'Sent', failed: 'Not delivered', queued: 'Getting ready' } as Record<Stage, string>)[stage];
  const journeyItems = job ? journeyList(job, message, stage, failureReason, paymentCase, () => paymentCase && onNavigate(`/payments/${paymentCase.id}`)) : [];
  const explainer = documentType ? TYPE_EXPLAINER[documentType.toUpperCase()] : undefined;
  const sentAt = message?.sent_at ?? null;

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
    >
      {error && <div className="alert alert--error">{error}</div>}

      {loading || !job ? (
        <div className="detail-skeleton"><span /><div><span /><span /></div></div>
      ) : (
        <div className="pf pf--stack pf--doc" data-tone={tone}>
          <div className="dd-layout">
            <div className="dd-main">
              <section className="dd-card dd-summary pf-rise" style={rise(0)} aria-label="Summary">
                <div className="dd-summary__top">
                  <span className="pf-pill"><i aria-hidden="true" />{pill}</span>
                  <div className="pf-actions">
                    {stage === 'failed' ? (
                      <button className="pf-btn pf-btn--solid" type="button" disabled={retrying} onClick={() => void retry()}>
                        <RotateCcw size={14} aria-hidden="true" /> {retrying ? 'Trying again…' : 'Try again'}
                      </button>
                    ) : document?.download_url ? (
                      <a className="pf-btn pf-btn--solid" href={document.download_url} target="_blank" rel="noreferrer">
                        <Download size={14} aria-hidden="true" /> Download PDF
                      </a>
                    ) : null}
                    {document?.preview_url && (
                      <button className="pf-btn pf-btn--ghost" type="button" onClick={() => setShowPdf((open) => !open)}>
                        <FileText size={14} aria-hidden="true" /> {showPdf ? 'Hide PDF' : 'View PDF'}
                      </button>
                    )}
                    <button className="pf-btn pf-btn--ghost" type="button" disabled={refreshing} onClick={() => void load(true)}>
                      <RefreshCw size={14} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh
                    </button>
                  </div>
                </div>

                <div className="dd-figure">
                  <div>
                    <p className="pf-hero__label">{billingDocumentAmountLabel(documentType)}</p>
                    <Amount value={Number(amount ?? 0)} currency={currency} available={amount !== undefined} />
                  </div>
                  <p className="dd-headline">{summary.title}</p>
                </div>

                {stage === 'failed' && (
                  <div className="dd-notice" role="alert">
                    <p>{failureReason ?? 'No reason was given.'}</p>
                    {nextStep && <p className="dd-notice__next"><AlertCircle size={13} aria-hidden="true" /> {nextStep}</p>}
                  </div>
                )}

                <Journey
                  title="What happened"
                  hint={stage === 'queued' || stage === 'sent' ? 'Updates on its own' : 'Oldest to newest'}
                  items={journeyItems}
                  label="Delivery history"
                />
              </section>

            {showPdf && document?.preview_url && (
              <section className="ds-pdf pf-rise" style={rise(1)} aria-label={`${documentLabel} PDF`}>
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

              <section className="dd-card dd-details pf-rise" style={rise(2)} aria-label="Details">
                <dl className="dd-facts">
                  <div>
                    <dt>Customer</dt>
                    <dd>
                      {customer?.id
                        ? <button className="pf-link" type="button" onClick={() => onNavigate(`/customers/${customer.id}`)}>{customer.display_name}</button>
                        : 'Customer unavailable'}
                    </dd>
                  </div>
                  <div><dt>Customer code</dt><dd>{customer?.sap_customer_number ?? '—'}</dd></div>
                  <div><dt>Sent to</dt><dd className="mono">{job.metadata?.masked_recipient ?? '—'}</dd></div>
                  <div><dt>Document</dt><dd>{documentLabel}</dd>{explainer && <small>{explainer}</small>}</div>
                  <div><dt>Number</dt><dd>{invoice?.sap_billing_document ?? `#${job.id}`}</dd></div>
                  <div><dt>Dated</dt><dd>{formatDate(invoice?.billing_document_date)}</dd></div>
                  <div><dt>Created in SAP</dt><dd>{formatDate(job.created_at)}</dd></div>
                  <div><dt>Sent</dt><dd>{sentAt ? formatDate(sentAt) : '—'}</dd><small>{sentAt ? formatTime(sentAt) : 'Not sent yet'}</small></div>
                  <div>
                    <dt>Read</dt>
                    <dd>{message?.read_at ? formatDate(message.read_at) : '—'}</dd>
                    <small>{message?.read_at ? formatTime(message.read_at) : message?.delivered_at ? 'Not confirmed' : 'Not yet'}</small>
                  </div>
                </dl>
                <details className="ds-tech pf-tech">
                  <summary>Technical details</summary>
                  <dl className="dt-details dt-details--stacked">
                    <div><dt>Reference</dt><dd>#{job.id}</dd></div>
                    <div><dt>Message format</dt><dd className="mono">{job.communication_templates?.name ?? job.metadata?.template_name ?? '—'}</dd></div>
                    <div><dt>WhatsApp message ID</dt><dd className="mono">{message?.provider_message_id ?? '—'}</dd></div>
                    <div><dt>Send attempts</dt><dd>{attempts.length} of {job.max_attempts}</dd></div>
                    <div><dt>Delivered</dt><dd>{formatDateTime(message?.delivered_at)}</dd></div>
                    <div><dt>Read receipt</dt><dd>{message?.read_at ? formatDateTime(message.read_at) : message?.delivered_at ? 'Not confirmed' : '—'}</dd></div>
                  </dl>
                </details>

              </section>
            </div>

            <PhoneFrame name={who} subtitle={job.metadata?.masked_recipient} badge={documentLabel} style={rise(2)}>
            <section className="pf-day" aria-label="Message">
              <h4>{formatDate(message?.sent_at ?? job.created_at)}</h4>
              <div className="pf-turn">
                <Bubble tone={stage} time={formatTime(message?.sent_at ?? job.created_at)}>
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
                </Bubble>
                {stage === 'failed' && <p className="pf-notice"><AlertCircle size={12} aria-hidden="true" /> {failureReason ?? 'No reason was given.'}</p>}
              </div>
            </section>
          </PhoneFrame>
          </div>
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
    case 'read':
      return { title: `${who} read this ${label}`, detail: `WhatsApp confirmed it was read${to} ${when(message?.read_at ?? message?.delivered_at)}.` };
    case 'delivered':
      return { title: `${who} received this ${label}`, detail: `Delivered on WhatsApp${to} ${when(message?.delivered_at ?? message?.sent_at)}. Read not confirmed; the customer may have read receipts turned off.` };
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

function journeyList(
  job: DeliveryJobDetail,
  message: DeliveryMessage | undefined,
  stage: Stage,
  failureReason: string | null | undefined,
  paymentCase: PaymentFollowUpCase | null,
  openPayment: () => void,
): JourneyItem[] {
  const order: Stage[] = ['queued', 'sent', 'delivered', 'read'];
  const failed = stage === 'failed';
  const reached = failed ? (message?.sent_at ? 1 : 0) : order.indexOf(stage);
  const day = (value?: string | null) => (value ? formatDate(value) : 'Pending');
  const items: JourneyItem[] = [
    { key: 'created', state: 'done', title: 'Created in SAP', when: day(job.created_at ?? job.scheduled_at) },
  ];
  if (!failed || reached >= 1) {
    items.push({ key: 'sent', state: reached >= 1 ? 'done' : 'now', title: 'Sent', when: day(message?.sent_at) });
  }
  if (failed) {
    items.push({ key: 'failed', state: 'bad', title: 'Not delivered', when: day(message?.failed_at ?? job.completed_at), detail: failureReason ?? 'No reason was given.' });
    return items;
  }
  items.push({ key: 'delivered', state: reached >= 2 ? 'done' : reached === 1 ? 'now' : 'next', title: 'Delivered', when: day(message?.delivered_at) });
  items.push({
    key: 'read',
    state: reached >= 3 ? 'good' : reached === 2 ? 'now' : 'next',
    title: 'Read',
    when: message?.read_at ? formatDate(message.read_at) : reached === 2 ? 'Not confirmed' : 'Pending',
  });
  if (paymentCase) {
    const receivable = paymentCase.receivable;
    const outstanding = Number(receivable?.outstanding_amount ?? 0);
    const paid = Boolean(paymentCase.resolved_at) || (receivable ? outstanding <= 0 : false);
    items.push(paid
      ? { key: 'paid', state: 'good', title: 'Paid', when: day(paymentCase.resolved_at ?? receivable?.last_synced_at) }
      : {
          key: 'payment',
          state: 'next',
          title: 'Payment',
          when: receivable?.due_date ? `Due ${formatDate(receivable.due_date)}` : 'Unpaid',
          detail: <button className="pf-link" type="button" onClick={openPayment}>Open payment</button>,
        });
  }
  return items;
}

function stageOf(job: DeliveryJobDetail, message?: DeliveryMessage): Stage {
  if (job.status === 'failed') return 'failed';
  return messageLifecycleState(message?.status ?? job.status, message);
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
