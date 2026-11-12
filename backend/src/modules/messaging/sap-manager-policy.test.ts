import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SapSalesAssignment } from '../customers/sap-masters.js';
import type { Ceilings, CustomerMessagingSetting } from './policy.js';
import { evaluateSapManagerCopy, MAX_MANAGER_COPIES } from './sap-manager-policy.js';

const CUSTOMER = '550044';
const SAP_MANAGER = '917397301060';
const OLD_TEST_MANAGER = '917019339764';
const SECOND_MANAGER = '919445029682';
const ceilings: Ceilings = {
  mode: 'test', customers: new Set([CUSTOMER]), phones: new Set(),
  paymentPhones: new Set(), managerPhones: new Set([SAP_MANAGER, '919445029682']),
};
const setting: CustomerMessagingSetting = {
  sapCustomerNumber: CUSTOMER, enabled: true, approvedPhone: '918098868251',
  enabledAt: '2026-10-20T00:00:00Z', managerName: 'Old test manager',
  managerPhone: OLD_TEST_MANAGER, managerSource: 'manual', updatedBy: null, updatedAt: null,
};
const area = (overrides: Partial<SapSalesAssignment> = {}): SapSalesAssignment => ({
  salesOrganization: '1000', distributionChannel: '10', division: '01',
  salesGroup: '21', salesOffice: 'HO', marketingManagerPhone: SAP_MANAGER, managerStatus: 'mapped', ...overrides,
});

describe('SAP-driven manager copy routing', () => {
  it('uses the actual SAP manager and ignores the old manual test number', () => {
    assert.deepEqual(evaluateSapManagerCopy(ceilings, setting, [area()]), { allowed: true, recipient: SAP_MANAGER, recipients: [SAP_MANAGER], skippedAreas: 0 });
  });

  it('reduces three sales areas with the same manager to one recipient', () => {
    assert.deepEqual(evaluateSapManagerCopy(ceilings, setting, [
      area(), area({ distributionChannel: '30', division: '03' }), area({ distributionChannel: '30', division: '04' }),
    ]), { allowed: true, recipient: SAP_MANAGER, recipients: [SAP_MANAGER], skippedAreas: 0 });
  });

  it('sends a copy to each manager when different sales areas have different managers', () => {
    assert.deepEqual(evaluateSapManagerCopy(ceilings, setting, [area(), area({ distributionChannel: '20', salesGroup: '12', marketingManagerPhone: SECOND_MANAGER })]),
      { allowed: true, recipient: SAP_MANAGER, recipients: [SAP_MANAGER, SECOND_MANAGER], skippedAreas: 0 });
  });

  it('skips a sales area with no usable manager and still copies the managers it does find', () => {
    for (const managerStatus of ['missing', 'unavailable', 'conflicting'] as const) {
      assert.deepEqual(evaluateSapManagerCopy(ceilings, setting, [area(), area({ managerStatus, marketingManagerPhone: null })]),
        { allowed: true, recipient: SAP_MANAGER, recipients: [SAP_MANAGER], skippedAreas: 1 });
    }
  });

  it('fails closed when no sales area has a usable manager, never falling back to the old number', () => {
    assert.equal(evaluateSapManagerCopy(ceilings, setting, []).allowed, false);
    for (const managerStatus of ['missing', 'unavailable', 'conflicting'] as const) {
      assert.equal(evaluateSapManagerCopy(ceilings, setting, [area({ managerStatus, marketingManagerPhone: null })]).allowed, false);
      assert.equal(evaluateSapManagerCopy(ceilings, setting, [area({ managerStatus, marketingManagerPhone: null }), area({ managerStatus, marketingManagerPhone: null })]).allowed, false);
    }
  });

  it('drops an invalid manager number but keeps a valid one, and refuses an implausible fan-out', () => {
    assert.deepEqual(evaluateSapManagerCopy({ ...ceilings, mode: 'production' }, setting, [area({ marketingManagerPhone: '919999999999' }), area({ salesGroup: '12' })]),
      { allowed: true, recipient: SAP_MANAGER, recipients: [SAP_MANAGER], skippedAreas: 0 });
    const many = Array.from({ length: MAX_MANAGER_COPIES + 1 }, (_, i) => area({ salesGroup: String(i + 1), marketingManagerPhone: `9194450296${i}0`.slice(0, 12) }));
    assert.equal(evaluateSapManagerCopy({ ...ceilings, mode: 'production' }, setting, many).allowed, false);
  });

  it('preserves disabled-customer and server-approved customer boundaries', () => {
    assert.equal(evaluateSapManagerCopy(ceilings, null, [area()]).allowed, false);
    assert.equal(evaluateSapManagerCopy(ceilings, { ...setting, enabled: false }, [area()]).allowed, false);
    assert.equal(evaluateSapManagerCopy({ ...ceilings, customers: new Set() }, setting, [area()]).allowed, false);
  });

  it('requires the SAP number to be on the manager allowlist in test mode', () => {
    assert.equal(evaluateSapManagerCopy({ ...ceilings, managerPhones: new Set([OLD_TEST_MANAGER]) }, setting, [area()]).allowed, false);
  });

  it('in test mode only the managers on the allowlist get a copy', () => {
    const decision = evaluateSapManagerCopy({ ...ceilings, managerPhones: new Set([SAP_MANAGER]) }, setting,
      [area(), area({ salesGroup: '12', marketingManagerPhone: SECOND_MANAGER })]);
    assert.deepEqual(decision, { allowed: true, recipient: SAP_MANAGER, recipients: [SAP_MANAGER], skippedAreas: 0 });
  });

  it('blocks placeholders and invalid SAP phones even in production', () => {
    for (const phone of ['919999999999', '910000000000', 'invalid', '911234567890']) {
      assert.equal(evaluateSapManagerCopy({ ...ceilings, mode: 'production' }, setting, [area({ marketingManagerPhone: phone })]).allowed, false);
    }
  });

  it('refuses old queued test recipients and manager changes before dispatch', () => {
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area()], OLD_TEST_MANAGER).allowed, false);
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area()], SAP_MANAGER).allowed, true);
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area({ marketingManagerPhone: SECOND_MANAGER })], SAP_MANAGER).allowed, false);
  });

  it('re-checks each queued copy for its own manager when a customer has two', () => {
    const two = [area(), area({ salesGroup: '12', marketingManagerPhone: SECOND_MANAGER })];
    assert.deepEqual(evaluateSapManagerCopy(ceilings, setting, two, SECOND_MANAGER),
      { allowed: true, recipient: SECOND_MANAGER, recipients: [SECOND_MANAGER], skippedAreas: 0 });
    // One manager was removed in SAP after both copies were queued: only that copy is refused.
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area()], SECOND_MANAGER).allowed, false);
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area()], SAP_MANAGER).allowed, true);
  });
});
