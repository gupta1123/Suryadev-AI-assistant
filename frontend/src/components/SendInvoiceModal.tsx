import {
  CheckCircle2,
  CircleX,
  FileText,
  MessageCircle,
  Send,
  Settings2,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';
import { formatCurrency, toMessage } from '../lib/format';
import type {
  DeliveryConfig,
  Fixture,
  InvoicePreview,
  SimulationResult,
} from '../types';
import { Modal } from './Modal';

type Mode = 'quick' | 'manual';

export function SendInvoiceModal({
  config,
  onClose,
  onComplete,
}: {
  config: DeliveryConfig;
  onClose: () => void;
  onComplete: (jobId: number) => void;
}) {
  const [mode, setMode] = useState<Mode>('quick');
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selectedFixture, setSelectedFixture] = useState('');
  const [recipient, setRecipient] = useState('');
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loadingFixtures, setLoadingFixtures] = useState(false);
  const [busy, setBusy] = useState<'simulate' | 'preview' | 'send' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode !== 'manual' || fixtures.length > 0 || loadingFixtures) return;
    setLoadingFixtures(true);
    void apiRequest<Fixture[]>('/invoice-delivery/fixtures')
      .then((data) => {
        setFixtures(data);
        setSelectedFixture(data[0]?.id ?? '');
      })
      .catch((fixtureError) => setError(toMessage(fixtureError)))
      .finally(() => setLoadingFixtures(false));
  }, [fixtures.length, loadingFixtures, mode]);

  const selectedFixtureData = useMemo(
    () => fixtures.find((fixture) => fixture.id === selectedFixture),
    [fixtures, selectedFixture],
  );

  async function simulateInvoice() {
    setBusy('simulate');
    setError('');
    try {
      setResult(
        await apiRequest<SimulationResult>('/invoice-delivery/simulate', {
          method: 'POST',
        }),
      );
    } catch (simulationError) {
      setError(toMessage(simulationError));
    } finally {
      setBusy(null);
    }
  }

  async function prepareManualDelivery() {
    setBusy('preview');
    setError('');
    try {
      setPreview(
        await apiRequest<InvoicePreview>('/invoice-delivery/preview', {
          method: 'POST',
          body: JSON.stringify({ fixtureId: selectedFixture, recipient }),
        }),
      );
    } catch (previewError) {
      setError(toMessage(previewError));
    } finally {
      setBusy(null);
    }
  }

  async function sendManualDelivery() {
    if (!preview?.sendAllowed) return;
    setBusy('send');
    setError('');
    try {
      const sendResult = await apiRequest<{ jobId: number; duplicate: boolean; status: string }>(
        '/invoice-delivery/send',
        {
          method: 'POST',
          body: JSON.stringify({ fixtureId: selectedFixture, recipient }),
        },
      );
      onComplete(sendResult.jobId);
    } catch (sendError) {
      setError(toMessage(sendError));
    } finally {
      setBusy(null);
    }
  }

  if (result) {
    return (
      <Modal title="Invoice queued" description="The worker is sending this delivery through MSG91." onClose={onClose}>
        <div className="success-state">
          <span className="success-state__icon"><CheckCircle2 size={28} aria-hidden="true" /></span>
          <h3>{result.billingDocument}</h3>
          <p>{result.customerName}</p>
          <dl className="success-summary">
            <div><dt>Amount</dt><dd>{formatCurrency(result.amount, result.currency)}</dd></div>
            <div><dt>Destination</dt><dd className="mono">{result.maskedRecipient}</dd></div>
            <div><dt>Document</dt><dd>{result.pdfFileName}</dd></div>
          </dl>
          <button className="button button--primary button--wide" type="button" onClick={() => onComplete(result.jobId)}>
            View delivery details
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="New test delivery"
      description="Run the invoice workflow without calling SAP. Real WhatsApp sending remains allowlisted."
      onClose={onClose}
      width="large"
    >
      <div className="mode-tabs" role="tablist" aria-label="Test delivery method">
        <button className={mode === 'quick' ? 'mode-tab mode-tab--active' : 'mode-tab'} type="button" role="tab" aria-selected={mode === 'quick'} onClick={() => { setMode('quick'); setError(''); }}>
          <Zap size={16} aria-hidden="true" /> Quick sample
        </button>
        <button className={mode === 'manual' ? 'mode-tab mode-tab--active' : 'mode-tab'} type="button" role="tab" aria-selected={mode === 'manual'} onClick={() => { setMode('manual'); setError(''); }}>
          <Settings2 size={16} aria-hidden="true" /> Manual fixture
        </button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {mode === 'quick' ? (
        <div className="quick-send-layout">
          <div className="quick-send-copy">
            <span className="feature-icon"><Send size={22} aria-hidden="true" /></span>
            <h3>Run the complete workflow</h3>
            <p>A unique SAP-shaped invoice and matching PDF will be generated, stored, queued and sent to your fixed test number.</p>
            <div className="safety-list">
              <span><ShieldCheck size={16} aria-hidden="true" /> No SAP calls</span>
              <span><FileText size={16} aria-hidden="true" /> New PDF every time</span>
              <span><MessageCircle size={16} aria-hidden="true" /> Real WhatsApp delivery</span>
            </div>
          </div>

          <aside className="send-confirmation-card">
            <p className="eyebrow">Destination</p>
            <strong className="mono destination-number">{config.defaultTestRecipient}</strong>
            <p className="muted-copy">Only this backend-allowlisted number can receive the test.</p>
            {!config.simulationReady && (
              <ul className="blocker-list">
                {config.simulationBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            )}
            <button className="button button--primary button--wide" type="button" disabled={!config.simulationReady || busy !== null} onClick={() => void simulateInvoice()}>
              <Send size={16} aria-hidden="true" />
              {busy === 'simulate' ? 'Creating and queueing…' : 'Send sample invoice'}
            </button>
          </aside>
        </div>
      ) : (
        <div className="manual-flow">
          {!preview ? (
            <>
              <div className="form-grid">
                <label className="field field--full">
                  <span>Fixture invoice</span>
                  <select value={selectedFixture} disabled={loadingFixtures} onChange={(event) => setSelectedFixture(event.target.value)}>
                    {fixtures.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label}</option>)}
                  </select>
                </label>
                {selectedFixtureData && (
                  <div className="fixture-card field--full">
                    <div><span>Invoice</span><strong>{selectedFixtureData.billingDocument}</strong></div>
                    <div><span>Customer</span><strong>{selectedFixtureData.customerName}</strong></div>
                    <div><span>Amount</span><strong>{formatCurrency(selectedFixtureData.amount, selectedFixtureData.currency)}</strong></div>
                  </div>
                )}
                <label className="field field--full">
                  <span>Allowlisted WhatsApp number</span>
                  <input value={recipient} onChange={(event) => setRecipient(event.target.value)} inputMode="tel" placeholder="91XXXXXXXXXX" autoComplete="off" />
                  <small>Include the country code. All other numbers are rejected by the backend.</small>
                </label>
              </div>
              <div className="modal-footer">
                <button className="button button--secondary" type="button" onClick={onClose}>Cancel</button>
                <button className="button button--primary" type="button" disabled={!selectedFixture || busy !== null} onClick={() => void prepareManualDelivery()}>
                  {busy === 'preview' ? 'Checking…' : 'Review delivery'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="manual-review-grid">
                <div className="message-bubble">
                  <span className="document-chip"><FileText size={15} aria-hidden="true" /> {preview.invoice.pdfFileName}</span>
                  <p>Dear {preview.template.variables.var_1},</p>
                  <p>Your invoice <strong>{preview.template.variables.var_2}</strong> dated {preview.template.variables.var_3} has been generated.</p>
                  <p>Invoice Amount: <strong>₹{preview.template.variables.var_4}</strong></p>
                  <p>Please find the invoice PDF attached above.</p>
                  <p>Thank you,<br />Team {preview.template.variables.var_5}</p>
                </div>
                <div className="validation-stack">
                  {preview.validations.map((validation) => (
                    <div className={validation.passed ? 'validation-row validation-row--pass' : 'validation-row validation-row--fail'} key={validation.code}>
                      {validation.passed
                        ? <CheckCircle2 size={16} aria-hidden="true" />
                        : <CircleX size={16} aria-hidden="true" />}
                      <span>{validation.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="modal-footer">
                <button className="button button--secondary" type="button" onClick={() => setPreview(null)}>Back</button>
                <button className="button button--primary" type="button" disabled={!preview.sendAllowed || busy !== null} onClick={() => void sendManualDelivery()}>
                  <Send size={16} aria-hidden="true" /> {busy === 'send' ? 'Queueing…' : `Send to ${preview.maskedRecipient}`}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
