import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { msg91WebhookEventType } from './webhook.js';

describe('MSG91 webhook payload normalization', () => {
  it('reads the status from the current Webhook (New) eventName field', () => {
    assert.equal(msg91WebhookEventType({ eventName: 'read' }), 'read');
  });

  it('continues to accept older status field names', () => {
    assert.equal(msg91WebhookEventType({ status: 'Delivered' }), 'Delivered');
    assert.equal(msg91WebhookEventType({ data: { event_type: 'failed' } }), 'failed');
  });

  it('does not invent a status for inbound payloads without one', () => {
    assert.equal(msg91WebhookEventType({ webhookType: 'whatsapp', text: 'Hello' }), 'unknown');
  });
});
