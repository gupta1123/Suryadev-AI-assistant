import { env, isPaymentFollowUpTestConfigured } from '../../config/env.js';
import {
  enqueueNextDuePaymentReminder,
  preparePaymentTestSchedule,
} from './repository.js';
import { processPaymentFollowUpQueue } from './worker.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startPaymentFollowUpScheduler(): () => void {
  if (
    timer ||
    !isPaymentFollowUpTestConfigured ||
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
  if (running || !isPaymentFollowUpTestConfigured || !env.PAYMENT_FOLLOW_UP_SEND_ENABLED) return;
  running = true;
  try {
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
    await preparePaymentTestSchedule();
    console.log(
      `Controlled payment scheduler ready: first reminder after ${env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS}s, repeats after ${env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS}s, ${env.PAYMENT_TEST_MAX_REMINDERS} reminder cap`,
    );
    await runPaymentFollowUpSchedule();
  } catch (error) {
    console.error('Unable to initialize the controlled payment follow-up scheduler', error);
  }
}
