import { Router } from 'express';
import { z } from 'zod';
import {
  env,
  isSapHostApproved,
  sapAllowedCustomers,
  sapHostname,
  whatsappTestRecipients,
  paymentTestRecipients,
  marketingManagerAllowedRecipients,
} from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { type AuthenticatedRequest, requireAdmin } from '../../middleware/auth.js';
import { getSapMasterCustomers, type SapMasterCustomer } from '../customers/sap-masters.js';
import { currentCeilings } from './guard.js';
import {
  type CustomerMessagingSetting,
  evaluateDocumentSend,
  evaluateLivePhone,
  evaluateManagerCopy,
  normalizePhone,
  PHONE_PATTERN,
} from './policy.js';
import {
  getCustomerSetting,
  getInternalRecipient,
  listCustomerSettings,
  listInternalRecipients,
  saveCustomerSetting,
  saveInternalRecipient,
  writeMessagingAudit,
} from './repository.js';

const customerNumberSchema = z.string().regex(/^[A-Za-z0-9]{1,20}$/);
const phoneParamSchema = z.string().regex(PHONE_PATTERN);

export const messagingRouter = Router();

messagingRouter.use((request, response, next) => {
  void requireAdmin(request, response, next);
});

function actor(request: AuthenticatedRequest) {
  return {
    actorUserId: request.auth?.userId,
    username: request.auth?.user.username ?? 'admin',
  };
}

function requireCeilingCustomer(customerNumber: string): void {
  // In test mode only customers named in the server environment can be managed.
  if (env.DELIVERY_MODE === 'test' && !sapAllowedCustomers.has(customerNumber)) {
    throw new HttpError(
      403,
      'This customer is not in the server-approved customer list, so it cannot be enabled here',
    );
  }
}

async function liveCustomer(
  customerNumber: string,
  refresh: boolean,
): Promise<SapMasterCustomer | undefined> {
  const directory = await getSapMasterCustomers(refresh);
  return directory.items.find((item) => item.customerNumber === customerNumber);
}

function customerStatus(
  insideCeiling: boolean,
  setting: CustomerMessagingSetting | null,
  livePhone: string | null,
): 'locked' | 'not_enabled' | 'enabled' | 'phone_changed' {
  if (!insideCeiling) return 'locked';
  if (!setting?.enabled) return 'not_enabled';
  return evaluateLivePhone(setting, livePhone).allowed ? 'enabled' : 'phone_changed';
}

messagingRouter.get(
  '/overview',
  asyncHandler(async (_request, response) => {
    const [settings, internal] = await Promise.all([listCustomerSettings(), listInternalRecipients()]);
    let directoryError: string | null = null;
    let directory: SapMasterCustomer[] = [];
    try {
      directory = (await getSapMasterCustomers(false)).items;
    } catch (error) {
      directoryError = error instanceof Error ? error.message : 'SAP directory unavailable';
    }
    const live = new Map(directory.map((item) => [item.customerNumber, item]));
    const byCustomer = new Map(settings.map((item) => [item.sapCustomerNumber, item]));
    const customerNumbers = [...new Set([...sapAllowedCustomers, ...byCustomer.keys()])].sort();
    const internalByPhone = new Map(internal.map((item) => [item.phone, item]));
    const ceilingPhones = [...whatsappTestRecipients];

    response.json({
      data: {
        deliveryMode: env.DELIVERY_MODE,
        sapHost: sapHostname,
        sapHostApproved: isSapHostApproved,
        directoryError,
        customers: customerNumbers.map((customerNumber) => {
          const setting = byCustomer.get(customerNumber) ?? null;
          const entry = live.get(customerNumber);
          const insideCeiling = env.DELIVERY_MODE !== 'test' || sapAllowedCustomers.has(customerNumber);
          const livePhone = entry?.primaryPhone ?? null;
          return {
            customerNumber,
            name: entry?.name ?? null,
            livePhone,
            insideCeiling,
            status: customerStatus(insideCeiling, setting, livePhone),
            setting,
            managerPhoneApproved:
              !setting?.managerPhone ||
              env.DELIVERY_MODE !== 'test' ||
              marketingManagerAllowedRecipients.has(setting.managerPhone),
          };
        }),
        internalRecipients: ceilingPhones.map((phone) => {
          const row = internalByPhone.get(phone);
          return {
            phone,
            label: row?.label ?? null,
            allowSimulator: row?.allowSimulator ?? false,
            allowPaymentReminders: row?.allowPaymentReminders ?? false,
            paymentCeiling: paymentTestRecipients.has(phone),
            alsoCustomerPhone: directory.some((item) => item.primaryPhone === phone) ||
              settings.some((item) => item.approvedPhone === phone),
            updatedAt: row?.updatedAt ?? null,
          };
        }),
        managerCeilingSize: marketingManagerAllowedRecipients.size,
      },
    });
  }),
);

messagingRouter.get(
  '/customers/:customerNumber/eligibility',
  asyncHandler(async (request, response) => {
    const customerNumber = customerNumberSchema.parse(request.params.customerNumber);
    const [setting, entry] = await Promise.all([
      getCustomerSetting(customerNumber),
      liveCustomer(customerNumber, false),
    ]);
    const ceilings = currentCeilings();
    const livePhone = entry?.primaryPhone ?? null;
    const phoneCheck = evaluateLivePhone(setting, livePhone);
    const sendCheck = livePhone
      ? evaluateDocumentSend(ceilings, {
          source: 'sap',
          customerNumber,
          recipient: livePhone,
          documentCreatedAt: new Date().toISOString(),
          setting,
          internal: await getInternalRecipient(livePhone),
        })
      : ({ allowed: false, reason: 'SAP has no phone number for this customer' } as const);
    const manager = evaluateManagerCopy(ceilings, setting);
    const check = (label: string, passed: boolean, detail?: string) => ({ label, passed, detail: detail ?? null });
    response.json({
      data: {
        customerNumber,
        // Nothing is sent by this endpoint. It only reports what would be decided now.
        checks: [
          check('SAP host is the approved test system', isSapHostApproved),
          check('Customer is in the server-approved list', ceilings.mode !== 'test' || ceilings.customers.has(customerNumber)),
          check('Customer is enabled in Settings', Boolean(setting?.enabled)),
          check('SAP phone matches the approved number', phoneCheck.allowed, phoneCheck.allowed ? undefined : phoneCheck.reason),
          check('A new document would be sent to the customer', sendCheck.allowed, sendCheck.allowed ? undefined : sendCheck.reason),
          manager.allowed && manager.recipient === livePhone
            ? check('Marketing manager copy: not needed', true, 'The manager’s number is the customer’s own number, so no separate copy is sent.')
            : check('Marketing manager copy would be sent', manager.allowed, manager.allowed ? undefined : manager.reason),
        ],
      },
    });
  }),
);

const enabledSchema = z.object({
  enabled: z.boolean(),
  // The phone the administrator was shown and is approving.
  expectedPhone: z.string().optional(),
});

messagingRouter.put(
  '/customers/:customerNumber/enabled',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const customerNumber = customerNumberSchema.parse(request.params.customerNumber);
    const input = enabledSchema.parse(request.body ?? {});
    requireCeilingCustomer(customerNumber);
    const before = await getCustomerSetting(customerNumber);
    const who = actor(request);

    if (!input.enabled) {
      const after = await saveCustomerSetting(customerNumber, { enabled: false }, who.username);
      await writeMessagingAudit({ action: 'messaging_customer_disabled', entityId: customerNumber, before, after, ...who });
      response.json({ data: after });
      return;
    }

    // Enabling always re-reads SAP and approves the phone the administrator saw.
    const entry = await liveCustomer(customerNumber, true);
    if (!entry) throw new HttpError(404, 'This customer was not found in SAP');
    const livePhone = entry.primaryPhone;
    if (!livePhone) throw new HttpError(409, 'SAP has no phone number for this customer');
    if (normalizePhone(input.expectedPhone ?? '') !== livePhone) {
      throw new HttpError(409, 'The SAP phone number changed. Reload the list and review the new number.');
    }
    if (env.DELIVERY_MODE === 'test' && !whatsappTestRecipients.has(livePhone)) {
      throw new HttpError(403, 'This phone number is not in the server-approved test numbers');
    }
    const after = await saveCustomerSetting(
      customerNumber,
      { enabled: true, approved_phone: livePhone, enabled_at: new Date().toISOString() },
      who.username,
    );
    await writeMessagingAudit({ action: 'messaging_customer_enabled', entityId: customerNumber, before, after, ...who });
    response.json({ data: after });
  }),
);

const managerSchema = z.union([
  z.object({ clear: z.literal(true) }),
  z.object({
    managerName: z.string().trim().min(1).max(120),
    managerPhone: z.string().trim().min(1),
    confirmManagerPhone: z.string().trim().min(1),
  }),
]);

messagingRouter.put(
  '/customers/:customerNumber/manager',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const customerNumber = customerNumberSchema.parse(request.params.customerNumber);
    const input = managerSchema.parse(request.body ?? {});
    requireCeilingCustomer(customerNumber);
    const before = await getCustomerSetting(customerNumber);
    const who = actor(request);

    if ('clear' in input) {
      const after = await saveCustomerSetting(
        customerNumber,
        { manager_name: null, manager_phone: null, manager_source: 'manual' },
        who.username,
      );
      await writeMessagingAudit({ action: 'messaging_manager_cleared', entityId: customerNumber, before, after, ...who });
      response.json({ data: after });
      return;
    }

    const phone = normalizePhone(input.managerPhone);
    if (!PHONE_PATTERN.test(phone)) {
      throw new HttpError(400, 'Enter a valid WhatsApp number with country code');
    }
    if (normalizePhone(input.confirmManagerPhone) !== phone) {
      throw new HttpError(400, 'The two manager numbers do not match');
    }
    if (env.DELIVERY_MODE === 'test' && !marketingManagerAllowedRecipients.has(phone)) {
      throw new HttpError(403, 'That number is not in the server-approved marketing manager numbers');
    }
    const after = await saveCustomerSetting(
      customerNumber,
      { manager_name: input.managerName, manager_phone: phone, manager_source: 'manual' },
      who.username,
    );
    await writeMessagingAudit({ action: 'messaging_manager_set', entityId: customerNumber, before, after, ...who });
    response.json({ data: after });
  }),
);

const internalSchema = z.object({
  label: z.string().trim().max(120).nullish(),
  allowSimulator: z.boolean(),
  allowPaymentReminders: z.boolean(),
});

messagingRouter.put(
  '/internal-recipients/:phone',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const phone = phoneParamSchema.parse(request.params.phone);
    const input = internalSchema.parse(request.body ?? {});
    if (env.DELIVERY_MODE === 'test' && !whatsappTestRecipients.has(phone)) {
      throw new HttpError(403, 'That number is not in the server-approved test numbers');
    }
    if (input.allowPaymentReminders && env.DELIVERY_MODE === 'test' && !paymentTestRecipients.has(phone)) {
      throw new HttpError(403, 'That number is not in the server-approved payment test numbers');
    }
    const before = await getInternalRecipient(phone);
    const after = await saveInternalRecipient(
      phone,
      {
        label: input.label || null,
        allow_simulator: input.allowSimulator,
        allow_payment_reminders: input.allowPaymentReminders,
      },
      actor(request).username,
    );
    await writeMessagingAudit({ action: 'messaging_internal_recipient_updated', entityId: phone, before, after, ...actor(request) });
    response.json({ data: after });
  }),
);
