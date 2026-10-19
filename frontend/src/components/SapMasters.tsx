import { RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilterBar, FilterSelect, matchesSearch } from './FilterBar';
import { PaginationControls, usePagination } from './PaginationControls';
import { apiRequest } from '../lib/api';
import { formatDateTime, toMessage } from '../lib/format';
import type { MessagingCustomer, MessagingOverview } from '../types';
import { EligibilityModal, EnableMessagingModal, ManagerModal } from './MessagingModals';

type Directory = {
  source: 'sap'; checkedAt: string;
  managerMappingAvailable: boolean;
  items: {
    customerNumber: string; name: string; primaryPhone: string | null; phones: { number: string; isDefault: boolean }[];
    salesAssignments: {
      salesOrganization: string; distributionChannel: string; division: string;
      salesGroup: string; salesOffice: string; marketingManagerPhone: string | null;
      managerStatus: 'mapped' | 'missing' | 'unavailable' | 'conflicting';
    }[];
  }[];
};

type MessagingModal = { kind: 'enable' | 'disable' | 'manager' | 'eligibility'; customerNumber: string };
const MESSAGING_LABEL: Record<MessagingCustomer['status'], { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' }> = {
  enabled: { text: 'Enabled', tone: 'ok' },
  not_enabled: { text: 'Not enabled', tone: 'none' },
  phone_changed: { text: 'Paused · SAP number changed', tone: 'bad' },
  locked: { text: 'Not permitted by server', tone: 'none' },
};

export function SapMasters() {
  const [overview, setOverview] = useState<MessagingOverview | null>(null);
  const [overviewError, setOverviewError] = useState('');
  const [messagingFilter, setMessagingFilter] = useState('permitted');
  const [modal, setModal] = useState<MessagingModal | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const [managerFilter, setManagerFilter] = useState('');
  const load = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      setDirectory(await apiRequest<Directory>(`/customers/sap-masters${refresh ? '?refresh=true' : ''}`));
      setError('');
    } catch (failure) { setError(toMessage(failure)); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  const loadOverview = useCallback(async () => {
    try {
      const next = await apiRequest<MessagingOverview>('/messaging/overview');
      setOverview(next);
      setOverviewError('');
    } catch (failure) { setOverviewError(toMessage(failure)); }
  }, []);
  useEffect(() => { void load(); void loadOverview(); }, [load, loadOverview]);
  const messagingByCustomer = useMemo(
    () => new Map((overview?.customers ?? []).map((item) => [item.customerNumber, item])),
    [overview],
  );
  const activeModalCustomer = modal ? messagingByCustomer.get(modal.customerNumber) : undefined;
  const afterChange = useCallback(async () => { setModal(null); await loadOverview(); }, [loadOverview]);
  const rows = useMemo(() => (directory?.items ?? []).filter((row) =>
    matchesSearch(search, row.name, row.customerNumber, ...row.phones.map((phone) => phone.number),
      ...row.salesAssignments.flatMap((area) => [area.salesGroup, area.salesOffice, area.marketingManagerPhone ?? ''])) &&
    (!phoneFilter || (phoneFilter === 'missing' ? row.phones.length === 0 : row.phones.length > 0)) &&
    (!managerFilter || row.salesAssignments.some((area) => Boolean(area.marketingManagerPhone)) === (managerFilter === 'present')) &&
    matchesMessaging(messagingFilter, messagingByCustomer.get(row.customerNumber)),
  ), [directory, search, phoneFilter, managerFilter, messagingFilter, messagingByCustomer]);
  const pagination = usePagination(rows, 'sap-masters', `${search}|${phoneFilter}|${managerFilter}|${messagingFilter}`);
  return <>
    <div className="set-status">
      <div><strong>SAP customer directory</strong><small>{directory ? `${directory.items.length} customers · Last read ${formatDateTime(directory.checkedAt)}` : 'Read directly from SAP, not generated test records.'}</small></div>
      <button type="button" className="button button--secondary" disabled={refreshing} onClick={() => void load(true)}><RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> {refreshing ? 'Reading SAP…' : 'Refresh from SAP'}</button>
    </div>
    {overviewError && <div className="alert alert--error" role="alert">Messaging controls could not be loaded: {overviewError}</div>}
    <p className="set-note">Read-only SAP contact numbers. Primary number follows the invoice sender’s SAP number selection. Listing a customer does not enable sending or confirm that a number is registered on WhatsApp.</p>
    {directory && !directory.managerMappingAvailable && <div className="alert" role="status">Marketing manager numbers are unavailable: the SAP SALES GROUP mapping could not be read. Ask the SAP administrator to check read access to YY1_SALESGROUP_CDS, then refresh. Customer numbers and sales areas are still shown.</div>}
    {error && <div className="alert alert--error">{error}{directory && ' The previously loaded list is shown below.'}</div>}
    <section className="list-section">
      <FilterBar search={search} searchPlaceholder="Search customer, code, sales group, office or number" onSearchChange={setSearch} active={Boolean(search || phoneFilter || managerFilter || messagingFilter)} onClear={() => { setSearch(''); setPhoneFilter(''); setManagerFilter(''); setMessagingFilter(''); }}>
        <FilterSelect label="Messaging" value={messagingFilter} options={[{ value: 'permitted', label: 'Server-approved customers' }, { value: 'enabled', label: 'Enabled' }, { value: 'not_enabled', label: 'Not enabled' }]} onChange={setMessagingFilter} />
        <FilterSelect label="Phone" value={phoneFilter} options={[{ value: 'present', label: 'With number' }, { value: 'missing', label: 'Missing number' }]} onChange={setPhoneFilter} />
        <FilterSelect label="Marketing manager" value={managerFilter} options={[{ value: 'present', label: 'Number available' }, { value: 'missing', label: 'Number not available' }]} onChange={setManagerFilter} />
      </FilterBar>
      {managerFilter && <p className="set-note">Number available means at least one sales area has a marketing manager number. Number not available includes missing, conflicting or inaccessible SAP mappings.</p>}
      {loading ? <div className="table-skeleton"><span /><span /><span /></div> : !directory ? <div className="empty-table"><strong>Unable to load SAP masters</strong><p>Refresh to try reading SAP again.</p></div> : !rows.length ? <div className="empty-table"><Users size={26} aria-hidden="true" /><strong>No matching customers</strong><p>Try clearing the search or filters.</p></div> : <>
        <div className="table-scroll"><table className="customers-table sap-masters-table"><thead><tr><th>Customer</th><th>SAP code</th><th>Customer number</th><th>Other numbers</th><th>Sales area<br /><small>Org / Channel / Division</small></th><th>Sales group</th><th>Sales office</th><th>SAP marketing manager</th><th>Messaging</th><th>Manager copy goes to</th></tr></thead><tbody>
          {pagination.pageRows.map((row) => <tr key={row.customerNumber}>
            <td><strong className="invoice-number">{row.name}</strong></td><td className="mono">{row.customerNumber}</td>
            <td className="mono">{row.primaryPhone ? `+${row.primaryPhone}` : <span className="health health--warn">Not maintained</span>}</td>
            <td>{row.phones.filter((phone) => phone.number !== row.primaryPhone).map((phone) => <small className="mono" key={phone.number}>+{phone.number}{phone.isDefault ? ' · SAP default' : ''}</small>)}</td>
            <td className="mono">{row.salesAssignments.length ? row.salesAssignments.map((area, index) => <div className="sap-master-assignment" key={index}>{area.salesOrganization || '—'} / {area.distributionChannel || '—'} / {area.division || '—'}</div>) : 'Not maintained'}</td>
            <td className="mono">{row.salesAssignments.map((area, index) => <div className="sap-master-assignment" key={index}>{area.salesGroup || '—'}</div>)}</td>
            <td className="mono">{row.salesAssignments.map((area, index) => <div className="sap-master-assignment" key={index}>{area.salesOffice || '—'}</div>)}</td>
            <td>{row.salesAssignments.length ? row.salesAssignments.map((area, index) => <div className="sap-master-assignment" key={index}>{area.marketingManagerPhone ? <span className="mono">+{area.marketingManagerPhone}</span> : '—'}</div>) : '—'}</td>
            <MessagingCells customer={messagingByCustomer.get(row.customerNumber)} loaded={Boolean(overview)} onOpen={(kind) => setModal({ kind, customerNumber: row.customerNumber })} />
          </tr>)}
        </tbody></table></div>
        <PaginationControls page={pagination.page} pageCount={pagination.pageCount} pageSize={pagination.pageSize} total={pagination.total} noun="customers" disabled={refreshing} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize} />
      </>}
    </section>
    {(modal?.kind === 'enable' || modal?.kind === 'disable') && activeModalCustomer && <EnableMessagingModal mode={modal.kind} customer={activeModalCustomer} onClose={() => setModal(null)} onDone={afterChange} />}
    {modal?.kind === 'manager' && activeModalCustomer && <ManagerModal customer={activeModalCustomer} onClose={() => setModal(null)} onDone={afterChange} />}
    {modal?.kind === 'eligibility' && activeModalCustomer && <EligibilityModal customer={activeModalCustomer} onClose={() => setModal(null)} />}
  </>;
}

function matchesMessaging(filter: string, customer: MessagingCustomer | undefined): boolean {
  if (!filter) return true;
  if (!customer) return false;
  if (filter === 'permitted') return customer.status !== 'locked';
  if (filter === 'enabled') return customer.status === 'enabled' || customer.status === 'phone_changed';
  return customer.status === 'not_enabled';
}

function MessagingCells({ customer, loaded, onOpen }: {
  customer: MessagingCustomer | undefined; loaded: boolean; onOpen: (kind: MessagingModal['kind']) => void;
}) {
  if (!customer) return <><td>{loaded ? <span className="health health--none">Not permitted by server</span> : '…'}</td><td>—</td></>;
  const label = MESSAGING_LABEL[customer.status];
  const setting = customer.setting;
  return <>
    <td>
      <span className={`health health--${label.tone}`}>{label.text}</span>
      {customer.status !== 'locked' && <div className="sap-master-assignment">
        <button type="button" className="button button--secondary button--compact" onClick={() => onOpen(customer.status === 'not_enabled' ? 'enable' : 'disable')} disabled={customer.status === 'not_enabled' && !customer.livePhone}>
          {customer.status === 'not_enabled' ? 'Enable' : 'Disable'}
        </button>{' '}
        {customer.status === 'phone_changed' && <button type="button" className="button button--primary button--compact" onClick={() => onOpen('enable')}>Approve new number</button>}{' '}
        <button type="button" className="button button--secondary button--compact" onClick={() => onOpen('eligibility')}>Check</button>
      </div>}
    </td>
    <td>
      {setting?.managerPhone
        ? <><strong>{setting.managerName ?? 'Manager'}</strong><small className="mono"> +{setting.managerPhone}</small>{!customer.managerPhoneApproved && <small className="health health--bad"> Not on server list</small>}</>
        : <span className="health health--none">No manager · no copy</span>}
      {customer.status !== 'locked' && <div className="sap-master-assignment"><button type="button" className="button button--secondary button--compact" onClick={() => onOpen('manager')}>{setting?.managerPhone ? 'Change' : 'Assign'}</button></div>}
    </td>
  </>;
}
