import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FixtureInvoiceSource } from './fixture-source.js';
import { env } from '../../config/env.js';
import { buildMsg91InvoicePayload } from './msg91-client.js';
import {
  getBillingDocumentDefinition,
  isTmtDocument,
  SUPPORTED_BILLING_DOCUMENT_TYPES,
} from './document-policy.js';

describe('billing document routing policy', () => {
  it('routes new invoices to four positional fields and preserves the legacy named format', () => {
    const original = env.MSG91_TEMPLATE_NAME;
    try {
      for (const name of ['share_invoice', 'share_invoice_with_buttons_v2', 'share_invoice_without_buttons_v1']) {
        env.MSG91_TEMPLATE_NAME = name;
        const definition = getBillingDocumentDefinition('F2')!;
        assert.equal(definition.templateName, name);
        assert.equal(definition.parameterFormat, name === 'share_invoice' ? 'named' : 'positional');
        const payload = buildMsg91InvoicePayload({
          templateName: definition.templateName, parameterFormat: definition.parameterFormat,
          templateLanguage: 'en', recipient: '919999999999',
          documentUrl: 'https://example.test/invoice.pdf', documentFileName: 'invoice.pdf',
          customerName: 'Customer One', billingDocument: '9001',
          billingDocumentDate: '14 Oct 2026', formattedAmount: '12,992.00', teamName: 'SuryaDev',
        });
        const template = (payload.payload as any).template;
        const components = template.to_and_components[0].components;
        assert.deepEqual(Object.keys(components).sort(), name === 'share_invoice'
          ? ['body_var_1', 'body_var_2', 'body_var_3', 'body_var_4', 'body_var_5', 'header_1']
          : ['body_1', 'body_2', 'body_3', 'body_4', 'header_1']);
        assert.equal(components.header_1.type, 'document');
      }
    } finally {
      env.MSG91_TEMPLATE_NAME = original;
    }
  });
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
