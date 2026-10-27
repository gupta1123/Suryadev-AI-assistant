import { Download, ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { Amount, Bubble, Journey, PhoneFrame, formatTime } from '../components/statement';
import { apiRequest } from '../lib/api';
import { billingDocumentAmountLabel, billingDocumentAttachmentMessage, billingDocumentLabel, billingDocumentMessage, billingDocumentSignature } from '../lib/billing-documents';
import { formatDate, formatDateTime, toMessage } from '../lib/format';
import type { AdminUser, AppRoute } from '../types';

export type MarketingCopyDetail = {
  id: number; sourceJobId: number; recipient: string;
  status: 'pending' | 'processing' | 'accepted' | 'failed' | 'unknown';
  attemptCount: number; acceptedAt: string | null; createdAt: string; lastError: string | null;
  customerName: string; customerNumber: string; documentNumber: string; documentType: string;
  documentDate: string; kind: 'document' | 'reminder'; templateName: string;
  variables: Record<string, string>; document: { fileName: string; url: string; downloadUrl: string } | null;
};

export function MarketingManagerDetailPage(props: {
  route: AppRoute; copyId: number; onNavigate: (path: string) => void;
  user: AdminUser; onLogout: () => Promise<void>; loggingOut: boolean;
}) {
  const [copy, setCopy] = useState<MarketingCopyDetail | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const load = useCallback(async (silent = false) => {
    setRefreshing(true);
    try {
      const next = await apiRequest<MarketingCopyDetail>(`/invoice-delivery/marketing-copies/${props.copyId}`);
      setCopy((previous) => silent && previous?.document && next.document ? { ...next, document: previous.document } : next);
      setError('');
    } catch (e) { setError(toMessage(e)); }
    finally { setRefreshing(false); }
  }, [props.copyId]);
  useEffect(() => { setCopy(null); setShowPdf(false); void load(); }, [load]);
  useEffect(() => {
    if (!copy || !['pending', 'processing'].includes(copy.status)) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [copy?.status, load]);
  const label = copy?.kind === 'reminder' ? 'Payment reminder' : billingDocumentLabel(copy?.documentType);
  const variables = copy?.variables ?? {};
  const amountText = copy?.kind === 'reminder' ? variables.var_2 : variables.var_4;
  const amount = Number((amountText ?? '').replace(/,/g, ''));
  const critical = copy?.status === 'failed' || copy?.status === 'unknown';
  const statusLabel = copy ? ({ pending: 'Copy queued', processing: 'Sending copy', accepted: 'Provider accepted', failed: 'Copy failed', unknown: 'Outcome unknown' })[copy.status] : '';

  return <AppShell {...props} title={copy ? `${label} ${copy.documentNumber}` : 'Manager copy'} eyebrow="Manager copy" headerLeading={<BackLink fallbackPath="/marketing-manager" fallbackLabel="Manager copies" onNavigate={props.onNavigate} />}>
    {error && <div className="alert alert--error">{error}</div>}
    {!copy ? !error && <div className="detail-skeleton"><span /><div><span /><span /></div></div> : (
      <div className="pf pf--stack pf--doc" data-tone={critical ? 'critical' : 'calm'}>
        <div className="dd-layout">
          <div className="dd-main">
            <section className="dd-card dd-summary" aria-label="Manager copy summary">
              <div className="dd-summary__top">
                <span className="pf-pill"><i />{statusLabel}</span>
                <div className="pf-actions">
                  {copy.document && <><a className="pf-btn pf-btn--solid" href={copy.document.downloadUrl} target="_blank" rel="noreferrer"><Download size={14} /> Download PDF</a><button className="pf-btn pf-btn--ghost" onClick={() => setShowPdf(!showPdf)}><FileText size={14} />{showPdf ? 'Hide PDF' : 'View PDF'}</button></>}
                  <button className="pf-btn pf-btn--ghost" disabled={refreshing} onClick={() => void load()}><RefreshCw size={14} /> Refresh</button>
                </div>
              </div>
              <div className="dd-figure"><div><p className="pf-hero__label">{copy.kind === 'reminder' ? 'Outstanding amount' : billingDocumentAmountLabel(copy.documentType)}</p><Amount value={amount} currency="INR" available={Boolean(amountText) && Number.isFinite(amount)} /></div><p className="dd-headline">Copy for the marketing manager</p></div>
              <p className="set-note">{copy.recipient} · Customer: {copy.customerName}. Provider acceptance is not a delivery or read receipt.</p>
              {copy.lastError && <div className="dd-notice" role="alert"><p>{copy.lastError}</p></div>}
              <Journey title="What happened" hint="Manager copy only" label="Manager copy history" items={[
                { key: 'queued', title: 'Copy queued', detail: formatDateTime(copy.createdAt), state: 'done' },
                { key: 'accepted', title: 'Provider accepted', detail: copy.acceptedAt ? formatDateTime(copy.acceptedAt) : statusLabel, state: copy.acceptedAt ? 'done' : critical ? 'bad' : 'now' },
              ]} />
            </section>
            {showPdf && copy.document && <section className="ds-pdf" aria-label="Manager copy PDF"><header><strong>{copy.document.fileName}</strong><a href={copy.document.url} target="_blank" rel="noreferrer">Open in new tab</a></header><iframe src={`${copy.document.url}#toolbar=1&navpanes=0&view=FitH`} title={`Manager copy ${copy.documentNumber}`} /></section>}
            <section className="dd-card dd-details" aria-label="Manager copy details">
              <dl className="dd-facts">
                <div><dt>Copied to</dt><dd className="mono">{copy.recipient}</dd></div>
                <div><dt>Customer</dt><dd>{copy.customerName}</dd></div>
                <div><dt>Customer code</dt><dd>{copy.customerNumber}</dd></div>
                <div><dt>Document</dt><dd>{label}</dd></div>
                <div><dt>Number</dt><dd>{copy.documentNumber}</dd></div>
                <div><dt>Dated</dt><dd>{formatDate(copy.documentDate)}</dd></div>
                <div><dt>Copy status</dt><dd>{statusLabel}</dd></div>
                <div><dt>Delivered / read</dt><dd>Not tracked</dd><small>Customer receipts are separate.</small></div>
              </dl>
              <details className="ds-tech pf-tech"><summary>Technical details</summary><dl className="dt-details dt-details--stacked"><div><dt>Copy reference</dt><dd>#{copy.id}</dd></div><div><dt>Template</dt><dd>{copy.templateName}</dd></div><div><dt>Attempts</dt><dd>{copy.attemptCount}</dd></div></dl></details>
            </section>
          </div>
          <MarketingCopyMessage copy={copy} onViewPdf={() => setShowPdf(true)} />
        </div>
      </div>
    )}
  </AppShell>;
}

export function MarketingCopyMessage({ copy, onViewPdf }: { copy: MarketingCopyDetail; onViewPdf?: () => void }) {
  const label = copy.kind === 'reminder' ? 'Payment reminder' : billingDocumentLabel(copy.documentType);
  const variables = copy.variables;
  const modern = copy.templateName !== 'share_invoice';
  const buttons = ['share_invoice', 'share_invoice_with_buttons_v2'].includes(copy.templateName);
  const statusLabel = ({ pending: 'Copy queued', processing: 'Sending copy', accepted: 'Provider accepted', failed: 'Copy failed', unknown: 'Outcome unknown' })[copy.status];
  return <PhoneFrame name="Marketing manager" subtitle={copy.recipient} badge={label}>
            <section className="pf-day"><h4>{formatDate(copy.acceptedAt ?? copy.createdAt)}</h4><div className="pf-turn"><Bubble scheduled time={formatTime(copy.acceptedAt ?? copy.createdAt)}>
              {copy.document && <div className="dt-attachment"><span className="dt-attachment__icon"><FileText size={18} /></span><span className="dt-attachment__name"><strong>{copy.document.fileName}</strong><small>PDF</small></span>{onViewPdf ? <button onClick={onViewPdf} aria-label="View manager copy PDF"><ExternalLink size={15} /></button> : <a href={copy.document.url} target="_blank" rel="noreferrer" aria-label="Open manager copy PDF"><ExternalLink size={15} /></a>}</div>}
              <p>{modern ? 'Hello' : 'Dear'} {variables.var_1 ?? copy.customerName},</p>
              {copy.kind === 'reminder' ? <><p>This is a payment reminder for <strong>₹{variables.var_2}</strong> pending against invoice <strong>{variables.var_3}</strong> dated <strong>{variables.var_4}</strong>.</p><p>Please arrange payment at your earliest convenience. If payment is not made on or before the due date, interest will be levied at 24% per annum. If payment has already been made, please ignore this message.</p><p>Regards,<br />Suryadev Alloys and Power Private Limited</p></> : <>
                <p>{billingDocumentMessage(copy.documentType, variables.var_2 ?? copy.documentNumber, variables.var_3 ?? formatDate(copy.documentDate), copy.templateName)}</p>
                <p><strong>{billingDocumentAmountLabel(copy.documentType)}:</strong> ₹{variables.var_4}</p>
                <p>{billingDocumentAttachmentMessage(copy.documentType, copy.templateName)}</p>
                <p>Thank you,<br />{billingDocumentSignature(copy.documentType, variables.var_5 ?? 'SuryaDev', copy.templateName)}</p>
                {copy.templateName === 'share_invoice' && <><p>For invoice-related queries, please reply to this message.</p><small>Transactional update</small></>}
                {buttons && <p className="set-note">Confirm Received · Need Help</p>}
              </>}
              <small>{formatTime(copy.acceptedAt ?? copy.createdAt)} · {statusLabel}</small>
            </Bubble><p className="pf-notice">Message preview. No manager delivery/read confirmation is inferred.</p></div></section>
          </PhoneFrame>;
}
