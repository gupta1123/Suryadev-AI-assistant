import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSapMasterCustomers } from './sap-masters.js';
import type { ODataRecord } from '../invoice-delivery/sap-client.js';

describe('read-only SAP customer masters', () => {
  it('joins customer addresses, selects the invoice default and retains other numbers', async () => {
    const rows: Record<string, ODataRecord[]> = {
      A_Customer: [
        { Customer: '200', CustomerName: 'Zeta' },
        { Customer: '100', CustomerFullName: 'Alpha Ltd' },
      ],
      A_BusinessPartnerAddress: [{ BusinessPartner: '100', AddressID: 'A' }, { BusinessPartner: '100', AddressID: 'B' }],
      A_AddressPhoneNumber: [
        { AddressID: 'A', OrdinalNumber: '1', PhoneNumber: '7977925397', IsDefaultPhoneNumber: false },
        { AddressID: 'B', OrdinalNumber: '2', InternationalPhoneNumber: '+91 70193 39764', IsDefaultPhoneNumber: true },
        { AddressID: 'B', OrdinalNumber: '3', PhoneNumber: '7019339764' },
        { AddressID: 'A', OrdinalNumber: '4', PhoneNumber: '' },
      ],
    };
    const customers = await readSapMasterCustomers({ collection: async (_service, entity) => rows[entity] ?? [] });
    assert.equal(customers[0]?.name, 'Alpha Ltd');
    assert.equal(customers[0]?.primaryPhone, '917019339764');
    assert.deepEqual(customers[0]?.phones, [
      { number: '917977925397', isDefault: false },
      { number: '917019339764', isDefault: true },
    ]);
    assert.equal(customers[1]?.primaryPhone, null);
    assert.deepEqual(customers[1]?.phones, []);
  });

  it('returns empty SAP results without injecting local fixture customers', async () => {
    assert.deepEqual(await readSapMasterCustomers({ collection: async () => [] }), []);
  });

  it('propagates SAP failures rather than displaying fabricated or partial data', async () => {
    await assert.rejects(readSapMasterCustomers({ collection: async () => { throw new Error('SAP unavailable'); } }), /SAP unavailable/);
  });
});
