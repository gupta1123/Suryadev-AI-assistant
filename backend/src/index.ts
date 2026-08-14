import { app } from './app.js';
import { env, isSupabaseServiceConfigured } from './config/env.js';
import {
  startDeliveryWorker,
  stopDeliveryWorker,
} from './modules/invoice-delivery/worker.js';
import {
  startSapInvoicePoller,
  stopSapInvoicePoller,
} from './modules/invoice-delivery/sap-poller.js';
import {
  startMsg91StatusPoller,
  stopMsg91StatusPoller,
} from './modules/invoice-delivery/msg91-status.js';
import {
  startPaymentFollowUpWorker,
  stopPaymentFollowUpWorker,
} from './modules/payment-follow-up/worker.js';
import {
  startPaymentFollowUpScheduler,
  stopPaymentFollowUpScheduler,
} from './modules/payment-follow-up/scheduler.js';

const server = app.listen(env.PORT, () => {
  console.log(`SuryaDev API listening on http://localhost:${env.PORT}`);
});

if (isSupabaseServiceConfigured) {
  startDeliveryWorker();
  startSapInvoicePoller();
  startMsg91StatusPoller();
  startPaymentFollowUpWorker();
  startPaymentFollowUpScheduler();
}

function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  stopDeliveryWorker();
  stopSapInvoicePoller();
  stopMsg91StatusPoller();
  stopPaymentFollowUpScheduler();
  stopPaymentFollowUpWorker();
  server.close((error) => {
    if (error) {
      console.error('Failed to close HTTP server', error);
      process.exit(1);
    }

    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
