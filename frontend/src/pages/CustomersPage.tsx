import { ChevronRight, RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { FilterBar, FilterSelect, matchesSearch } from '../components/FilterBar';
import { PaginationControls, usePagination } from '../components/PaginationControls';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDateTime, toMessage } from '../lib/format';
import type { AdminUser, AppRoute, CustomerContact, CustomerSummaryRow } from '../types';

export type ContactHealth = { tone: 'ok' | 'warn' | 'bad' | 'none'; label: string };

export function contactHealth(contact: CustomerContact | null): ContactHealth {
  if (!contact) return { tone: 'none', label: 'No number' };
  if (contact.doNotContact || contact.consentStatus === 'opted_out') return { tone: 'bad', label: 'Opted out' };
  if (contact.isWhatsappCapable === false) return { tone: 'bad', label: 'Not on WhatsApp' };
  if (contact.validationError) return { tone: 'warn', label: 'Check number' };
  if (!contact.isActive) return { tone: 'warn', label: 'Inactive' };
  return { tone: 'ok', label: 'Ready' };
}

const ATTENTION_OPTIONS = [
  { value: 'number', label: 'Number problem' },
  { value: 'failed', label: 'Has failed messages' },
  { value: 'overdue', label: 'Has late payments' },
];

export function CustomersPage({
  route,
  onNavigate,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
  onNavigate: (path: string) => void;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [customers, setCustomers] = useState<CustomerSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [attention, setAttention] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      setCustomers(await apiRequest<CustomerSummaryRow[]>('/customers'));
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => customers.filter((customer) => {
    const health = contactHealth(customer.whatsapp);
    const needs = !attention
      || (attention === 'number' && health.tone !== 'ok')
      || (attention === 'failed' && customer.failedDocuments > 0)
      || (attention === 'overdue' && customer.overdueAmount > 0);
    return needs && matchesSearch(search, customer.name, customer.legalName, customer.sapCustomerNumber, customer.whatsapp?.phone);
  }), [customers, search, attention]);
  const pagination = usePagination(filtered, 'customers', `${search}|${attention}`);
  const filtersActive = Boolean(search || attention);

  return (
    <AppShell
      route={route}
      eyebrow="Who receives your documents"
      title="Customers"
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={(
        <button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void load(true)}>
          <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh
        </button>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}
      <section className="list-section">
        <FilterBar
          search={search}
          searchPlaceholder="Search by name, customer code or phone"
          onSearchChange={setSearch}
          active={filtersActive}
          onClear={() => { setSearch(''); setAttention(''); }}
        >
          <FilterSelect label="Show" value={attention} options={ATTENTION_OPTIONS} onChange={setAttention} />
        </FilterBar>

        {loading ? <div className="table-skeleton"><span /><span /><span /></div> : filtered.length === 0 ? (
          <div className="empty-table">
            <Users size={26} aria-hidden="true" />
            <strong>{filtersActive ? 'Nothing matches your search' : 'No customers yet'}</strong>
            <p>{filtersActive ? 'Try a different search or clear the filters.' : 'Customers appear here once their first document comes in from SAP.'}</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="customers-table">
                <thead>
                  <tr><th>Customer</th><th>WhatsApp</th><th>Documents</th><th>Amount due</th><th>Last sent</th><th><span className="sr-only">Open</span></th></tr>
                </thead>
                <tbody>
                  {pagination.pageRows.map((customer) => {
                    const health = contactHealth(customer.whatsapp);
                    return (
                      <tr key={customer.id} className="row-link" onClick={() => onNavigate(`/customers/${customer.id}`)}>
                        <td>
                          <strong className="invoice-number">{customer.name}</strong>
                          <small>{customer.sapCustomerNumber ? `Code ${customer.sapCustomerNumber}` : '—'}</small>
                        </td>
                        <td>
                          <span className="mono">{customer.whatsapp?.phone ?? '—'}</span>
                          <small><span className={`health health--${health.tone}`}>{health.label}</span></small>
                        </td>
                        <td>
                          {customer.documentsSent}
                          <small>{customer.failedDocuments ? <span className="text-danger">{customer.failedDocuments} not delivered</span> : 'all delivered'}</small>
                        </td>
                        <td>
                          <strong>{customer.amountDue > 0 ? formatCurrency(customer.amountDue, customer.currency) : '—'}</strong>
                          <small>{customer.overdueAmount > 0 ? <span className="text-danger">{formatCurrency(customer.overdueAmount, customer.currency)} late</span> : customer.amountDue > 0 ? 'not late' : ''}</small>
                        </td>
                        <td>{formatDateTime(customer.lastDocumentAt)}</td>
                        <td>
                          <button className="row-open-button" type="button" onClick={(event) => { event.stopPropagation(); onNavigate(`/customers/${customer.id}`); }} aria-label={`Open ${customer.name}`}>
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationControls
              page={pagination.page}
              pageCount={pagination.pageCount}
              pageSize={pagination.pageSize}
              total={pagination.total}
              noun="customers"
              disabled={refreshing}
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
          </>
        )}
      </section>
    </AppShell>
  );
}
