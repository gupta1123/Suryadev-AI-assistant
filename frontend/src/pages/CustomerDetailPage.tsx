import { CheckCheck, ChevronRight, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { StatementRow, rise, type PageTone } from '../components/statement';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { billingDocumentLabel } from '../lib/billing-documents';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import type { AdminUser, AppRoute, CustomerContact, CustomerDetail } from '../types';
import { contactHealth } from './CustomersPage';

const DOCUMENTS_PREVIEW = 8;

// Plain-language meaning of each contact state, and what the team should do about it.
function contactExplanation(contact: CustomerContact | null): string {
  const health = contactHealth(contact);
  if (health.tone === 'none') return 'There’s no WhatsApp number for this customer. Add one in SAP and it will be picked up on the next sync.';
  if (health.label === 'Opted out') return 'This customer asked not to get WhatsApp messages. Documents won’t be sent to them.';
  if (health.label === 'Not on WhatsApp') return 'This number isn’t on WhatsApp. Update the number in SAP.';
  if (health.tone === 'warn') return contact?.validationError ?? 'This number may be wrong. Check it in SAP.';
  return 'Documents are sent to this number automatically.';
}

export function CustomerDetailPage({
  route,
  customerId,
  onNavigate,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
  customerId: number;
  onNavigate: (path: string) => void;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAllDocuments, setShowAllDocuments] = useState(false);

  const load = useCallback(async () => {
    try {
      setCustomer(await apiRequest<CustomerDetail>(`/customers/${customerId}`));
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  const whatsapp = useMemo(() => (customer?.contacts ?? []).filter((contact) => contact.channel === 'whatsapp'), [customer]);
  const primary = whatsapp.find((contact) => contact.isPrimary) ?? whatsapp[0] ?? null;
  const health = contactHealth(primary);
  const reachable = health.tone === 'ok' || health.tone === 'warn';

  const unpaid = useMemo(() => (customer?.payments ?? [])
    .filter((payment) => !payment.resolved && payment.outstandingAmount > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue), [customer]);
  const currency = unpaid[0]?.currency ?? 'INR';
  const due = unpaid.reduce((sum, payment) => sum + payment.outstandingAmount, 0);
  const late = unpaid.filter((payment) => payment.daysOverdue > 0);
  const lateAmount = late.reduce((sum, payment) => sum + payment.outstandingAmount, 0);

  const documents = useMemo(() => {
    const all = customer?.documents ?? [];
    // Failed documents first: they are the only ones that need someone to act.
    return [...all.filter((document) => document.status === 'failed'), ...all.filter((document) => document.status !== 'failed')];
  }, [customer]);
  const failed = documents.filter((document) => document.status === 'failed');
  const lastSent = customer?.documents.find((document) => document.sentAt)?.sentAt ?? customer?.documents[0]?.createdAt ?? null;
  const shownDocuments = showAllDocuments ? documents : documents.slice(0, DOCUMENTS_PREVIEW);

  const summary: { tone: PageTone; pill: string; title: string; detail: string; next: string } | null = !customer ? null
    : !reachable
      ? { tone: 'critical', pill: 'Can’t reach on WhatsApp', title: `We can’t reach ${customer.name} on WhatsApp`, detail: contactExplanation(primary), next: 'Fix the WhatsApp number in SAP. Nothing will be delivered until then.' }
      : failed.length > 0
        ? { tone: 'critical', pill: `${failed.length} not delivered`, title: `${failed.length} ${failed.length === 1 ? 'document didn’t' : 'documents didn’t'} reach ${customer.name}`, detail: failed[0].failureReason ?? 'Open the document to see why.', next: 'Open the document below and try again.' }
        : late.length > 0
          ? { tone: 'late', pill: `${late.length} overdue`, title: `${formatCurrency(lateAmount, currency)} is overdue`, detail: `${formatCurrency(lateAmount, currency)} overdue on ${late.length} ${late.length === 1 ? 'invoice' : 'invoices'}. Reminders are being sent.`, next: '' }
          : { tone: 'paid', pill: 'Up to date', title: `${customer.name} is up to date`, detail: documents.length ? 'All documents delivered. Nothing overdue.' : 'Nothing sent yet.', next: '' };

  return (
    <AppShell
      route={route}
      eyebrow={customer?.sapCustomerNumber ? `Customer code ${customer.sapCustomerNumber}` : undefined}
      title={customer?.name ?? 'Customer'}
      headerLeading={<BackLink fallbackPath="/customers" fallbackLabel="Customers" onNavigate={onNavigate} />}
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
    >
      {error && <div className="alert alert--error">{error}</div>}
      {loading && <div className="detail-skeleton"><span /><div><span /><span /></div></div>}
      {customer && summary && (
        <div className="pf" data-tone={summary.tone}>
          <div className="pf-main">
            <header className="pf-hero pf-rise" style={rise(0)}>
              <span className="pf-pill"><i aria-hidden="true" />{summary.pill}</span>
              <h2 className="pf-hero__name">{customer.name}</h2>
              <p className="pf-hero__detail"><span>{summary.detail}</span></p>
            </header>

            <dl className="pf-ledger pf-rise" style={rise(1)}>
              <div><dt>Amount due</dt><dd>{due > 0 ? formatCurrency(due, currency) : '—'}</dd><small>{unpaid.length ? `${unpaid.length} unpaid ${unpaid.length === 1 ? 'invoice' : 'invoices'}` : 'Nothing to pay'}</small></div>
              <div><dt>Overdue</dt><dd className={lateAmount > 0 ? 'pf-neg' : undefined}>{lateAmount > 0 ? formatCurrency(lateAmount, currency) : '—'}</dd><small>{late.length ? `${late.length} past due date` : 'Nothing late'}</small></div>
              <div><dt>Documents sent</dt><dd>{documents.length}</dd><small>{failed.length ? <span className="text-danger">{failed.length} not delivered</span> : documents.length ? 'All delivered' : 'None yet'}</small></div>
              <div><dt>Last sent</dt><dd>{lastSent ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(lastSent)) : '—'}</dd><small>{lastSent ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(lastSent)) : ' '}</small></div>
            </dl>

            <section className="pf-section pf-rise" style={rise(2)} aria-label="Unpaid invoices">
              <header className="pf-section__head">
                <h3>Unpaid invoices</h3>
                <span>{unpaid.length ? 'Most overdue first' : ''}</span>
              </header>
              {unpaid.length === 0 ? (
                <p className="pf-list__empty"><CheckCheck size={16} aria-hidden="true" /> Nothing to pay right now.</p>
              ) : (
                <ul className="pf-list">
                  {unpaid.map((payment) => (
                    <li key={payment.invoice}>
                      <button type="button" disabled={!payment.caseId} onClick={() => payment.caseId && onNavigate(`/payments/${payment.caseId}`)}>
                        <span className="pf-list__main">
                          <strong>Invoice {payment.invoice}</strong>
                          <small>Due {formatDate(payment.dueDate)}{payment.nextReminderAt ? ` · next reminder ${formatDateTime(payment.nextReminderAt)}` : ''}</small>
                        </span>
                        <span className="pf-list__end">
                          <strong>{formatCurrency(payment.outstandingAmount, payment.currency)}</strong>
                          <small className={payment.daysOverdue > 0 ? 'text-danger' : ''}>{payment.daysOverdue > 0 ? `${payment.daysOverdue} ${payment.daysOverdue === 1 ? 'day' : 'days'} late` : payment.agingBucket === 'due' ? 'Due today' : 'Not yet due'}</small>
                        </span>
                        <ChevronRight size={16} aria-hidden="true" className="pf-list__chevron" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="pf-section pf-rise" style={rise(3)} aria-label="Documents sent">
              <header className="pf-section__head">
                <h3>Documents sent</h3>
                <span>{failed.length ? 'Not delivered shown first' : 'Newest first'}</span>
              </header>
              {documents.length === 0 ? (
                <p className="pf-list__empty"><UserRound size={16} aria-hidden="true" /> Nothing has been sent to this customer yet.</p>
              ) : (
                <>
                  <ul className="pf-list">
                    {shownDocuments.map((document) => (
                      <li key={document.jobId}>
                        <button type="button" onClick={() => onNavigate(`/documents/${document.jobId}`)}>
                          <span className="document-type-code">{document.type ?? '—'}</span>
                          <span className="pf-list__main">
                            <strong>{document.document ? `${billingDocumentLabel(document.type)} ${document.document}` : `Document #${document.jobId}`}</strong>
                            <small>
                              {formatDate(document.documentDate)}
                              {document.amount !== null ? ` · ${formatCurrency(Number(document.amount), document.currency)}` : ''}
                            </small>
                          </span>
                          <StatusBadge status={document.status} />
                          <ChevronRight size={16} aria-hidden="true" className="pf-list__chevron" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {documents.length > DOCUMENTS_PREVIEW && (
                    <button className="pf-more" type="button" onClick={() => setShowAllDocuments((open) => !open)}>
                      {showAllDocuments ? 'Show fewer' : `Show all ${documents.length} documents`}
                    </button>
                  )}
                </>
              )}
            </section>

            <details className="ds-tech pf-tech">
              <summary>Technical details</summary>
              <dl className="dt-details dt-details--stacked">
                <div><dt>Customer code</dt><dd>{customer.sapCustomerNumber ?? '—'}</dd></div>
                <div><dt>Business partner</dt><dd>{customer.sapBusinessPartnerId ?? '—'}</dd></div>
                <div><dt>Legal name</dt><dd>{customer.legalName ?? '—'}</dd></div>
                <div><dt>Language</dt><dd>{customer.languageCode?.toUpperCase() ?? '—'}</dd></div>
                <div><dt>Last updated from SAP</dt><dd>{formatDateTime(customer.lastSyncedAt)}</dd></div>
                <div><dt>Status in SAP</dt><dd>{customer.isActive ? 'Active' : 'Inactive'}</dd></div>
              </dl>
            </details>
          </div>

          <aside className="pf-side pf-rise" style={rise(2)} aria-label="WhatsApp">
            <p className="pf-kicker">How we reach them</p>
            {primary ? (
              <>
                <p className="pf-side__number mono">{primary.phone}</p>
                <span className={`health health--${health.tone}`}>{health.label}</span>
              </>
            ) : <p className="pf-side__number">No WhatsApp number</p>}
            <p className="pf-side__note">{contactExplanation(primary)}</p>
            {whatsapp.length > 1 && (
              <ul className="pf-side__others">
                {whatsapp.filter((contact) => contact !== primary).map((contact) => {
                  const state = contactHealth(contact);
                  return (
                    <li key={contact.id}>
                      <span className="mono">{contact.phone}</span>
                      <span className={`health health--${state.tone}`}>{state.label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <dl className="pf-rows pf-side__rows">
              <StatementRow label="Customer code">{customer.sapCustomerNumber ?? '—'}</StatementRow>
            </dl>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
