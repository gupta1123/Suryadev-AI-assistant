import { Check, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import { formatDateTime, toMessage } from '../../lib/format';
import type { PaymentFollowUpConfig, ReminderSettings } from '../../types';
import {
  approxDuration,
  formatDuration,
  MAX_DELAY_SECONDS,
  MIN_DELAY_SECONDS,
  reminderSummary,
  splitDuration,
  UNIT_SECONDS,
  type TimeUnit,
} from './duration';
import { paymentState, STATE_PILL } from './health';
import { Card, LiveNote, Pill, Skeleton } from './ui';

const TRACK_LIMIT = 4;

export function RemindersTab({
  paymentConfig,
  onSaved,
}: {
  paymentConfig: PaymentFollowUpConfig | null;
  onSaved: () => Promise<void>;
}) {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  if (!paymentConfig) return <Skeleton rows={3} />;
  const state = paymentState(paymentConfig);
  const pill = STATE_PILL[state];

  return (
    <div className="st-stack">
      <div className="st-intro">
        <div>
          <h2>Payment reminders</h2>
        </div>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>

      {state !== 'live' && state !== 'test' && (
        <div className="alert alert--info" role="status">
          Reminders are {state === 'paused' ? 'paused' : 'switched off'} on the server right now. You can still set the timing — it’s used once reminders are switched on.
        </div>
      )}

      <ReminderTimingForm
        key={paymentConfig.reminderSettingsUpdatedAt ?? 'default'}
        config={paymentConfig}
        justSaved={savedAt !== null}
        onSaved={async () => { await onSaved(); setSavedAt(Date.now()); }}
        onEdit={() => setSavedAt(null)}
      />

      <p className="st-foot-note st-foot-note--plain">
        <Lock size={13} aria-hidden="true" /> Reminders stop automatically when an invoice is marked as paid.
      </p>
    </div>
  );
}

function ReminderTimingForm({
  config,
  justSaved,
  onSaved,
  onEdit,
}: {
  config: PaymentFollowUpConfig;
  justSaved: boolean;
  onSaved: () => Promise<void>;
  onEdit: () => void;
}) {
  const [first, setFirst] = useState(() => splitDuration(config.firstReminderDelaySeconds));
  const [repeat, setRepeat] = useState(() => splitDuration(config.repeatReminderDelaySeconds));
  const [maximum, setMaximum] = useState(String(config.maximumTestReminders));
  const [dueDays, setDueDays] = useState(String(config.dueDays ?? 3));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const firstSeconds = Number(first.amount) * UNIT_SECONDS[first.unit];
  const repeatSeconds = Number(repeat.amount) * UNIT_SECONDS[repeat.unit];
  const maximumCount = Number(maximum);
  const firstProblem = !Number.isInteger(firstSeconds) || firstSeconds < MIN_DELAY_SECONDS || firstSeconds > MAX_DELAY_SECONDS
    ? 'Choose between 10 seconds and 30 days.' : '';
  const repeatProblem = maximumCount > 1 && (!Number.isInteger(repeatSeconds) || repeatSeconds < MIN_DELAY_SECONDS || repeatSeconds > MAX_DELAY_SECONDS)
    ? 'Choose between 10 seconds and 30 days.' : '';
  const maximumProblem = !Number.isInteger(maximumCount) || maximumCount < 1 || maximumCount > 10 ? 'Choose between 1 and 10.' : '';
  const dueProblem = !Number.isInteger(Number(dueDays)) || Number(dueDays) < 1 || Number(dueDays) > 90 ? 'Choose a whole number from 1 to 90 days.' : '';
  const problem = firstProblem || repeatProblem || maximumProblem || dueProblem;
  const changed =
    firstSeconds !== config.firstReminderDelaySeconds
    || repeatSeconds !== config.repeatReminderDelaySeconds
    || maximumCount !== config.maximumTestReminders
    || Number(dueDays) !== (config.dueDays ?? 3);

  function touch<T>(setter: (value: T) => void) {
    return (value: T) => { setter(value); setError(''); onEdit(); };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (problem || !changed) return;
    setSaving(true);
    setError('');
    try {
      await apiRequest<ReminderSettings>('/payment-follow-up/settings', {
        method: 'PUT',
        body: JSON.stringify({
          dueDays: Number(dueDays),
          firstReminderDelaySeconds: firstSeconds,
          repeatReminderDelaySeconds: repeatSeconds,
          maximumReminders: maximumCount,
        }),
      });
      await onSaved();
    } catch (failure) {
      setError(toMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setFirst(splitDuration(config.firstReminderDelaySeconds));
    setRepeat(splitDuration(config.repeatReminderDelaySeconds));
    setMaximum(String(config.maximumTestReminders));
    setDueDays(String(config.dueDays ?? 3));
    setError('');
  }

  const shown = problem ? 0 : Math.min(maximumCount, TRACK_LIMIT);
  const steps = Array.from({ length: shown }, (_, index) => ({
    number: index + 1,
    offset: firstSeconds + index * (maximumCount > 1 ? repeatSeconds : 0),
  }));
  const more = problem ? 0 : Math.max(0, maximumCount - TRACK_LIMIT);

  return (
    <form onSubmit={(event) => void save(event)} className="st-stack">
      <Card title="Reminder timing">
        <label className="field">
          <span>Payment due after</span>
          <input type="number" min={1} max={90} step={1} value={dueDays} onChange={(event) => touch(setDueDays)(event.target.value)} aria-invalid={Boolean(dueProblem)} />
          <small className={dueProblem ? 'text-danger' : undefined}>{dueProblem || 'days from invoice date. Applies to journeys started after this setting is saved. Existing journeys keep their original due date. This is a calculated due date, not SAP’s due date.'}</small>
        </label>
        <div className="st-timing">
          <DurationField label="First reminder" hint="after the user starts the journey" value={first} onChange={touch(setFirst)} problem={firstProblem} />
          <DurationField label="Then every" hint="after the previous reminder" value={repeat} onChange={touch(setRepeat)} problem={repeatProblem} disabled={maximumCount === 1} />
          <label className="field">
            <span>Send at most</span>
            <div className="st-pair">
              <input type="number" min={1} max={10} step={1} inputMode="numeric" value={maximum} onChange={(event) => touch(setMaximum)(event.target.value)} aria-invalid={Boolean(maximumProblem)} />
              <span className="st-pair__suffix">{maximumCount === 1 ? 'reminder' : 'reminders'}</span>
            </div>
            {maximumProblem ? <small className="text-danger">{maximumProblem}</small> : <small>per invoice, unless it’s paid first</small>}
          </label>
        </div>
      </Card>

      <Card title="What the customer will experience">
        {problem ? (
          <p className="st-hint st-hint--warn">Fix the highlighted fields to see the preview.</p>
        ) : (
          <>
            <ol className="st-track" aria-label="Reminder schedule">
              <li className="st-track__step st-track__step--start">
                <span className="st-track__dot" />
                <strong>Start journey</strong>
                <small>once the invoice is due</small>
              </li>
              {steps.map((step) => (
                <li key={step.number} className="st-track__step">
                  <span className="st-track__dot" />
                  <strong>Reminder {step.number}</strong>
                  <small>{approxDuration(step.offset)} after</small>
                </li>
              ))}
              {more > 0 && (
                <li className="st-track__step st-track__step--more">
                  <span className="st-track__dot" />
                  <strong>+{more} more</strong>
                  <small>every {approxDuration(repeatSeconds)}</small>
                </li>
              )}
              <li className="st-track__step st-track__step--end">
                <span className="st-track__dot" />
                <strong>Stops</strong>
                <small>when paid</small>
              </li>
            </ol>
            <p className="st-summary">Invoice date + {dueDays} days → eligible. After Start journey: first reminder in {formatDuration(firstSeconds)}, then every {formatDuration(repeatSeconds)}, up to {maximumCount}. Marking paid stops reminders.</p>
          </>
        )}
      </Card>

      <div className="st-savebar">
        <div className="st-savebar__status">
          {error ? <LiveNote tone="bad">{error}</LiveNote>
            : justSaved ? <LiveNote><Check size={14} aria-hidden="true" /> Saved for new journeys only. Existing journeys are unchanged.</LiveNote>
              : changed ? <p className="st-dirty">You have unsaved changes.</p>
                : <p className="st-muted">
                  {config.reminderSettingsSource === 'saved'
                    ? `Last changed ${formatDateTime(config.reminderSettingsUpdatedAt)}.`
                    : `Using the standard timing (${formatDuration(config.firstReminderDelaySeconds)}, then ${formatDuration(config.repeatReminderDelaySeconds)}).`}
                </p>}
        </div>
        <button className="button button--secondary" type="button" disabled={saving || !changed} onClick={reset}>Discard changes</button>
        <button className="button button--primary" type="submit" disabled={saving || !changed || Boolean(problem)}>{saving ? 'Saving…' : 'Save timing'}</button>
      </div>
    </form>
  );
}

function DurationField({
  label,
  hint,
  value,
  onChange,
  problem,
  disabled = false,
}: {
  label: string;
  hint: string;
  value: { amount: string; unit: TimeUnit };
  onChange: (value: { amount: string; unit: TimeUnit }) => void;
  problem: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="st-pair">
        <input type="number" min={1} step={1} inputMode="numeric" disabled={disabled} value={value.amount} aria-invalid={Boolean(problem)}
          onChange={(event) => onChange({ ...value, amount: event.target.value })} aria-label={`${label} amount`} />
        <select disabled={disabled} value={value.unit} onChange={(event) => onChange({ ...value, unit: event.target.value as TimeUnit })} aria-label={`${label} unit`}>
          <option value="seconds">seconds</option>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
      {problem ? <small className="text-danger">{problem}</small> : <small>{disabled ? 'Not needed when only one reminder is sent' : hint}</small>}
    </label>
  );
}
