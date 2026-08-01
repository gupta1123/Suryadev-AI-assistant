import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5173'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  ADMIN_USERNAME: z.string().min(1).max(64).default('admin'),
  ADMIN_PASSWORD: z.string().min(1).max(128).default('admin'),
  AUTH_SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(168),
  INVOICE_SOURCE: z.enum(['fixture', 'sap']).default('fixture'),
  FIXTURE_DIRECTORY: z.string().min(1).default('fixtures/sap'),
  DELIVERY_MODE: z.enum(['test', 'production']).default('test'),
  SAP_BASE_URL: z.string().url().optional(),
  SAP_API_BASE_URL: z.string().url().optional(),
  SAP_API_USERNAME: z.string().min(1).optional(),
  SAP_API_PASSWORD: z.string().min(1).optional(),
  SAP_POLL_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SAP_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(300000).default(15000),
  SAP_POLL_START_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-07-29'),
  SAP_ALLOWED_CUSTOMERS: z.string().default(''),
  SAP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  JOB_LOCK_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  MSG91_AUTHKEY: z.string().min(1).optional(),
  MSG91_INTEGRATED_NUMBER: z.string().optional(),
  MSG91_SEND_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  MSG91_TEMPLATE_NAME: z.string().min(1).default('share_invoice'),
  MSG91_TEMPLATE_LANGUAGE: z.string().min(1).default('en'),
  MSG91_TEMPLATE_TEAM_NAME: z.string().min(1).default('SuryaDev'),
  MSG91_WEBHOOK_SECRET: z.string().min(16).optional(),
  MSG91_STATUS_POLL_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  MSG91_STATUS_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(300000).default(15000),
  WHATSAPP_DEFAULT_TEST_RECIPIENT: z.string().default(''),
  WHATSAPP_TEST_RECIPIENTS: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isSupabaseConfigured = Boolean(
  env.SUPABASE_URL &&
    (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_PUBLISHABLE_KEY),
);

export const isSupabaseServiceConfigured = Boolean(
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY,
);

export function digitsOnly(value: string | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

export const defaultWhatsappTestRecipient = digitsOnly(
  env.WHATSAPP_DEFAULT_TEST_RECIPIENT,
);

export const whatsappTestRecipients = new Set([
  ...env.WHATSAPP_TEST_RECIPIENTS.split(',').map(digitsOnly),
  defaultWhatsappTestRecipient,
].filter(Boolean));

export const isMsg91Configured = Boolean(
  env.MSG91_AUTHKEY && digitsOnly(env.MSG91_INTEGRATED_NUMBER),
);

export const isSapConfigured = Boolean(
  env.SAP_API_BASE_URL && env.SAP_API_USERNAME && env.SAP_API_PASSWORD,
);

export const sapAllowedCustomers = new Set(
  env.SAP_ALLOWED_CUSTOMERS.split(',').map((value) => value.trim()).filter(Boolean),
);

export const isSapPollingConfigured = Boolean(
  env.INVOICE_SOURCE === 'sap' &&
    env.SAP_POLL_ENABLED &&
    isSapConfigured &&
    sapAllowedCustomers.size > 0,
);
