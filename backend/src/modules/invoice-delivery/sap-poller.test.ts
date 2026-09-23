import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  env,
  sapAllowedBillingDocuments,
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
    const document = candidate.billingDocument;
    const customerWasAllowed = sapAllowedCustomers.has(customer);
    const recipientWasAllowed = whatsappTestRecipients.has(recipient);
    const documentWasAllowed = sapAllowedBillingDocuments.has(document);
    sapAllowedCustomers.add(customer);
    whatsappTestRecipients.add(recipient);
    sapAllowedBillingDocuments.add(document);
    try {
      sapAllowedBillingDocuments.delete(document);
      assert.match(automaticDeliveryBlocker(candidate) ?? '', /test document boundary/);
      sapAllowedBillingDocuments.add(document);
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
      if (!documentWasAllowed) sapAllowedBillingDocuments.delete(document);
    }
  });

  it('accepts only newly created documents in the future-document UAT mode', async () => {
    const candidate = await new FixtureInvoiceSource().get('sap-invoice-0090000001');
    const originalDocuments = [...sapAllowedBillingDocuments];
    const originalStartAt = env.SAP_POLL_START_AT;
    const customer = candidate.customer.customerNumber;
    const recipient = candidate.contact.normalizedValue;
    const customerWasAllowed = sapAllowedCustomers.has(customer);
    const recipientWasAllowed = whatsappTestRecipients.has(recipient);
    sapAllowedBillingDocuments.clear();
    env.SAP_POLL_START_AT = `${env.SAP_POLL_START_DATE}T12:00:00.000Z`;
    sapAllowedCustomers.add(customer);
    whatsappTestRecipients.add(recipient);
    try {
      candidate.creationDateTime = `${env.SAP_POLL_START_DATE}T11:59:59.000Z`;
      assert.match(automaticDeliveryBlocker(candidate) ?? '', /test document boundary/);
      candidate.creationDateTime = `${env.SAP_POLL_START_DATE}T12:00:01.000Z`;
      assert.equal(automaticDeliveryBlocker(candidate), null);
    } finally {
      env.SAP_POLL_START_AT = originalStartAt;
      for (const id of originalDocuments) sapAllowedBillingDocuments.add(id);
      if (!customerWasAllowed) sapAllowedCustomers.delete(customer);
      if (!recipientWasAllowed) whatsappTestRecipients.delete(recipient);
    }
  });
});
