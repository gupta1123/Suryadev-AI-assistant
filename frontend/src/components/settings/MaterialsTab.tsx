import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { toMessage, formatDateTime } from '../../lib/format';
import { FilterBar, FilterSelect, matchesSearch } from '../FilterBar';
import { PaginationControls, usePagination } from '../PaginationControls';
import { Modal } from '../Modal';
import { LiveNote, Pill, Skeleton } from './ui';

type Material = { code: string; description: string; group: string; enabled: boolean; source: string; updatedAt: string | null };
type Directory = { items: Material[]; directoryError: string | null; checkedAt: string | null; mode: string; note: string };

export function MaterialsTab() {
  const [data, setData] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [code, setCode] = useState('');
  const [selected, setSelected] = useState<Material | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = false, exactCode?: string) => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (refresh) params.set('refresh', 'true');
      if (exactCode) params.set('code', exactCode);
      setData(await apiRequest<Directory>(`/messaging/tmt-materials?${params}`));
      if (exactCode) { setSearch(exactCode); setStatus(''); }
    } catch (failure) { setError(toMessage(failure)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const filtered = useMemo(() => (data?.items ?? []).filter(row =>
    (!status || (status === 'on') === row.enabled) && matchesSearch(search, row.code, row.description, row.group)), [data, status, search]);
  const paging = usePagination(filtered, 'tmt-materials', `${status}|${search}`, 25);
  async function save() {
    if (!selected || !confirmed) return;
    setBusy(true); setError('');
    try {
      await apiRequest(`/messaging/tmt-materials/${encodeURIComponent(selected.code)}`, { method: 'PUT', body: JSON.stringify({
        enabled: !selected.enabled, expectedEnabled: selected.enabled, confirmMaterial: selected.code, acknowledgePending: confirmed,
      }) });
      setNotice(`${selected.code} is now ${selected.enabled ? 'Off' : 'On'}.`);
      setSelected(null); await load();
    } catch (failure) { setError(toMessage(failure)); }
    finally { setBusy(false); }
  }
  return <div className="st-section">
    <div className="st-sectionhead"><div><h2>TMT materials</h2></div>
      <button type="button" className="button button--secondary" disabled={loading || busy} onClick={() => void load(true)}><RefreshCw size={15} /> Refresh from SAP</button></div>
    {notice && <LiveNote>{notice}</LiveNote>}{error && <LiveNote tone="bad">{error}</LiveNote>}
    {data?.directoryError && <div className="alert alert--error">{data.directoryError}</div>}
    {data && data.mode !== 'dashboard' && <LiveNote tone="bad">Dashboard material controls are not active. Changes are locked.</LiveNote>}
    <form className="st-material-lookup" onSubmit={event => { event.preventDefault(); if (code.trim()) void load(false, code.trim().toUpperCase()); }}>
      <label>Exact SAP material code<input value={code} maxLength={40} placeholder="e.g. 30000032" onChange={event => setCode(event.target.value)} /></label>
      <button type="submit" className="button button--secondary" disabled={loading || !code.trim()}>Find in SAP</button></form>
    <FilterBar search={search} searchPlaceholder="Search material code, description or group" onSearchChange={setSearch} active={Boolean(search || status)} onClear={() => { setSearch(''); setStatus(''); }}>
      <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} /></FilterBar>
    {loading ? <Skeleton rows={5} /> : <>
      <div className="st-material-table"><table className="st-mini"><thead><tr><th>Material code</th><th>SAP description</th><th>Group</th><th>Status</th><th>Last changed</th><th>Action</th></tr></thead><tbody>
        {paging.pageRows.map(row => <tr key={row.code}><td className="mono">{row.code}</td><td>{row.description || '—'}</td><td>{row.group || '—'}</td><td><Pill tone={row.enabled ? 'ok' : 'off'}>{row.enabled ? 'On' : 'Off'}</Pill>{row.source === 'server_default' && <small className="st-hint">Existing server approval</small>}</td><td>{row.updatedAt ? formatDateTime(row.updatedAt) : '—'}</td><td><button type="button" className="button button--secondary st-sm" disabled={data?.mode !== 'dashboard' || busy} onClick={() => { setSelected(row); setConfirmed(false); setError(''); }}>{row.enabled ? 'Turn off' : 'Turn on'}</button></td></tr>)}
        {!paging.total && <tr><td colSpan={6}>No matching materials. Try the exact SAP code lookup above.</td></tr>}
      </tbody></table></div>
      <PaginationControls {...paging} noun="materials" onPageChange={paging.setPage} onPageSizeChange={paging.setPageSize} />
    </>}
    {data?.checkedAt && <p className="st-hint">Billing-material discovery last refreshed {formatDateTime(data.checkedAt)}.</p>}
    {selected && <Modal title={`${selected.enabled ? 'Turn off' : 'Turn on'} TMT material?`} description={`SAP material ${selected.code}`} onClose={() => { if (!busy) setSelected(null); }}>
      <div className="st-panel"><h3>{selected.code} — {selected.description || 'No description available'}</h3>
        <p>{selected.enabled ? 'All unsent document messages containing this material will be blocked at the next dispatch check, including reminders, manager copies and document-linked help alerts.' : 'Confirm this is a TMT material you authorise for WhatsApp. Enabling may release previously skipped or queued documents automatically on the next poll. Customer approval and document date rules still apply.'}</p>
        <p>This button does not directly send a message. Automatic sending may start after confirmation. Documents dated before 20 October 2026 remain blocked.</p>
        <label className="st-approval-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> I verified material {selected.code} and understand the effect on pending documents.</label>
        {error && <LiveNote tone="bad">{error}</LiveNote>}
        <div className="modal-footer"><button className="button button--secondary" disabled={busy} onClick={() => setSelected(null)}>Cancel</button><button className={selected.enabled ? 'button button--danger' : 'button button--primary'} disabled={busy || !confirmed} onClick={() => void save()}>{busy ? 'Saving…' : selected.enabled ? 'Turn off' : 'Turn on'}</button></div></div>
    </Modal>}
  </div>;
}
