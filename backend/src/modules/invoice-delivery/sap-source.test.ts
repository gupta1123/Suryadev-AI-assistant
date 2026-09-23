import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { env, sapAllowedBillingDocuments, sapAllowedCustomers } from '../../config/env.js';
import type { ODataRecord, SapODataClient } from './sap-client.js';
import {
  combineSapDateAndTime,
  normalizeIndianPhone,
  SapInvoiceSource,
  sapDateOnly,
  sapDateTime,
} from './sap-source.js';

describe('SAP value normalization', () => {
  it('lists only the five supported billing document types in the SAP query', async () => {
    let filter = '';
    const fakeClient = {
      async collection(
        _service: string,
        _entitySet: string,
        options: { filter?: string } = {},
      ): Promise<ODataRecord[]> {
        filter = options.filter ?? '';
        return [];
      },
    } as unknown as SapODataClient;
    const customerWasAlreadyAllowed = sapAllowedCustomers.has('550071');
    const documentWasAlreadyAllowed = sapAllowedBillingDocuments.has('TEST000001');
    sapAllowedCustomers.add('550071');
    sapAllowedBillingDocuments.add('TEST000001');
    try {
      await new SapInvoiceSource(fakeClient).list();
      for (const type of ['F2', 'S1', 'CBRE', 'G2', 'L2']) {
        assert.match(filter, new RegExp(`BillingDocumentType eq '${type}'`));
      }
    } finally {
      if (!customerWasAlreadyAllowed) sapAllowedCustomers.delete('550071');
      if (!documentWasAlreadyAllowed) sapAllowedBillingDocuments.delete('TEST000001');
    }
  });

  it('lists only documents created after activation when no exact IDs are configured', async () => {
    const originalDocuments = [...sapAllowedBillingDocuments];
    const originalStartAt = env.SAP_POLL_START_AT;
    const customerWasAllowed = sapAllowedCustomers.has('550071');
    const createdAt = `/Date(${Date.parse(`${env.SAP_POLL_START_DATE}T00:00:00.000Z`)})/`;
    let filter = '';
    const fakeClient = {
      async collection(
        _service: string,
        _entitySet: string,
        options: { filter?: string } = {},
      ): Promise<ODataRecord[]> {
        filter = options.filter ?? '';
        return ['BEFORE', 'AFTER'].map((id) => ({
          BillingDocument: id,
          BillingDocumentType: 'G2',
          CreationDate: createdAt,
          CreationTime: id === 'BEFORE' ? 'PT11H59M59S' : 'PT12H00M01S',
          SoldToParty: '550071',
        }));
      },
    } as unknown as SapODataClient;
    sapAllowedBillingDocuments.clear();
    env.SAP_POLL_START_AT = `${env.SAP_POLL_START_DATE}T12:00:00.000Z`;
    sapAllowedCustomers.add('550071');
    try {
      const rows = await new SapInvoiceSource(fakeClient).list();
      assert.deepEqual(rows.map((row) => row.billingDocument), ['AFTER']);
      assert.equal(filter.includes('BillingDocument eq'), false);
    } finally {
      env.SAP_POLL_START_AT = originalStartAt;
      for (const id of originalDocuments) sapAllowedBillingDocuments.add(id);
      if (!customerWasAllowed) sapAllowedCustomers.delete('550071');
    }
  });

  it('normalizes Indian customer phone numbers to E.164 digits', () => {
    assert.equal(normalizeIndianPhone('7019339764'), '917019339764');
    assert.equal(normalizeIndianPhone('+91 70193 39764'), '917019339764');
    assert.equal(normalizeIndianPhone('0917019339764'), '917019339764');
  });

  it('parses SAP OData dates and combines creation time', () => {
    assert.equal(sapDateOnly('/Date(1785283200000)/'), '2026-07-29');
    assert.equal(
      combineSapDateAndTime('/Date(1785283200000)/', 'PT13H32M28S'),
      '2026-07-29T13:32:28.000Z',
    );
    assert.equal(sapDateTime('/Date(1785283200000)/'), '2026-07-29T00:00:00.000Z');
  });

  it('reads customer phones using the AddressID supported by SAP', async () => {
    const calls: Array<{ entitySet: string; filter?: string }> = [];
    const createdAt = `/Date(${Date.parse(`${env.SAP_POLL_START_DATE}T00:00:00.000Z`)})/`;
    const fakeClient = {
      async collection(
        _service: string,
        entitySet: string,
        options: { filter?: string } = {},
      ): Promise<ODataRecord[]> {
        calls.push({ entitySet, filter: options.filter });
        if (entitySet === 'A_BillingDocument') {
          return [{
            BillingDocument: 'TEST000001',
            BillingDocumentType: 'F2',
            BillingDocumentDate: createdAt,
            CreationDate: createdAt,
            CreationTime: 'PT12H00M00S',
            SoldToParty: '550071',
            TransactionCurrency: 'INR',
            TotalNetAmount: '100.00',
            TotalGrossAmount: '118.00',
          }];
        }
        if (entitySet === 'A_BillingDocumentItem') return [];
        if (entitySet === 'A_BusinessPartner') {
          return [{ BusinessPartner: '550071', BusinessPartnerFullName: 'Sri Praveen Enterprises' }];
        }
        if (entitySet === 'A_BusinessPartnerAddress') return [{ AddressID: 'ADDR-1' }];
        if (entitySet === 'A_AddressPhoneNumber') {
          return [{ AddressID: 'ADDR-1', PhoneNumber: '7019339764', IsDefaultPhoneNumber: true }];
        }
        return [];
      },
      async functionImport(): Promise<ODataRecord> {
        return { d: { GetPDF: { BillingDocumentBinary: Buffer.from('%PDF-1.4\n').toString('base64') } } };
      },
    } as unknown as SapODataClient;

    const customerWasAlreadyAllowed = sapAllowedCustomers.has('550071');
    const documentWasAlreadyAllowed = sapAllowedBillingDocuments.has('TEST000001');
    sapAllowedCustomers.add('550071');
    sapAllowedBillingDocuments.add('TEST000001');
    try {
      const invoice = await new SapInvoiceSource(fakeClient).get('TEST000001');
      assert.equal(invoice.contact.normalizedValue, '917019339764');
      const phoneCall = calls.find((call) => call.entitySet === 'A_AddressPhoneNumber');
      assert.equal(phoneCall?.filter, "(AddressID eq 'ADDR-1')");
      assert.equal(phoneCall?.filter?.includes('BusinessPartner'), false);
    } finally {
      if (!customerWasAlreadyAllowed) sapAllowedCustomers.delete('550071');
      if (!documentWasAlreadyAllowed) sapAllowedBillingDocuments.delete('TEST000001');
    }
  });
});
