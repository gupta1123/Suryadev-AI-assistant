import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FixtureInvoiceSource } from './fixture-source.js';
import {
  getBillingDocumentDefinition,
  isTmtDocument,
  SUPPORTED_BILLING_DOCUMENT_TYPES,
} from './document-policy.js';

describe('billing document routing policy', () => {
  it('maps each client-requested SAP type to a distinct document kind and template', () => {
    const definitions = SUPPORTED_BILLING_DOCUMENT_TYPES.map((type) =>
      getBillingDocumentDefinition(type),
    );

    assert.deepEqual(
      definitions.map((definition) => definition?.kind),
      ['invoice', 'cancelled_invoice', 'return_credit_memo', 'credit_memo', 'debit_memo'],
    );
    assert.equal(new Set(definitions.map((definition) => definition?.templateName)).size, 5);
    assert.equal(getBillingDocumentDefinition('unsupported'), null);
  });

  it('accepts the TMT fixture and rejects a non-TMT material', async () => {
    const candidate = await new FixtureInvoiceSource().get('sap-invoice-0090000001');
    assert.equal(isTmtDocument(candidate), true);

    const nonTmt = {
      items: [{
        itemNumber: '000010',
        productId: 'SPONGE-IRON',
        description: 'Sponge Iron',
        rawData: {},
      }],
    };
    assert.equal(isTmtDocument(nonTmt), false);
  });

  it('uses an explicit TMT description token as the temporary master-data fallback', () => {
    assert.equal(isTmtDocument({
      items: [{
        itemNumber: '000010',
        productId: '20020099',
        description: 'Fe 550D TMT Bar 12MM',
        rawData: {},
      }],
    }), true);
    assert.equal(isTmtDocument({
      items: [{
        itemNumber: '000010',
        productId: '20020098',
        description: 'Fly Ash',
        rawData: {},
      }],
    }), false);
  });
});
