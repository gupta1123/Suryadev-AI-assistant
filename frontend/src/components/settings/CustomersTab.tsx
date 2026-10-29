import { Info, RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { formatPhone, formatRelative, toMessage } from '../../lib/format';
import type { MessagingOverview, SapMasterDirectory } from '../../types';
import { FilterBar, FilterSelect, matchesSearch } from '../FilterBar';
import { PaginationControls, usePagination } from '../PaginationControls';
import { buildCustomerRows, managerSummary, STATUS_PILL, type CustomerRow, type CustomerStatus } from './customer-rows';
import { CustomerPanel, type PanelView } from './CustomerPanel';
import { Pill, Skeleton } from './ui';

type Chip = 'available' | 'enabled' | 'review' | 'off' | 'locked';

const CHIP_LABEL: Record<Chip, string> = {
  available: 'Can be messaged',
  enabled: 'On',
  review: 'Needs review',
  off: 'Off',
  locked: 'Not available',
};

function matchesManagerFilter(filter: string, kind: ReturnType<typeof managerSummary>['kind']): boolean {
  if (kind === 'na') return false;
  return filter === 'none' ? kind === 'none' : kind !== 'none';
}

function inChip(chip: Chip, status: CustomerStatus): boolean {
  if (chip === 'available') return status !== 'locked' && status !== 'nophone';
  if (chip === 'locked') return status === 'locked' || status === 'nophone';
  return status === chip;
}

export function CustomersTab({
  messaging,
  messagingError,
  onReload,
}: {
  messaging: MessagingOverview | null;
  messagingError: string;
  onReload: () => Promise<void>;
}) {
  const [directory, setDirectory] = useState<SapMasterDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chip, setChip] = useState<Chip>('available');
  const [search, setSearch] = useState('');
  const [numberFilter, setNumberFilter] = useState('');
  const [managerFilter, setManagerFilter] = useState('');
  const [panel, setPanel] = useState<{ number: string; view: PanelView } | null>(null);

  const load = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      setDirectory(await apiRequest<SapMasterDirectory>(`/customers/sap-masters${refresh ? '?refresh=true' : ''}`));
      setDirectoryError('');
    } catch (failure) {
      setDirectoryError(toMessage(failure));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => buildCustomerRows(directory?.items ?? [], messaging), [directory, messaging]);
  const counts = useMemo(() => {
    const result: Record<Chip, number> = { available: 0, enabled: 0, review: 0, off: 0, locked: 0 };
    for (const row of rows) {
      for (const key of Object.keys(result) as Chip[]) if (inChip(key, row.status)) result[key] += 1;
    }
    return result;
  }, [rows]);

  const visible = useMemo(() => rows.filter((row) =>
    inChip(chip, row.status)
    && matchesSearch(search, row.name, row.number, row.phone, row.messaging?.setting?.managerName,
      row.messaging?.managerCopy?.recipient,
      ...(row.sap?.salesAssignments.flatMap((area) => [area.salesGroup, area.salesOffice, area.marketingManagerPhone]) ?? []))
    && (!numberFilter || (numberFilter === 'missing' ? !row.phone : Boolean(row.phone)))
    && (!managerFilter || matchesManagerFilter(managerFilter, managerSummary(row).kind)),
  ), [rows, chip, search, numberFilter, managerFilter]);

  const pagination = usePagination(visible, 'settings-customers', `${chip}|${search}|${numberFilter}|${managerFilter}`);
  const panelRow = panel ? rows.find((row) => row.number === panel.number) : undefined;
  const reloadAll = useCallback(async () => { await onReload(); }, [onReload]);
  const open = (row: CustomerRow, view: PanelView) => setPanel({ number: row.number, view });

  const chips = (['available', 'enabled', 'review', 'off', 'locked'] as Chip[])
    .filter((key) => key !== 'review' || counts.review > 0 || chip === 'review');
  const showSkeleton = (loading && !directory) || (!messaging && !messagingError && !directory);

  return (
    <div className="st-stack">
      <div className="st-intro">
        <div>
          <h2>Who receives messages</h2>
          <p>
            Turn customers on to start sending them invoices and memos on WhatsApp.
            {directory && ` Customer list last read from SAP ${formatRelative(directory.checkedAt)}.`}
          </p>
        </div>
        <button type="button" className="button button--secondary" disabled={refreshing} onClick={() => void load(true).then(reloadAll)}>
          <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> {refreshing ? 'Reading SAP…' : 'Refresh from SAP'}
        </button>
      </div>

      <details className="st-how">
        <summary><Info size={15} aria-hidden="true" /> How turning a customer on works</summary>
        <ul className="st-bullets">
          <li>Turning a customer on approves their current SAP phone number. Only documents created after that are sent.</li>
          <li>If SAP later shows a different number, sending to that customer pauses until you approve the new one.</li>
          <li>Being in this list doesn’t mean the number is on WhatsApp.</li>
          <li>New SAP customers start Off. In dashboard approval mode, review their details and turn on only the customers you authorise.</li>
          <li>No WhatsApp messages are sent about documents dated before 20 October 2026, including reminders, manager copies and document-linked help alerts.</li>
        </ul>
      </details>

      {messagingError && <div className="alert alert--error" role="alert">Customer controls couldn’t be loaded: {messagingError}</div>}
      {messaging?.approvalBlocker && <div className="alert alert--error" role="alert">New-customer approval is unavailable: {messaging.approvalBlocker}</div>}
      {directoryError && (
        <div className="alert alert--error" role="alert">
          {directoryError}{directory ? ' The list below is from the last successful read.' : ' Customers who are already set up are still shown.'}
        </div>
      )}
      {directory && !directory.managerMappingAvailable && (
        <div className="alert alert--info" role="status">
          SAP’s marketing manager list couldn’t be read. SAP-routed manager copies will not use a manual fallback. Your SAP administrator can check access to <span className="mono">YY1_SALESGROUP_CDS</span>, then refresh.
        </div>
      )}

      <section className="st-card st-card--list">
        <div className="seg-tabs st-chips" role="group" aria-label="Show customers">
          {chips.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={chip === key}
              className={chip === key ? 'seg-tab seg-tab--active' : 'seg-tab'}
              onClick={() => setChip(key)}
            >
              {CHIP_LABEL[key]} <span>{counts[key]}</span>
            </button>
          ))}
        </div>

        <FilterBar
          search={search}
          searchPlaceholder="Search by name, code or number"
          onSearchChange={setSearch}
          active={Boolean(search || numberFilter || managerFilter)}
          onClear={() => { setSearch(''); setNumberFilter(''); setManagerFilter(''); }}
        >
          <FilterSelect label="Number" value={numberFilter} options={[{ value: 'has', label: 'Has a number' }, { value: 'missing', label: 'Missing' }]} onChange={setNumberFilter} />
          <FilterSelect label="Manager copy" value={managerFilter} options={[{ value: 'has', label: 'Has a copy' }, { value: 'none', label: 'No copy' }]} onChange={setManagerFilter} />
        </FilterBar>

        {chip === 'locked' && (
          <p className="st-callout"><Info size={15} aria-hidden="true" /> These customers can’t be turned on yet: SAP has no phone number for them, or approval isn’t available. Add the number in SAP, then refresh.</p>
        )}

        {showSkeleton ? <Skeleton rows={5} /> : !visible.length ? (
          <div className="empty-table">
            <Users size={26} aria-hidden="true" />
            <strong>{rows.length ? 'No customers match' : 'No customers to show'}</strong>
            <p>{rows.length ? 'Try a different search or filter.' : 'SAP didn’t return any customers. Try refreshing.'}</p>
          </div>
        ) : (
          <>
            <div className="st-cust-head" aria-hidden="true">
              <span>Customer</span><span>WhatsApp number</span><span>Messaging</span><span>Manager copy</span><span />
            </div>
            <ul className="st-cust-list">
              {pagination.pageRows.map((row) => (
                <CustomerListRow key={row.number} row={row} onOpen={open} />
              ))}
            </ul>
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

      {panel && panelRow && (
        <CustomerPanel row={panelRow} initialView={panel.view} onClose={() => setPanel(null)} onChanged={reloadAll} />
      )}
    </div>
  );
}

function CustomerListRow({ row, onOpen }: { row: CustomerRow; onOpen: (row: CustomerRow, view: PanelView) => void }) {
  const pill = STATUS_PILL[row.status];
  const manager = managerSummary(row);
  const initials = row.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join('') || '#';
  return (
    <li className={`st-cust st-cust--${row.status}`}>
      <div className="st-cust__who">
        <span className="st-avatar" aria-hidden="true">{initials}</span>
        <div>
          <strong>{row.name}</strong>
          <small>SAP {row.number}</small>
        </div>
      </div>
      <div className="st-cust__cell" data-label="WhatsApp number">
        {row.phone ? <span className="mono">{formatPhone(row.phone)}</span> : <span className="st-muted">Not in SAP</span>}
      </div>
      <div className="st-cust__cell" data-label="Messaging"><Pill tone={pill.tone}>{pill.label}</Pill></div>
      <div className="st-cust__cell" data-label="Manager copy">
        {manager.kind === 'na' ? <span className="st-muted">—</span> : (
          <>
            <span className={manager.kind === 'none' ? 'st-muted' : 'st-strong'}>{manager.title}</span>
            {manager.detail && manager.kind !== 'none' && <small className={manager.kind === 'assigned' || manager.kind === 'sap' ? 'mono' : undefined}>{manager.detail}</small>}
            {manager.warning && <small className="st-warn-text">{manager.warning}</small>}
          </>
        )}
      </div>
      <div className="st-cust__actions">
        {row.status === 'off' && (
          <button className="button button--primary st-sm" type="button" disabled={!row.phone} title={row.phone ? undefined : 'SAP has no number for this customer'} onClick={() => onOpen(row, 'enable')}>Turn on</button>
        )}
        {row.status === 'review' && (
          <button className="button button--primary st-sm" type="button" onClick={() => onOpen(row, 'enable')}>Review number</button>
        )}
        {row.status === 'enabled' && (
          <button className="button button--secondary st-sm" type="button" onClick={() => onOpen(row, 'disable')}>Turn off</button>
        )}
        <button className="button button--secondary st-sm" type="button" onClick={() => onOpen(row, 'overview')} aria-label={`Details for ${row.name}`}>Details</button>
      </div>
    </li>
  );
}
