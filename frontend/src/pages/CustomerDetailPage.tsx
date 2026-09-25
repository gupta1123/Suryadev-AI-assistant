import { AlertCircle, BadgeIndianRupee, CheckCheck, ChevronRight, MessageCircle, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
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

  const summary = !customer ? null
    : !reachable
      ? { tone: 'failed', icon: AlertCircle, title: `We can’t reach ${customer.name} on WhatsApp`, detail: contactExplanation(primary), next: 'Fix the WhatsApp number in SAP. Nothing will be delivered until then.' }
      : failed.length > 0
        ? { tone: 'failed', icon: AlertCircle, title: `${failed.length} ${failed.length === 1 ? 'document didn’t' : 'documents didn’t'} reach ${customer.name}`, detail: failed[0].failureReason ?? 'Open the document to see why.', next: 'Open the document below and try again.' }
        : late.length > 0
          ? { tone: 'overdue', icon: BadgeIndianRupee, title: `${customer.name} has ${formatCurrency(lateAmount, currency)} overdue`, detail: `${late.length} ${late.length === 1 ? 'invoice is' : 'invoices are'} past the due date. Reminders are going out on WhatsApp.`, next: 'Nothing to do unless the customer asks for help.' }
          : { tone: 'delivered', icon: CheckCheck, title: `${customer.name} is up to date`, detail: documents.length ? 'Every document reached them on WhatsApp, and nothing is overdue.' : 'Nothing has been sent to this customer yet.', next: 'Nothing to do.' };

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
        <div className="ds">
          <section className={`ds-summary ds-summary--${summary.tone}`} aria-label="Summary">
            <span className="ds-summary__icon"><summary.icon size={22} aria-hidden="true" /></span>
            <div className="ds-summary__text">
              <span className="ds-kind">Customer{customer.sapCustomerNumber ? ` ${customer.sapCustomerNumber}` : ''}</span>
              <h2>{summary.title}</h2>
              <p>{summary.detail}</p>
              <p className="ds-next"><strong>Next:</strong> {summary.next}</p>
            </div>
          </section>

          <dl className="ds-stats">
            <div><dt>Amount due</dt><dd>{due > 0 ? formatCurrency(due, currency) : '—'}</dd><small>{unpaid.length ? `${unpaid.length} unpaid ${unpaid.length === 1 ? 'invoice' : 'invoices'}` : 'Nothing to pay'}</small></div>
            <div className={lateAmount > 0 ? 'ds-stats--alert' : ''}><dt>Overdue</dt><dd>{lateAmount > 0 ? formatCurrency(lateAmount, currency) : '—'}</dd><small>{late.length ? `${late.length} past due date` : 'Nothing late'}</small></div>
            <div><dt>Documents sent</dt><dd>{documents.length}</dd><small>{failed.length ? <span className="text-danger">{failed.length} not delivered</span> : documents.length ? 'All delivered' : 'None yet'}</small></div>
            <div><dt>Last sent</dt><dd>{lastSent ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(lastSent)) : '—'}</dd><small>{lastSent ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(lastSent)) : ''}</small></div>
          </dl>

          <div className="ds-grid">
            <div className="ds-side">
              <section className="ds-card" aria-label="Unpaid invoices">
                <header className="ds-card__head">
                  <h3>Unpaid invoices</h3>
                  <span>{unpaid.length ? 'Most overdue first' : ''}</span>
                </header>
                {unpaid.length === 0 ? (
                  <p className="ds-empty"><CheckCheck size={16} aria-hidden="true" /> Nothing to pay right now.</p>
                ) : (
                  <ul className="ds-list">
                    {unpaid.map((payment) => (
                      <li key={payment.invoice}>
                        <button type="button" disabled={!payment.caseId} onClick={() => payment.caseId && onNavigate(`/payments/${payment.caseId}`)}>
                          <span className="ds-list__main">
                            <strong>Invoice {payment.invoice}</strong>
                            <small>Due {formatDate(payment.dueDate)}{payment.nextReminderAt ? ` · next reminder ${formatDateTime(payment.nextReminderAt)}` : ''}</small>
                          </span>
                          <span className="ds-list__end">
                            <strong>{formatCurrency(payment.outstandingAmount, payment.currency)}</strong>
                            <small className={payment.daysOverdue > 0 ? 'text-danger' : ''}>{payment.daysOverdue > 0 ? `${payment.daysOverdue} ${payment.daysOverdue === 1 ? 'day' : 'days'} late` : 'Not yet due'}</small>
                          </span>
                          <ChevronRight size={16} aria-hidden="true" className="ds-list__chevron" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="ds-card" aria-label="Documents sent">
                <header className="ds-card__head">
                  <h3>Documents sent</h3>
                  <span>{failed.length ? 'Not delivered shown first' : 'Newest first'}</span>
                </header>
                {documents.length === 0 ? (
                  <p className="ds-empty"><UserRound size={16} aria-hidden="true" /> Nothing has been sent to this customer yet.</p>
                ) : (
                  <>
                    <ul className="ds-list">
                      {shownDocuments.map((document) => (
                        <li key={document.jobId}>
                          <button type="button" onClick={() => onNavigate(`/documents/${document.jobId}`)}>
                            <span className="document-type-code">{document.type ?? '—'}</span>
                            <span className="ds-list__main">
                              <strong>{document.document ? `${billingDocumentLabel(document.type)} ${document.document}` : `Document #${document.jobId}`}</strong>
                              <small>
                                {formatDate(document.documentDate)}
                                {document.amount !== null ? ` · ${formatCurrency(Number(document.amount), document.currency)}` : ''}
                              </small>
                            </span>
                            <StatusBadge status={document.status} />
                            <ChevronRight size={16} aria-hidden="true" className="ds-list__chevron" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    {documents.length > DOCUMENTS_PREVIEW && (
                      <button className="ds-more" type="button" onClick={() => setShowAllDocuments((open) => !open)}>
                        {showAllDocuments ? 'Show fewer' : `Show all ${documents.length}`}
                      </button>
                    )}
                  </>
                )}
              </section>
            </div>

            <div className="ds-side">
              <section className="ds-card" aria-label="WhatsApp">
                <header className="ds-card__head"><h3>WhatsApp</h3></header>
                {primary ? (
                  <div className="ds-contact">
                    <span className="ds-contact__icon"><MessageCircle size={18} aria-hidden="true" /></span>
                    <div>
                      <strong className="mono">{primary.phone}</strong>
                      <span className={`health health--${health.tone}`}>{health.label}</span>
                    </div>
                  </div>
                ) : null}
                <p className="ds-contact__note">{contactExplanation(primary)}</p>
                {whatsapp.length > 1 && (
                  <ul className="ds-contact__others">
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
              </section>
            </div>
          </div>

          <details className="ds-tech">
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
      )}
    </AppShell>
  );
}
