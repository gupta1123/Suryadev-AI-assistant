import { Router } from 'express';
import {
  env,
  isMsg91Configured,
  isSapConfigured,
  isSapPollingConfigured,
  isSupabaseConfigured,
  isSupabaseServiceConfigured,
} from '../config/env.js';

export const healthRouter = Router();

healthRouter.get('/', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'suryadev-ai-agents-api',
    supabaseConfigured: isSupabaseConfigured,
    supabaseServiceConfigured: isSupabaseServiceConfigured,
    invoiceSource: env.INVOICE_SOURCE,
    deliveryMode: env.DELIVERY_MODE,
    msg91Configured: isMsg91Configured,
    sendEnabled: env.MSG91_SEND_ENABLED,
    msg91WebhookConfigured: Boolean(env.MSG91_WEBHOOK_SECRET),
    msg91StatusPollingEnabled: env.MSG91_STATUS_POLL_ENABLED,
    sapConfigured: isSapConfigured,
    sapPollingReady: isSapPollingConfigured,
    sapPollStartDate: env.SAP_POLL_START_DATE,
    timestamp: new Date().toISOString(),
  });
});
