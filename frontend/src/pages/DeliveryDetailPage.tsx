import {
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  Download,
  FileText,
  MessageCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Sun,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { apiRequest } from '../lib/api';
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
  DeliveryConfig,
  DeliveryJobDetail,
  DeliveryMessage,
  MessageAttempt,
} from '../types';
import { relationOne } from '../types';

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
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [job, setJob] = useState<DeliveryJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [zoomLevel, setZoomLevel] = useState(100);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const [nextConfig, nextJob] = await Promise.all([
        apiRequest<DeliveryConfig>('/invoice-delivery/config'),
        apiRequest<DeliveryJobDetail>(`/invoice-delivery/jobs/${jobId}`),
      ]);
      setConfig(nextConfig);
      setJob(nextJob);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);
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
  const latestAttempt = message?.message_attempts?.at(-1);
  const variables = useMemo(() => readTemplateVariables(latestAttempt), [latestAttempt]);
  const document = job?.invoice_documents?.find((item) => item.is_current) ?? job?.invoice_documents?.[0];
  const currentStatus = message?.status ?? job?.status ?? 'loading';

  // Format status title & date
  const statusInfo = getStatusBannerText(currentStatus, message, job);

  // Zoom handlers
  const handleZoomIn = () => setZoomLevel((prev) => Math.min(prev + 15, 150));
  const handleZoomOut = () => setZoomLevel((prev) => Math.max(prev - 15, 70));
  const handleZoomReset = () => setZoomLevel(100);

  return (
    <AppShell
      route={route}
      config={config}
      eyebrow={invoice?.sap_billing_document ? `Invoice #${invoice.sap_billing_document}` : `Delivery #${jobId}`}
      title={customer?.display_name ?? 'Delivery details'}
      headerLeading={(
        <button className="back-link" type="button" onClick={() => onNavigate('/deliveries')}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to deliveries
        </button>
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
              <Download size={16} aria-hidden="true" /> Download invoice
            </a>
          )}
        </>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}

      {loading || !job ? (
        <DetailSkeleton />
      ) : (
        <>
          {/* Status Banner */}
          <div className="status-banner-card">
            <div className={`status-banner-icon ${currentStatus === 'failed' ? 'status-banner-icon--failed' : ''}`}>
              <Check size={20} strokeWidth={2.8} aria-hidden="true" />
            </div>
            <div className="status-banner-content">
              <h3>{statusInfo.title}</h3>
              <p>{statusInfo.timestamp}</p>
            </div>
          </div>

          {/* 4-Item Summary Bar */}
          <div className="detail-summary-bar">
            <div className="summary-tile">
              <div className="summary-tile__icon">
                <UserRound size={19} aria-hidden="true" />
              </div>
              <div className="summary-tile__info">
                <small>Customer</small>
                <strong>{customer?.display_name ?? 'Sri Praveen Enterprises'}</strong>
              </div>
            </div>

            <div className="summary-tile">
              <div className="summary-tile__icon">
                <span style={{ fontSize: '1.05rem', fontWeight: 800 }}>₹</span>
              </div>
              <div className="summary-tile__info">
                <small>Amount</small>
                <strong>{formatCurrency(Number(invoice?.total_gross_amount ?? 236), invoice?.transaction_currency ?? 'INR')}</strong>
              </div>
            </div>

            <div className="summary-tile">
              <div className="summary-tile__icon">
                <CalendarDays size={19} aria-hidden="true" />
              </div>
              <div className="summary-tile__info">
                <small>Invoice date</small>
                <strong>{formatDate(invoice?.billing_document_date)}</strong>
              </div>
            </div>

            <div className="summary-tile">
              <div className="summary-tile__icon">
                <MessageCircle size={19} aria-hidden="true" />
              </div>
              <div className="summary-tile__info">
                <small>Sent to (WhatsApp)</small>
                <strong className="mono">{job.metadata?.masked_recipient ?? '+91 70•••• 9764'}</strong>
              </div>
            </div>
          </div>

          {/* Main 2-Column Section Layout */}
          <div className="detail-main-layout">
            {/* Left Column: WhatsApp Message & Timeline Progress */}
            <div className="whatsapp-card">
              <h2>WhatsApp message sent</h2>

              <div className="whatsapp-chat-box">
                {/* Chat Bubble */}
                <div className="whatsapp-bubble">
                  <p>Dear {variables.var_1 ?? customer?.display_name ?? 'Sri Praveen Enterprises'},</p>
                  <p>Your invoice <strong>{variables.var_2 ?? invoice?.sap_billing_document ?? '26SG00010'}</strong> dated {variables.var_3 ?? formatDate(invoice?.billing_document_date)} has been generated.</p>
                  <p>Invoice Amount: <strong>₹{variables.var_4 ?? Number(invoice?.total_gross_amount ?? 236).toLocaleString('en-IN') + '.00'}</strong></p>
                  <p>Please find the invoice PDF attached above.</p>
                  <p>Thank you,<br />Team {variables.var_5 ?? 'SuryaDev'}</p>

                  <div className="whatsapp-bubble-footer">
                    <span>{formatTimeOnly(message?.read_at ?? message?.delivered_at ?? message?.sent_at ?? job.created_at)}</span>
                    <span className="whatsapp-checks">✓✓</span>
                  </div>
                </div>

                {/* Attached Document Pill */}
                {document && (
                  <div className="whatsapp-doc-chip">
                    <div className="whatsapp-doc-icon">PDF</div>
                    <div className="whatsapp-doc-info">
                      <strong>{document.file_name ?? `Invoice-${invoice?.sap_billing_document ?? '26SG00010'}.pdf`}</strong>
                      <small>{formatBytes(document.size_bytes ?? 172032)} • PDF</small>
                    </div>
                    {document.download_url && (
                      <a
                        className="whatsapp-doc-download"
                        href={document.download_url}
                        target="_blank"
                        rel="noreferrer"
                        title="Download attachment"
                      >
                        <Download size={16} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                )}
              </div>

              {/* Horizontal Step Timeline */}
              <HorizontalTimeline message={message} job={job} />

              {/* Retry bar if job failed */}
              {job.status === 'failed' && (
                <div className="retry-bar" style={{ marginTop: 24 }}>
                  <div>
                    <strong>Delivery failed</strong>
                    <p>{job.last_error ?? 'Review details before retrying.'}</p>
                  </div>
                  <button className="button button--primary" type="button" disabled={retrying} onClick={() => void retry()}>
                    <RotateCcw size={15} aria-hidden="true" /> {retrying ? 'Re-queueing…' : 'Retry delivery'}
                  </button>
                </div>
              )}
            </div>

            {/* Right Column: Invoice Document Preview */}
            <div className="invoice-preview-card">
              <div className="invoice-preview-header">
                <h2>Invoice preview</h2>
                <div className="zoom-controls">
                  <button className="zoom-button" type="button" onClick={handleZoomOut} title="Zoom out">-</button>
                  <span className="zoom-level" onClick={handleZoomReset} style={{ cursor: 'pointer' }}>{zoomLevel}%</span>
                  <button className="zoom-button" type="button" onClick={handleZoomIn} title="Zoom in">+</button>
                  {document?.download_url && (
                    <a className="zoom-button" href={document.download_url} target="_blank" rel="noreferrer" title="Download PDF">
                      <Download size={14} />
                    </a>
                  )}
                </div>
              </div>

              <div className="invoice-sheet-container">
                <div
                  className="tax-invoice-sheet"
                  style={{
                    transform: `scale(${zoomLevel / 100})`,
                    transformOrigin: 'top left',
                    width: zoomLevel > 100 ? `${100 * (100 / zoomLevel)}%` : '100%',
                  }}
                >
                  {/* Company Top Bar */}
                  <div className="invoice-top-bar">
                    <div className="company-brand-header">
                      <Sun className="sun-logo-svg" />
                      <div>
                        <strong>SuryaDev</strong>
                        <small>Steel Company</small>
                      </div>
                    </div>

                    <div className="invoice-meta-top">
                      <h3>TAX INVOICE</h3>
                      <p><strong>Invoice No.:</strong> {invoice?.sap_billing_document ?? '26SG00010'}</p>
                      <p><strong>Invoice Date:</strong> {formatDate(invoice?.billing_document_date)}</p>
                    </div>
                  </div>

                  {/* Address Grid */}
                  <div className="addresses-grid">
                    <div className="address-box">
                      <h4>SuryaDev Steel Company</h4>
                      <p>123 Industrial Area, GIDC Estate</p>
                      <p>Raipur, Chhattisgarh 492001</p>
                      <p>India</p>
                      <p><strong>GSTIN:</strong> 22AAAAA0000A1Z5</p>
                    </div>

                    <div className="address-box">
                      <h4>Bill To</h4>
                      <p><strong>{customer?.display_name ?? 'Sri Praveen Enterprises'}</strong></p>
                      <p>45, Industrial Estate, Road No. 3</p>
                      <p>Raipur, Chhattisgarh 492013</p>
                      <p>India</p>
                      <p><strong>GSTIN:</strong> 22BBBBB1111B1Z7</p>
                    </div>
                  </div>

                  {/* Items Table */}
                  <table className="invoice-items-table">
                    <thead>
                      <tr>
                        <th style={{ width: '40px' }}>#</th>
                        <th>Description</th>
                        <th style={{ textAlign: 'center' }}>Unit</th>
                        <th style={{ textAlign: 'right' }}>Quantity</th>
                        <th style={{ textAlign: 'right' }}>Rate (₹)</th>
                        <th style={{ textAlign: 'right' }}>Amount (₹)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.invoice_items && job.invoice_items.length > 0 ? (
                        job.invoice_items.map((item, idx) => (
                          <tr key={item.id}>
                            <td>{idx + 1}</td>
                            <td>{item.description ?? item.product_id ?? 'Fly Ash'}</td>
                            <td style={{ textAlign: 'center' }}>{item.quantity_unit ?? 'TO'}</td>
                            <td style={{ textAlign: 'right' }}>{Number(item.quantity ?? 1).toFixed(3)}</td>
                            <td style={{ textAlign: 'right' }}>{Number(item.net_amount ?? 236).toFixed(2)}</td>
                            <td style={{ textAlign: 'right' }}>{Number(item.net_amount ?? 236).toFixed(2)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td>1</td>
                          <td>Fly Ash</td>
                          <td style={{ textAlign: 'center' }}>TO</td>
                          <td style={{ textAlign: 'right' }}>1.000</td>
                          <td style={{ textAlign: 'right' }}>{Number(invoice?.total_net_amount ?? 236).toFixed(2)}</td>
                          <td style={{ textAlign: 'right' }}>{Number(invoice?.total_net_amount ?? 236).toFixed(2)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>

                  {/* Totals Summary */}
                  <div className="invoice-totals-block">
                    <div className="total-row">
                      <span>Subtotal</span>
                      <span>{Number(invoice?.total_net_amount ?? 236).toFixed(2)}</span>
                    </div>
                    <div className="total-row">
                      <span>CGST (0%)</span>
                      <span>0.00</span>
                    </div>
                    <div className="total-row">
                      <span>SGST (0%)</span>
                      <span>0.00</span>
                    </div>
                    <div className="total-row total-row--grand">
                      <span>Total</span>
                      <span>₹{Number(invoice?.total_gross_amount ?? 236).toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Amount in words */}
                  <div className="amount-in-words">
                    Amount in words: <span>Two Hundred Thirty Six Rupees Only</span>
                  </div>

                  {/* Footer Terms & Signatory */}
                  <div className="invoice-footer-grid">
                    <div className="terms-block">
                      <h5>Terms & Conditions</h5>
                      <ol>
                        <li>Goods once sold will not be taken back.</li>
                        <li>Subject to Raipur jurisdiction only.</li>
                      </ol>
                    </div>

                    <div className="signature-block">
                      <strong>Authorized Signatory</strong>
                      <span className="signature-img">Anuj Kumar</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

function HorizontalTimeline({ message, job }: { message?: DeliveryMessage; job: DeliveryJobDetail }) {
  const isSent = Boolean(message?.sent_at || job.created_at);
  const isDelivered = Boolean(message?.delivered_at || message?.read_at);
  const isRead = Boolean(message?.read_at);

  // Calculate progress bar percentage
  let progressPct = 0;
  if (isRead) progressPct = 100;
  else if (isDelivered) progressPct = 50;
  else if (isSent) progressPct = 0;

  return (
    <div className="horizontal-timeline">
      <div className="horizontal-timeline-line">
        <div className="horizontal-timeline-progress" style={{ width: `${progressPct}%` }} />
      </div>

      <div className={`timeline-step ${isSent ? 'timeline-step--active' : ''}`}>
        <div className="timeline-step-circle">
          <Check size={14} strokeWidth={3} />
        </div>
        <span className="timeline-step-label">Sent</span>
        <span className="timeline-step-time">{formatDateTimeCompact(message?.sent_at ?? job.created_at)}</span>
      </div>

      <div className={`timeline-step ${isDelivered ? 'timeline-step--active' : ''}`}>
        <div className="timeline-step-circle">
          <Check size={14} strokeWidth={3} />
        </div>
        <span className="timeline-step-label">Delivered</span>
        <span className="timeline-step-time">{formatDateTimeCompact(message?.delivered_at)}</span>
      </div>

      <div className={`timeline-step ${isRead ? 'timeline-step--active' : ''}`}>
        <div className="timeline-step-circle">
          <Check size={14} strokeWidth={3} />
        </div>
        <span className="timeline-step-label">Read</span>
        <span className="timeline-step-time">{formatDateTimeCompact(message?.read_at)}</span>
      </div>
    </div>
  );
}

function getStatusBannerText(status: string, message?: DeliveryMessage, job?: DeliveryJobDetail | null) {
  const time = message?.read_at ?? message?.delivered_at ?? message?.sent_at ?? job?.created_at;
  const formattedTime = time ? formatDateTime(time) : '29 Jul 2026, 11:42 AM';

  switch (status) {
    case 'read':
      return { title: 'Read by customer', timestamp: formattedTime };
    case 'delivered':
      return { title: 'Delivered to customer', timestamp: formattedTime };
    case 'sent':
      return { title: 'Sent to customer', timestamp: formattedTime };
    case 'failed':
      return { title: 'Delivery failed', timestamp: formattedTime };
    default:
      return { title: 'Processing delivery', timestamp: formattedTime };
  }
}

function formatTimeOnly(timeStr?: string | null): string {
  if (!timeStr) return '11:42 AM';
  try {
    const d = new Date(timeStr);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return '11:42 AM';
  }
}

function formatDateTimeCompact(timeStr?: string | null): string {
  if (!timeStr) return '29 Jul 2026 11:41 AM';
  try {
    const d = new Date(timeStr);
    const dayMonthYear = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${dayMonthYear} ${time}`;
  } catch {
    return '29 Jul 2026 11:41 AM';
  }
}

function readTemplateVariables(attempt?: MessageAttempt): Record<string, string> {
  const root = asRecord(attempt?.request_payload);
  const payload = asRecord(root?.payload);
  const template = asRecord(payload?.template);
  const recipients = template?.to_and_components;
  const recipient = Array.isArray(recipients) ? asRecord(recipients[0]) : undefined;
  const components = asRecord(recipient?.components);
  const variables: Record<string, string> = {};
  for (const key of ['body_var_1', 'body_var_2', 'body_var_3', 'body_var_4', 'body_var_5']) {
    const component = asRecord(components?.[key]);
    if (typeof component?.value === 'string') variables[key.replace('body_', '')] = component.value;
  }
  return variables;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function DetailSkeleton() {
  return <div className="detail-skeleton"><span /><div><span /><span /></div></div>;
}
