import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultHelpRequestAlertSettings,
  helpRequestAlertSettingsSchema,
  normalizeHelpRequestRecipient,
  parseStoredHelpRequestAlertSettings,
} from './help-settings.js';

describe('Need Help alert recipient settings', () => {
  it('normalizes Indian local and formatted numbers', () => {
    assert.equal(normalizeHelpRequestRecipient('7019339764'), '917019339764');
    assert.equal(normalizeHelpRequestRecipient('+91 70193 39764'), '917019339764');
    assert.equal(normalizeHelpRequestRecipient('07019339764'), '917019339764');
  });

  it('accepts valid WhatsApp numbers and rejects invalid values', () => {
    assert.equal(
      helpRequestAlertSettingsSchema.parse({ recipient: '+91 70193 39764' }).recipient,
      '917019339764',
    );
    assert.equal(helpRequestAlertSettingsSchema.safeParse({ recipient: '123' }).success, false);
  });

  it('uses a saved recipient and falls back when saved data is corrupted', () => {
    assert.deepEqual(parseStoredHelpRequestAlertSettings({
      recipient: '917977925397',
      updatedAt: '2026-10-03T10:30:00.000Z',
    }), {
      recipient: '917977925397',
      formattedRecipient: '+91 79779 25397',
      source: 'saved',
      updatedAt: '2026-10-03T10:30:00.000Z',
    });
    assert.deepEqual(
      parseStoredHelpRequestAlertSettings({ recipient: 'bad' }),
      defaultHelpRequestAlertSettings(),
    );
  });
});
