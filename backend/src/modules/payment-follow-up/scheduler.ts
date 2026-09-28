import { env, isPaymentFollowUpSchedulerConfigured } from '../../config/env.js';
import {
  enqueueNextDuePaymentReminder,
  preparePaymentTestSchedule,
  repairStalledPaymentSchedules,
} from './repository.js';
import { getReminderSettings } from './settings.js';
import { processPaymentFollowUpQueue } from './worker.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startPaymentFollowUpScheduler(): () => void {
  if (
    timer ||
    !isPaymentFollowUpSchedulerConfigured ||
    !env.PAYMENT_FOLLOW_UP_SEND_ENABLED
  ) {
    return stopPaymentFollowUpScheduler;
  }
  void initializeScheduler();
  timer = setInterval(() => {
    void runPaymentFollowUpSchedule();
  }, env.PAYMENT_SCHEDULER_POLL_INTERVAL_MS);
  timer.unref();
  return stopPaymentFollowUpScheduler;
}

export function stopPaymentFollowUpScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function runPaymentFollowUpSchedule(): Promise<void> {
  if (running || !isPaymentFollowUpSchedulerConfigured || !env.PAYMENT_FOLLOW_UP_SEND_ENABLED) return;
  running = true;
  try {
    const repaired = await repairStalledPaymentSchedules();
    if (repaired.length) {
      console.log(`Rescheduled payment reminders that were missed after delivery: cases ${repaired.join(', ')}`);
    }
    const result = await enqueueNextDuePaymentReminder();
    if (result.enqueued) {
      console.log(`Controlled payment reminder ${result.jobId} queued after receivable status recheck`);
      await processPaymentFollowUpQueue();
    } else if (result.reason === 'payment_closed') {
      console.log('Controlled payment reminder stopped because the receivable is closed');
    } else if (result.reason === 'reminder_cap_reached') {
      console.log('Controlled payment reminder test reached its configured send cap');
    }
  } catch (error) {
    console.error('Controlled payment follow-up scheduler failed', error);
  } finally {
    running = false;
  }
}

async function initializeScheduler(): Promise<void> {
  try {
    if (!env.PAYMENT_SIMULATION_AUTO_FOLLOW_UP) {
      await preparePaymentTestSchedule();
    }
    const reminderSettings = await getReminderSettings();
    console.log(
      `Controlled payment scheduler ready: first reminder after ${reminderSettings.firstReminderDelaySeconds}s, repeats after ${reminderSettings.repeatReminderDelaySeconds}s, ${reminderSettings.maximumReminders} reminder cap`,
    );
    await runPaymentFollowUpSchedule();
  } catch (error) {
    console.error('Unable to initialize the controlled payment follow-up scheduler', error);
  }
}
