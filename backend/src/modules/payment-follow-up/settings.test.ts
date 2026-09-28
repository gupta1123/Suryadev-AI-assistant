import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultReminderSettings,
  parseStoredReminderSettings,
  reminderSettingsSchema,
} from './settings.js';

describe('payment reminder settings', () => {
  it('falls back to the server defaults when nothing is saved', () => {
    assert.deepEqual(parseStoredReminderSettings(undefined), defaultReminderSettings());
    assert.equal(parseStoredReminderSettings(undefined).source, 'server_default');
  });

  it('uses saved values from Settings', () => {
    const saved = parseStoredReminderSettings({
      firstReminderDelaySeconds: 3 * 86_400,
      repeatReminderDelaySeconds: 7 * 86_400,
      maximumReminders: 3,
      updatedAt: '2026-09-28T10:00:00.000Z',
    });
    assert.deepEqual(saved, {
      firstReminderDelaySeconds: 259_200,
      repeatReminderDelaySeconds: 604_800,
      maximumReminders: 3,
      source: 'saved',
      updatedAt: '2026-09-28T10:00:00.000Z',
    });
  });

  it('ignores a corrupted saved value instead of scheduling with it', () => {
    const stored = { firstReminderDelaySeconds: 0, repeatReminderDelaySeconds: 60, maximumReminders: 2 };
    assert.equal(parseStoredReminderSettings(stored).source, 'server_default');
  });

  it('rejects timings outside 10 seconds to 30 days and more than 10 reminders', () => {
    const valid = { firstReminderDelaySeconds: 120, repeatReminderDelaySeconds: 180, maximumReminders: 2 };
    assert.ok(reminderSettingsSchema.safeParse(valid).success);
    assert.ok(reminderSettingsSchema.safeParse({ ...valid, firstReminderDelaySeconds: 15 }).success);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, firstReminderDelaySeconds: 9 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, repeatReminderDelaySeconds: 9 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, repeatReminderDelaySeconds: 31 * 86_400 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, maximumReminders: 11 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, maximumReminders: 1.5 }).success, false);
  });
});
