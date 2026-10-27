import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultReminderSettings,
  parseStoredReminderSettings,
  reminderSettingsSchema,
  journeySettings,
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
      dueDays: 3,
      firstReminderDelaySeconds: 259_200,
      repeatReminderDelaySeconds: 604_800,
      maximumReminders: 3,
      source: 'saved',
      updatedAt: '2026-09-28T10:00:00.000Z',
    });
  });

  it('blocks new journeys when stored settings are corrupted', () => {
    const stored = { firstReminderDelaySeconds: 0, repeatReminderDelaySeconds: 60, maximumReminders: 2 };
    assert.throws(()=>parseStoredReminderSettings(stored),/new journeys are blocked/);
  });

  it('validates due days and preserves a journey snapshot after defaults change', () => {
    const old = { ...defaultReminderSettings(),dueDays:3,firstReminderDelaySeconds:120,repeatReminderDelaySeconds:180,maximumReminders:3 };
    const next = { ...old,dueDays:7,repeatReminderDelaySeconds:600,maximumReminders:1 };
    assert.equal(journeySettings({journey_settings:old},next).dueDays,3);
    assert.equal(journeySettings({journey_settings:old},next).repeatReminderDelaySeconds,180);
    assert.equal(journeySettings({journey_settings:old},next).maximumReminders,3);
    assert.equal(journeySettings({},next).dueDays,7);
    for (const dueDays of [0,91,1.5,'',null]) assert.equal(reminderSettingsSchema.safeParse({...old,dueDays}).success,false);
    assert.throws(()=>journeySettings({journey_settings:{...old,dueDays:0}},next),/blocked/);
  });

  it('rejects timings outside 10 seconds to 30 days and more than 10 reminders', () => {
    const valid = { dueDays: 3, firstReminderDelaySeconds: 120, repeatReminderDelaySeconds: 180, maximumReminders: 2 };
    assert.ok(reminderSettingsSchema.safeParse(valid).success);
    assert.ok(reminderSettingsSchema.safeParse({ ...valid, firstReminderDelaySeconds: 15 }).success);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, firstReminderDelaySeconds: 9 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, repeatReminderDelaySeconds: 9 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, repeatReminderDelaySeconds: 31 * 86_400 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, maximumReminders: 11 }).success, false);
    assert.equal(reminderSettingsSchema.safeParse({ ...valid, maximumReminders: 1.5 }).success, false);
  });
});
