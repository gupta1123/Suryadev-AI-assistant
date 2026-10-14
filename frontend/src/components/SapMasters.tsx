import { RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilterBar, FilterSelect, matchesSearch } from './FilterBar';
import { PaginationControls, usePagination } from './PaginationControls';
import { apiRequest } from '../lib/api';
import { formatDateTime, toMessage } from '../lib/format';

type Directory = {
  source: 'sap'; checkedAt: string;
  items: { customerNumber: string; name: string; primaryPhone: string | null; phones: { number: string; isDefault: boolean }[] }[];
};

export function SapMasters() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const load = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      setDirectory(await apiRequest<Directory>(`/customers/sap-masters${refresh ? '?refresh=true' : ''}`));
      setError('');
    } catch (failure) { setError(toMessage(failure)); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const rows = useMemo(() => (directory?.items ?? []).filter((row) =>
    matchesSearch(search, row.name, row.customerNumber, ...row.phones.map((phone) => phone.number)) &&
    (!phoneFilter || (phoneFilter === 'missing' ? row.phones.length === 0 : row.phones.length > 0)),
  ), [directory, search, phoneFilter]);
  const pagination = usePagination(rows, 'sap-masters', `${search}|${phoneFilter}`);
  return <>
    <div className="set-status">
      <div><strong>SAP customer directory</strong><small>{directory ? `${directory.items.length} customers · Last read ${formatDateTime(directory.checkedAt)}` : 'Read directly from SAP, not generated test records.'}</small></div>
      <button type="button" className="button button--secondary" disabled={refreshing} onClick={() => void load(true)}><RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> {refreshing ? 'Reading SAP…' : 'Refresh from SAP'}</button>
    </div>
    <p className="set-note">Read-only SAP contact numbers. Primary number follows the invoice sender’s SAP number selection. Listing a customer does not enable sending or confirm that a number is registered on WhatsApp.</p>
    {error && <div className="alert alert--error">{error}{directory && ' The previously loaded list is shown below.'}</div>}
    <section className="list-section">
      <FilterBar search={search} searchPlaceholder="Search customer, SAP code or mobile number" onSearchChange={setSearch} active={Boolean(search || phoneFilter)} onClear={() => { setSearch(''); setPhoneFilter(''); }}>
        <FilterSelect label="Phone" value={phoneFilter} options={[{ value: 'present', label: 'With number' }, { value: 'missing', label: 'Missing number' }]} onChange={setPhoneFilter} />
      </FilterBar>
      {loading ? <div className="table-skeleton"><span /><span /><span /></div> : !directory ? <div className="empty-table"><strong>Unable to load SAP masters</strong><p>Refresh to try reading SAP again.</p></div> : !rows.length ? <div className="empty-table"><Users size={26} aria-hidden="true" /><strong>No matching customers</strong><p>Try clearing the search or phone filter.</p></div> : <>
        <div className="table-scroll"><table className="customers-table"><thead><tr><th>Customer</th><th>SAP code</th><th>Primary number</th><th>Other numbers</th></tr></thead><tbody>
          {pagination.pageRows.map((row) => <tr key={row.customerNumber}>
            <td><strong className="invoice-number">{row.name}</strong></td><td className="mono">{row.customerNumber}</td>
            <td className="mono">{row.primaryPhone ? `+${row.primaryPhone}` : <span className="health health--warn">Not maintained</span>}</td>
            <td>{row.phones.filter((phone) => phone.number !== row.primaryPhone).map((phone) => <small className="mono" key={phone.number}>+{phone.number}{phone.isDefault ? ' · SAP default' : ''}</small>)}</td>
          </tr>)}
        </tbody></table></div>
        <PaginationControls page={pagination.page} pageCount={pagination.pageCount} pageSize={pagination.pageSize} total={pagination.total} noun="customers" disabled={refreshing} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize} />
      </>}
    </section>
  </>;
}
