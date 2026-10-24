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
  isDashboardCustomerApprovalEnabled,
} from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { type AuthenticatedRequest, requireAdmin } from '../../middleware/auth.js';
import { getSapMasterCustomers, type SapMasterCustomer } from '../customers/sap-masters.js';
import { currentCeilings } from './guard.js';
import { evaluateSapManagerCopy } from './sap-manager-policy.js';
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
import { DOCUMENT_SEND_CUTOFF } from './document-date-policy.js';
import { listTmtMaterials, materialCodeSchema, setTmtMaterial } from './tmt-materials.js';

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

messagingRouter.get('/tmt-materials', asyncHandler(async (request, response) => {
  const query = z.object({ refresh: z.enum(['true', 'false']).optional(), code: materialCodeSchema.optional() }).parse(request.query);
  response.json({ data: await listTmtMaterials(query.refresh === 'true', query.code) });
}));
messagingRouter.put('/tmt-materials/:code', asyncHandler(async (request: AuthenticatedRequest, response) => {
  const code = materialCodeSchema.parse(request.params.code);
  const input = z.object({ enabled: z.boolean(), expectedEnabled: z.boolean(), confirmMaterial: z.string(), acknowledgePending: z.boolean() }).parse(request.body);
  if (input.confirmMaterial !== code || !input.acknowledgePending) throw new HttpError(409, 'Confirm the material code and pending-document warning');
  const who = actor(request);
  const changed = await setTmtMaterial(code, input.enabled, input.expectedEnabled, who.username);
  await writeMessagingAudit({ action: input.enabled ? 'tmt_material_enabled' : 'tmt_material_disabled', entityId: code, before: changed.before, after: changed.after, ...who });
  response.json({ data: { code, enabled: input.enabled, updatedAt: changed.updatedAt } });
}));

function requireCeilingCustomer(customerNumber: string): void {
  // Legacy test deployments retain their server list; dashboard mode requires
  // a fresh, exact SAP customer/phone approval below instead.
  if (!isDashboardCustomerApprovalEnabled() && env.DELIVERY_MODE === 'test' && !sapAllowedCustomers.has(customerNumber)) {
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
    const dashboard = isDashboardCustomerApprovalEnabled();
    const customerNumbers = [...new Set([...sapAllowedCustomers, ...byCustomer.keys(), ...(dashboard ? live.keys() : [])])].sort();
    const internalByPhone = new Map(internal.map((item) => [item.phone, item]));
    const ceilingPhones = [...whatsappTestRecipients];

    response.json({
      data: {
        deliveryMode: env.DELIVERY_MODE,
        sapHost: sapHostname,
        sapHostApproved: isSapHostApproved,
        directoryError,
        approvalMode: env.CUSTOMER_APPROVAL_MODE,
        dashboardApprovalReady: dashboard,
        approvalBlocker: null,
        documentCutoff: DOCUMENT_SEND_CUTOFF,
        customers: customerNumbers.map((customerNumber) => {
          const setting = byCustomer.get(customerNumber) ?? null;
          const entry = live.get(customerNumber);
          const insideCeiling = (dashboard && Boolean(entry)) || env.DELIVERY_MODE !== 'test' || sapAllowedCustomers.has(customerNumber);
          const livePhone = entry?.primaryPhone ?? null;
          const manager = env.MSG91_MARKETING_COPY_SOURCE === 'sap'
            ? evaluateSapManagerCopy(currentCeilings(), setting, entry?.salesAssignments ?? [])
            : evaluateManagerCopy(currentCeilings(), setting);
          return {
            customerNumber,
            name: entry?.name ?? null,
            livePhone,
            insideCeiling,
            status: customerStatus(insideCeiling, setting, livePhone),
            setting,
            managerCopy: {
              source: env.MSG91_MARKETING_COPY_SOURCE,
              recipient: manager.allowed ? manager.recipient : null,
              allowed: manager.allowed && env.MSG91_MARKETING_COPY_ENABLED,
              reason: !env.MSG91_MARKETING_COPY_ENABLED ? 'Manager copies are disabled on the server' : manager.allowed ? null : manager.reason,
            },
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
          documentDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
          setting,
          internal: await getInternalRecipient(livePhone),
        })
      : ({ allowed: false, reason: 'SAP has no phone number for this customer' } as const);
    const manager = env.MSG91_MARKETING_COPY_SOURCE === 'sap'
      ? evaluateSapManagerCopy(ceilings, setting, entry?.salesAssignments ?? [])
      : evaluateManagerCopy(ceilings, setting);
    const check = (label: string, passed: boolean, detail?: string) => ({ label, passed, detail: detail ?? null });
    response.json({
      data: {
        customerNumber,
        // Nothing is sent by this endpoint. It only reports what would be decided now.
        checks: [
          check('SAP host is the approved test system', isSapHostApproved),
          check('Customer can be approved in this deployment', (Boolean(ceilings.dashboardApprovals) && Boolean(entry)) || ceilings.mode !== 'test' || ceilings.customers.has(customerNumber)),
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

// Read-only confirmation data. Opening this dialog never approves or queues a send.
messagingRouter.get('/customers/:customerNumber/approval-preview', asyncHandler(async (request, response) => {
  const customerNumber = customerNumberSchema.parse(request.params.customerNumber);
  const directory = await getSapMasterCustomers(true);
  const entry = directory.items.find(row => row.customerNumber === customerNumber);
  if (!entry) throw new HttpError(404, 'This customer was not found in SAP');
  const phone = entry.primaryPhone;
  const canEnable = Boolean(phone && PHONE_PATTERN.test(phone) &&
    (isDashboardCustomerApprovalEnabled() || env.DELIVERY_MODE !== 'test' ||
      (sapAllowedCustomers.has(customerNumber) && whatsappTestRecipients.has(phone))));
  const previewSetting: CustomerMessagingSetting = {
    sapCustomerNumber: customerNumber, enabled: true, approvedPhone: phone, enabledAt: new Date().toISOString(),
    managerName: null, managerPhone: null, managerSource: 'sap', updatedBy: null, updatedAt: null,
  };
  const manager = evaluateSapManagerCopy(currentCeilings(), previewSetting, entry.salesAssignments);
  response.json({ data: {
    customerNumber, name: entry.name, phone, canEnable, documentCutoff: DOCUMENT_SEND_CUTOFF,
    sharedPhoneCustomers: directory.items.filter(row => row.customerNumber !== customerNumber &&
      row.phones.some(value => value.number === phone)).map(row => ({ customerNumber: row.customerNumber, name: row.name })),
    managerRecipient: manager.allowed && env.MSG91_MARKETING_COPY_ENABLED ? manager.recipient : null,
    managerReason: !env.MSG91_MARKETING_COPY_ENABLED ? 'Manager copies are disabled' : manager.allowed ? null : manager.reason,
    blocker: canEnable ? null : !phone || !PHONE_PATTERN.test(phone) ? 'SAP has no valid phone number' :
      'Dashboard onboarding is not enabled on the server',
  } });
}));

const enabledSchema = z.object({
  enabled: z.boolean(),
  // The phone the administrator was shown and is approving.
  expectedPhone: z.string().optional(),
  acknowledgeRecipient: z.boolean().optional(),
  acknowledgeSharedPhone: z.boolean().optional(),
});

messagingRouter.put(
  '/customers/:customerNumber/enabled',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const customerNumber = customerNumberSchema.parse(request.params.customerNumber);
    const input = enabledSchema.parse(request.body ?? {});
    const before = await getCustomerSetting(customerNumber);
    const who = actor(request);

    if (!input.enabled) {
      const after = await saveCustomerSetting(customerNumber, { enabled: false }, who.username);
      await writeMessagingAudit({ action: 'messaging_customer_disabled', entityId: customerNumber, before, after, ...who });
      response.json({ data: after });
      return;
    }
    requireCeilingCustomer(customerNumber);

    // Enabling always re-reads SAP and approves the phone the administrator saw.
    const entry = await liveCustomer(customerNumber, true);
    if (!entry) throw new HttpError(404, 'This customer was not found in SAP');
    const livePhone = entry.primaryPhone;
    if (!livePhone || !PHONE_PATTERN.test(livePhone)) throw new HttpError(409, 'SAP has no valid phone number for this customer');
    if (normalizePhone(input.expectedPhone ?? '') !== livePhone) {
      throw new HttpError(409, 'The SAP phone number changed. Reload the list and review the new number.');
    }
    if (!isDashboardCustomerApprovalEnabled() && env.DELIVERY_MODE === 'test' && !whatsappTestRecipients.has(livePhone)) {
      throw new HttpError(403, 'This phone number is not in the server-approved test numbers');
    }
    if (isDashboardCustomerApprovalEnabled()) {
      if (!input.acknowledgeRecipient) throw new HttpError(409, 'Confirm the customer and destination number before enabling');
      const directory = await getSapMasterCustomers(false);
      const shared = directory.items.some(row => row.customerNumber !== customerNumber && row.phones.some(phone => phone.number === livePhone));
      if (shared && !input.acknowledgeSharedPhone) throw new HttpError(409, 'This phone is also used by another SAP customer. Confirm the shared number explicitly.');
    }
    if (before?.enabled && before.approvedPhone === livePhone) {
      response.json({ data: before });
      return;
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
    if (env.MSG91_MARKETING_COPY_SOURCE === 'sap') {
      throw new HttpError(409, 'Manager copies use live SAP sales-group mappings. Update the manager in SAP, not a manual test assignment.');
    }
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
