import { randomUUID } from 'node:crypto';
import {
  env,
  isHelpRequestAlertConfigured,
  whatsappTestRecipients,
} from '../../config/env.js';
import {
  claimNextHelpRequestAlert,
  deferHelpRequestAlert,
  markHelpRequestAlertFailed,
  markHelpRequestAlertSent,
  releaseStaleHelpRequestAlerts,
} from './help-alerts.js';
import {
  isWhatsappTemplateApproved,
  sendHelpRequestAlertTemplate,
} from './msg91-client.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
const workerName = `help-request-alert-${randomUUID().slice(0, 8)}`;

export function startHelpRequestAlertWorker(): () => void {
  if (timer || !isHelpRequestAlertConfigured) return stopHelpRequestAlertWorker;
  timer = setInterval(() => {
    void processHelpRequestAlertQueue();
  }, env.JOB_POLL_INTERVAL_MS);
  timer.unref();
  void processHelpRequestAlertQueue();
  return stopHelpRequestAlertWorker;
}

export function stopHelpRequestAlertWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function processHelpRequestAlertQueue(): Promise<void> {
  if (running || !isHelpRequestAlertConfigured) return;
  running = true;
  try {
    await releaseStaleHelpRequestAlerts(
      new Date(Date.now() - env.JOB_LOCK_TIMEOUT_MINUTES * 60_000),
    );
    while (true) {
      const notification = await claimNextHelpRequestAlert(workerName);
      if (!notification) break;

      try {
        if (
          env.DELIVERY_MODE === 'test' &&
          !whatsappTestRecipients.has(notification.recipient)
        ) {
          await markHelpRequestAlertFailed(
            notification,
            'Help request alert recipient is not on the WhatsApp test allowlist',
            true,
          );
          continue;
        }

        const approved = await isWhatsappTemplateApproved(
          notification.templateName,
          notification.templateLanguage,
        );
        if (!approved) {
          await deferHelpRequestAlert(
            notification,
            `WhatsApp template ${notification.templateName} is not approved yet`,
            { delayMs: 10 * 60_000, preserveAttempt: true },
          );
          continue;
        }

        const result = await sendHelpRequestAlertTemplate({
          recipient: notification.recipient,
          templateName: notification.templateName,
          templateLanguage: notification.templateLanguage,
          ...notification.details,
        });
        if (result.ok) {
          await markHelpRequestAlertSent(notification.id, {
            ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
            ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
          });
          continue;
        }

        const terminal = result.ambiguous || (result.statusCode >= 400 && result.statusCode < 500);
        const message = result.ambiguous
          ? 'MSG91 help alert timed out; delivery outcome is unknown'
          : `MSG91 rejected the help request alert (HTTP ${result.statusCode})`;
        await markHelpRequestAlertFailed(notification, message, terminal);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown help request alert error';
        await markHelpRequestAlertFailed(notification, message);
      }
    }
  } catch (error) {
    console.error('Help request alert worker failed', error);
  } finally {
    running = false;
  }
}
