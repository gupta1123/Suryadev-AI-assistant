import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SapSalesAssignment } from '../customers/sap-masters.js';
import type { Ceilings, CustomerMessagingSetting } from './policy.js';
import { evaluateSapManagerCopy } from './sap-manager-policy.js';

const CUSTOMER = '550044';
const SAP_MANAGER = '917397301060';
const OLD_TEST_MANAGER = '917019339764';
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
    assert.deepEqual(evaluateSapManagerCopy(ceilings, setting, [area()]), { allowed: true, recipient: SAP_MANAGER });
  });

  it('reduces three sales areas with the same manager to one recipient', () => {
    assert.deepEqual(evaluateSapManagerCopy(ceilings, setting, [
      area(), area({ distributionChannel: '30', division: '03' }), area({ distributionChannel: '30', division: '04' }),
    ]), { allowed: true, recipient: SAP_MANAGER });
  });

  it('does not pick or broadcast when different sales areas have different managers', () => {
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area(), area({ marketingManagerPhone: '919445029682' })]).allowed, false);
  });

  it('fails closed for missing, inaccessible or conflicting mappings, never falling back to the old number', () => {
    assert.equal(evaluateSapManagerCopy(ceilings, setting, []).allowed, false);
    for (const managerStatus of ['missing', 'unavailable', 'conflicting'] as const) {
      assert.equal(evaluateSapManagerCopy(ceilings, setting, [area({ managerStatus, marketingManagerPhone: null })]).allowed, false);
      assert.equal(evaluateSapManagerCopy(ceilings, setting, [area(), area({ managerStatus, marketingManagerPhone: null })]).allowed, false);
    }
  });

  it('preserves disabled-customer and server-approved customer boundaries', () => {
    assert.equal(evaluateSapManagerCopy(ceilings, null, [area()]).allowed, false);
    assert.equal(evaluateSapManagerCopy(ceilings, { ...setting, enabled: false }, [area()]).allowed, false);
    assert.equal(evaluateSapManagerCopy({ ...ceilings, customers: new Set() }, setting, [area()]).allowed, false);
  });

  it('requires the SAP number to be on the manager allowlist in test mode', () => {
    assert.equal(evaluateSapManagerCopy({ ...ceilings, managerPhones: new Set([OLD_TEST_MANAGER]) }, setting, [area()]).allowed, false);
  });

  it('blocks placeholders and invalid SAP phones even in production', () => {
    for (const phone of ['919999999999', '910000000000', 'invalid', '911234567890']) {
      assert.equal(evaluateSapManagerCopy({ ...ceilings, mode: 'production' }, setting, [area({ marketingManagerPhone: phone })]).allowed, false);
    }
  });

  it('refuses old queued test recipients and manager changes before dispatch', () => {
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area()], OLD_TEST_MANAGER).allowed, false);
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area()], SAP_MANAGER).allowed, true);
    assert.equal(evaluateSapManagerCopy(ceilings, setting, [area({ marketingManagerPhone: '919445029682' })], SAP_MANAGER).allowed, false);
  });
});
