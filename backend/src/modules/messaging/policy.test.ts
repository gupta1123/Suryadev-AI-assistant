import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  type Ceilings,
  type CustomerMessagingSetting,
  type InternalRecipient,
  CREATED_BEFORE_ENABLED,
  evaluateDocumentSend,
  evaluateLivePhone,
  evaluateManagerCopy,
  evaluatePaymentRecipient,
  isHelpAlertRecipientPermitted,
  normalizePhone,
} from './policy.js';

const CUSTOMER = '530234';
const CLIENT = '918098868251';
const TEAM = '917019339764';
const MANAGER = '917019339764';
const ENABLED_AT = '2026-10-20T08:00:00.000Z';
const AFTER = '2026-10-20T09:00:00.000Z';
const BEFORE = '2026-10-19T09:00:00.000Z';

const ceilings = (overrides: Partial<Ceilings> = {}): Ceilings => ({
  mode: 'test',
  customers: new Set([CUSTOMER]),
  phones: new Set([CLIENT, TEAM]),
  paymentPhones: new Set([TEAM]),
  managerPhones: new Set([MANAGER]),
  ...overrides,
});

const setting = (overrides: Partial<CustomerMessagingSetting> = {}): CustomerMessagingSetting => ({
  sapCustomerNumber: CUSTOMER,
  enabled: true,
  approvedPhone: CLIENT,
  enabledAt: ENABLED_AT,
  managerName: 'Payal',
  managerPhone: MANAGER,
  managerSource: 'manual',
  updatedBy: null,
  updatedAt: null,
  ...overrides,
});

const internal = (overrides: Partial<InternalRecipient> = {}): InternalRecipient => ({
  phone: TEAM,
  label: 'Team',
  allowSimulator: true,
  allowPaymentReminders: true,
  updatedBy: null,
  updatedAt: null,
  ...overrides,
});

const send = (
  input: Partial<Parameters<typeof evaluateDocumentSend>[1]> = {},
  c: Ceilings = ceilings(),
) =>
  evaluateDocumentSend(c, {
    source: 'sap',
    customerNumber: CUSTOMER,
    recipient: CLIENT,
    documentCreatedAt: AFTER,
    setting: setting(),
    internal: null,
    ...input,
  });

describe('document send approval', () => {
  it('allows an enabled customer at its approved phone for a document created after enabling', () => {
    assert.deepEqual(send(), { allowed: true, route: 'customer' });
  });

  it('normalizes phone formatting before comparing', () => {
    assert.equal(send({ recipient: '+91 80988 68251' }).allowed, true);
  });

  it('refuses a document created before the customer was enabled', () => {
    const decision = send({ documentCreatedAt: BEFORE });
    assert.equal(decision.allowed, false);
    assert.equal((decision as { reason: string }).reason, CREATED_BEFORE_ENABLED);
  });

  it('refuses a document with no creation time', () => {
    assert.equal(send({ documentCreatedAt: null }).allowed, false);
  });

  it('refuses when there is no setting, or the customer is disabled', () => {
    assert.equal(send({ setting: null }).allowed, false);
    assert.equal(send({ setting: setting({ enabled: false }) }).allowed, false);
  });

  it('refuses an enabled row that lacks an approved phone or enable time', () => {
    assert.equal(send({ setting: setting({ approvedPhone: null }) }).allowed, false);
    assert.equal(send({ setting: setting({ enabledAt: null }) }).allowed, false);
  });

  it('refuses a customer outside the server-approved list even if enabled', () => {
    assert.equal(send({}, ceilings({ customers: new Set(['999999']) })).allowed, false);
  });

  it('refuses a recipient outside the server-approved numbers even if approved in Settings', () => {
    assert.equal(send({}, ceilings({ phones: new Set([TEAM]) })).allowed, false);
  });

  it('refuses any other recipient that is not an approved internal number', () => {
    assert.equal(send({ recipient: TEAM }).allowed, false);
    assert.equal(send({ recipient: TEAM, internal: internal({ allowSimulator: false }) }).allowed, false);
  });

  it('allows an approved internal test number for a document of an enabled customer', () => {
    assert.deepEqual(send({ recipient: TEAM, internal: internal() }), { allowed: true, route: 'internal' });
  });

  it('does not let an internal number receive a disabled customer’s document', () => {
    assert.equal(
      send({ recipient: TEAM, internal: internal(), setting: setting({ enabled: false }) }).allowed,
      false,
    );
  });

  it('does not let an internal row approve a different phone number', () => {
    assert.equal(send({ recipient: CLIENT, setting: null, internal: internal() }).allowed, false);
  });

  it('only sends sample documents to an approved internal number', () => {
    const base = { source: 'fixture' as const, setting: setting(), recipient: TEAM };
    assert.equal(send({ ...base, internal: internal() }).allowed, true);
    assert.equal(send({ ...base, internal: null }).allowed, false);
    assert.equal(send({ ...base, recipient: CLIENT, internal: null }).allowed, false);
  });

  it('never lets a sample bypass a disabled, missing or mismatched customer approval', () => {
    for (const approval of [null, setting({ enabled: false }), setting({ sapCustomerNumber: 'OTHER' })]) {
      assert.equal(send({ source: 'fixture', recipient: TEAM, internal: internal(), setting: approval }).allowed, false);
    }
    assert.equal(send({ source: 'fixture', recipient: TEAM, internal: internal() }, ceilings({ customers: new Set() })).allowed, false);
  });

  it('still requires an enabled customer in production mode', () => {
    const production = ceilings({ mode: 'production', customers: new Set(), phones: new Set() });
    assert.equal(send({ setting: null }, production).allowed, false);
    assert.equal(send({}, production).allowed, true);
  });
});

describe('live SAP phone check', () => {
  it('passes only while SAP still reports the approved phone', () => {
    assert.equal(evaluateLivePhone(setting(), CLIENT).allowed, true);
    assert.equal(evaluateLivePhone(setting(), '919999999999').allowed, false);
    assert.equal(evaluateLivePhone(setting(), null).allowed, false);
    assert.equal(evaluateLivePhone(setting({ enabled: false }), CLIENT).allowed, false);
    assert.equal(evaluateLivePhone(null, CLIENT).allowed, false);
  });
});

describe('per-client marketing manager copy', () => {
  it('returns the customer’s own manager when enabled and server-approved', () => {
    assert.deepEqual(evaluateManagerCopy(ceilings(), setting()), { allowed: true, recipient: MANAGER });
  });

  it('sends no copy when the customer is disabled or has no manager (no fallback)', () => {
    assert.equal(evaluateManagerCopy(ceilings(), setting({ enabled: false })).allowed, false);
    assert.equal(evaluateManagerCopy(ceilings(), setting({ managerPhone: null })).allowed, false);
    assert.equal(evaluateManagerCopy(ceilings(), null).allowed, false);
  });

  it('refuses a manager number outside the server-approved list in test mode', () => {
    const decision = evaluateManagerCopy(ceilings({ managerPhones: new Set() }), setting());
    assert.equal(decision.allowed, false);
  });

  it('refuses at dispatch if the assigned manager changed after queueing', () => {
    assert.equal(evaluateManagerCopy(ceilings(), setting(), MANAGER).allowed, true);
    assert.equal(evaluateManagerCopy(ceilings(), setting(), '919000000000').allowed, false);
  });
});

describe('payment reminder recipients', () => {
  const payment = (approval: CustomerMessagingSetting | null = setting(), recipient = internal(), c = ceilings()) =>
    evaluatePaymentRecipient(c, CUSTOMER, TEAM, approval, recipient);

  it('needs both customer approval and the existing recipient approvals', () => {
    assert.equal(payment().allowed, true);
    assert.equal(payment(setting(), internal({ allowPaymentReminders: false })).allowed, false);
    assert.equal(evaluatePaymentRecipient(ceilings(), CUSTOMER, TEAM, setting(), null).allowed, false);
    assert.equal(payment(setting(), internal(), ceilings({ paymentPhones: new Set() })).allowed, false);
    assert.equal(evaluatePaymentRecipient(ceilings(), CUSTOMER, CLIENT, setting(), internal({ phone: CLIENT })).allowed, false);
  });

  it('refuses existing reminders after disabling, even for an approved team number', () => {
    assert.equal(payment(setting({ enabled: false })).allowed, false);
    assert.equal(payment(null).allowed, false);
    assert.equal(payment(setting({ sapCustomerNumber: 'OTHER' })).allowed, false);
    assert.equal(payment(setting({ approvedPhone: null })).allowed, false);
    assert.equal(payment(setting({ enabledAt: null })).allowed, false);
  });

  it('cannot widen the server customer ceiling', () => {
    assert.equal(payment(setting(), internal(), ceilings({ customers: new Set() })).allowed, false);
  });

  it('still refuses a disabled customer in production', () => {
    assert.equal(payment(setting({ enabled: false }), internal(), ceilings({ mode: 'production' })).allowed, false);
  });
});

describe('help alert recipient', () => {
  it('must be a server-approved number in test mode', () => {
    assert.equal(isHelpAlertRecipientPermitted(ceilings(), TEAM), true);
    assert.equal(isHelpAlertRecipientPermitted(ceilings(), '919000000000'), false);
    assert.equal(isHelpAlertRecipientPermitted(ceilings({ mode: 'production' }), '919000000000'), true);
  });
});

describe('phone normalization', () => {
  it('adds the Indian country code to bare mobile numbers', () => {
    assert.equal(normalizePhone('7019339764'), '917019339764');
    assert.equal(normalizePhone('07019339764'), '917019339764');
    assert.equal(normalizePhone('+91 70193 39764'), '917019339764');
  });
});

describe('production mode guard', () => {
  const run = (extra: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/config/env.ts')"], {
      cwd: new URL('../../..', import.meta.url),
      env: {
        PATH: process.env.PATH ?? '',
        SUPABASE_URL: 'http://127.0.0.1:1',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy-not-real',
        ...extra,
      },
      encoding: 'utf8',
    });

  it('refuses DELIVERY_MODE=production without the second switch', () => {
    const result = run({ DELIVERY_MODE: 'production' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ALLOW_PRODUCTION_DELIVERY/);
  });

  it('starts in test mode', () => {
    assert.equal(run({ DELIVERY_MODE: 'test' }).status, 0);
  });
});
