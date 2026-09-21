import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  env,
  sapAllowedCustomers,
  whatsappTestRecipients,
} from '../../config/env.js';
import { FixtureInvoiceSource } from './fixture-source.js';
import { automaticDeliveryBlocker } from './sap-poller.js';

describe('automatic SAP delivery boundary', () => {
  it('blocks a cancelled F2 original but permits the corresponding S1 document', async () => {
    const candidate = await new FixtureInvoiceSource().get('sap-invoice-0090000001');
    candidate.creationDateTime = `${env.SAP_POLL_START_DATE}T12:00:00.000Z`;
    candidate.isCancelled = true;

    const customer = candidate.customer.customerNumber;
    const recipient = candidate.contact.normalizedValue;
    const customerWasAllowed = sapAllowedCustomers.has(customer);
    const recipientWasAllowed = whatsappTestRecipients.has(recipient);
    sapAllowedCustomers.add(customer);
    whatsappTestRecipients.add(recipient);
    try {
      assert.match(automaticDeliveryBlocker(candidate) ?? '', /cancelled original/);
      candidate.billingDocumentType = 'S1';
      assert.equal(automaticDeliveryBlocker(candidate), null);

      candidate.isCancelled = false;
      for (const type of ['F2', 'S1', 'CBRE', 'G2', 'L2']) {
        candidate.billingDocumentType = type;
        assert.equal(automaticDeliveryBlocker(candidate), null, `${type} should be deliverable`);
      }
    } finally {
      if (!customerWasAllowed) sapAllowedCustomers.delete(customer);
      if (!recipientWasAllowed) whatsappTestRecipients.delete(recipient);
    }
  });
});
