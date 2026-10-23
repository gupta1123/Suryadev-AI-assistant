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
    const { items: customers } = await readSapMasterCustomers({ collection: async (_service, entity) => rows[entity] ?? [] });
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
    assert.deepEqual(await readSapMasterCustomers({ collection: async () => [] }), { items: [], managerMappingAvailable: true });
  });

  it('uses the separate login only for manager mapping, preserving customer reads', async () => {
    const customerCalls: string[] = [];
    const managerCalls: string[] = [];
    const directory = await readSapMasterCustomers({ collection: async (_service, entity) => {
      customerCalls.push(entity);
      assert.notEqual(entity, 'YY1_SALESGROUP');
      if (entity === 'A_Customer') return [{ Customer: '100' }];
      if (entity === 'A_CustomerSalesArea') return [{ Customer: '100', SalesGroup: '08', SalesOffice: 'HO' }];
      return [];
    } }, { collection: async (service, entity) => {
      managerCalls.push(entity);
      assert.equal(service, 'YY1_SALESGROUP_CDS');
      assert.equal(entity, 'YY1_SALESGROUP');
      return [{ SalesGroupid: '08', SalesOffice: 'HO', MobileNo: '9445029682' }];
    } });
    assert.deepEqual(customerCalls.sort(), ['A_AddressPhoneNumber', 'A_BusinessPartnerAddress', 'A_Customer', 'A_CustomerSalesArea']);
    assert.deepEqual(managerCalls, ['YY1_SALESGROUP']);
    assert.equal(directory.managerMappingAvailable, true);
    assert.equal(directory.items[0]?.salesAssignments[0]?.marketingManagerPhone, '919445029682');
  });

  it('propagates SAP failures rather than displaying fabricated or partial data', async () => {
    await assert.rejects(readSapMasterCustomers({ collection: async () => { throw new Error('SAP unavailable'); } }), /SAP unavailable/);
  });

  it('keeps sales-area pairs together and joins managers by group and office, including zero-padded groups', async () => {
    const rows: Record<string, ODataRecord[]> = {
      A_Customer: [{ Customer: '100', CustomerName: 'Alpha' }],
      A_CustomerSalesArea: [
        { Customer: '100', SalesOrganization: '1000', DistributionChannel: '20', Division: '01', SalesGroup: '21', SalesOffice: 'HO' },
        { Customer: '100', SalesOrganization: '1000', DistributionChannel: '10', Division: '01', SalesGroup: '08', SalesOffice: 'HO' },
      ],
      YY1_SALESGROUP: [
        { SalesGroupid: '8', SalesOffice: 'HO', MobileNo: '9445029682' },
        { SalesGroupid: '08', SalesOffice: 'HO', MobileNo: '+91 9445029682' },
        { SalesGroupid: '08', SalesOffice: 'OTHER', MobileNo: '7019339764' },
        { SalesGroupid: '21', SalesOffice: 'HO', MobileNo: '7397301060' },
      ],
    };
    const directory = await readSapMasterCustomers({ collection: async (service, entity) => {
      if (entity === 'YY1_SALESGROUP') assert.equal(service, 'YY1_SALESGROUP_CDS');
      return rows[entity] ?? [];
    } });
    assert.equal(directory.managerMappingAvailable, true);
    assert.deepEqual(directory.items[0]?.salesAssignments, [
      { salesOrganization: '1000', distributionChannel: '10', division: '01', salesGroup: '08', salesOffice: 'HO', marketingManagerPhone: '919445029682', managerStatus: 'mapped' },
      { salesOrganization: '1000', distributionChannel: '20', division: '01', salesGroup: '21', salesOffice: 'HO', marketingManagerPhone: '917397301060', managerStatus: 'mapped' },
    ]);
    assert.equal(directory.items[0]?.primaryPhone, null, 'manager phone must not replace customer phone');
  });

  it('shows unavailable mappings without hiding customers when custom SAP service is forbidden', async () => {
    const directory = await readSapMasterCustomers({ collection: async (_service, entity) => {
      if (entity === 'YY1_SALESGROUP') throw new Error('403 Forbidden');
      if (entity === 'A_Customer') return [{ Customer: '100' }];
      if (entity === 'A_CustomerSalesArea') return [{ Customer: '100', SalesGroup: '08', SalesOffice: 'HO' }];
      return [];
    } });
    assert.equal(directory.items.length, 1);
    assert.equal(directory.managerMappingAvailable, false);
    assert.equal(directory.items[0]?.salesAssignments[0]?.managerStatus, 'unavailable');
    assert.equal(directory.items[0]?.salesAssignments[0]?.marketingManagerPhone, null);
  });

  it('distinguishes missing and conflicting manager contacts without choosing a guessed number', async () => {
    const directory = await readSapMasterCustomers({ collection: async (_service, entity) => {
      if (entity === 'A_Customer') return [{ Customer: '100' }];
      if (entity === 'A_CustomerSalesArea') return [
        { Customer: '100', SalesGroup: '08', SalesOffice: 'HO' },
        { Customer: '100', SalesGroup: '21', SalesOffice: 'HO' },
      ];
      if (entity === 'YY1_SALESGROUP') return [
        { SalesGroupid: '08', SalesOffice: 'HO', MobileNo: '9445029682' },
        { SalesGroupid: '8', SalesOffice: 'HO', MobileNo: '7019339764' },
      ];
      return [];
    } });
    assert.deepEqual(directory.items[0]?.salesAssignments.map((area) => [area.managerStatus, area.marketingManagerPhone]), [['conflicting', null], ['missing', null]]);
  });
});
