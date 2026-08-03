import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMsg91InvoiceButtonResponse } from './help-requests.js';

describe('MSG91 invoice button replies', () => {
  it('parses a stringified Need Help quick reply and links it to the original message', () => {
    const result = parseMsg91InvoiceButtonResponse({
      direction: '0',
      button: JSON.stringify({ payload: 'needs_help', text: 'Need Help' }),
      replyMsgId: 'outbound-wamid',
      customerNumber: '917019339764',
      messages: JSON.stringify([
        { from: '917019339764', id: 'inbound-wamid', timestamp: '1785310953', type: 'button' },
      ]),
    });

    assert.equal(result?.responseType, 'needs_help');
    assert.equal(result?.replyMessageId, 'outbound-wamid');
    assert.equal(result?.inboundMessageId, 'inbound-wamid');
    assert.equal(result?.customerNumber, '917019339764');
  });

  it('parses Received as an acknowledgement', () => {
    const result = parseMsg91InvoiceButtonResponse({
      button: { payload: 'received', text: 'Received' },
      reply_msg_id: 'outbound-wamid',
      uuid: 'inbound-wamid',
      ts: '2026-07-29T16:00:00+05:30',
    });

    assert.equal(result?.responseType, 'received');
    assert.equal(result?.receivedAt, '2026-07-29T10:30:00.000Z');
  });

  it('uses the WhatsApp context ID when MSG91 leaves replyMsgId blank', () => {
    const result = parseMsg91InvoiceButtonResponse({
      button: JSON.stringify({ payload: 'Need Help', text: 'Need Help' }),
      replyMsgId: '',
      uuid: 'inbound-wamid',
      customerNumber: '918149346236',
      messages: JSON.stringify([
        {
          context: { from: '919822486740', id: 'outbound-context-wamid' },
          from: '918149346236',
          id: 'inbound-wamid',
          type: 'button',
        },
      ]),
    });

    assert.equal(result?.responseType, 'needs_help');
    assert.equal(result?.replyMessageId, 'outbound-context-wamid');
    assert.equal(result?.inboundMessageId, 'inbound-wamid');
    assert.equal(result?.customerNumber, '918149346236');
  });

  it('ignores ordinary inbound text messages', () => {
    assert.equal(parseMsg91InvoiceButtonResponse({ messages: '[{"text":{"body":"Hello"}}]' }), null);
  });

  it('does not silently discard a recognized button with no original-message context', () => {
    assert.throws(
      () =>
        parseMsg91InvoiceButtonResponse({
          button: { payload: 'needs_help', text: 'Need Help' },
          uuid: 'inbound-wamid',
        }),
      /missing the original message context/,
    );
  });
});
