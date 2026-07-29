export type AdminUser = {
  id: 'local-admin';
  username: string;
  displayName: 'Administrator';
  role: 'admin';
};

export type DeliveryConfig = {
  invoiceSource: 'fixture' | 'sap';
  deliveryMode: 'test' | 'production';
  supabaseServiceConfigured: boolean;
  msg91Configured: boolean;
  sendEnabled: boolean;
  msg91WebhookConfigured: boolean;
  msg91StatusPollingEnabled: boolean;
  templateName: string;
  templateLanguage: string;
  testRecipients: string[];
  defaultTestRecipient: string;
  simulationReady: boolean;
  simulationBlockers: string[];
  sapConfigured: boolean;
  sapPollingEnabled: boolean;
  sapPollingReady: boolean;
  sapPollIntervalMs: number;
  sapPollStartDate: string;
  sapAllowedCustomers: string[];
};

export type SapPollingStatus = {
  id: number;
  resource_type: string;
  cursor_value?: string | null;
  watermark_at?: string | null;
  last_started_at?: string | null;
  last_completed_at?: string | null;
  last_status: string;
  last_error?: string | null;
  records_processed: number;
} | null;

export type Fixture = {
  id: string;
  label: string;
  billingDocument: string;
  customerName: string;
  amount: number;
  currency: string;
};

export type Validation = {
  code: string;
  label: string;
  passed: boolean;
  blocking: boolean;
};

export type InvoicePreview = {
  fixtureId: string;
  fixtureLabel: string;
  source: 'fixture';
  actualRecipient: string;
  maskedRecipient: string;
  sendAllowed: boolean;
  invoice: {
    billingDocument: string;
    billingDocumentDate: string;
    customerName: string;
    customerNumber: string;
    fixtureContact: string;
    currency: string;
    totalGrossAmount: number;
    itemCount: number;
    pdfFileName: string;
  };
  template: {
    name: string;
    language: string;
    variables: Record<string, string>;
  };
  validations: Validation[];
};

export type MessageAttempt = {
  id: number;
  attempt_number: number;
  status: string;
  provider_request_id?: string | null;
  response_status?: number | null;
  request_payload?: Record<string, unknown> | null;
  response_payload?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  is_retryable?: boolean | null;
  started_at: string;
  finished_at?: string | null;
};

export type DeliveryMessage = {
  id: number;
  direction: string;
  channel: string;
  purpose: string;
  subject?: string | null;
  body?: string | null;
  provider_message_id?: string | null;
  provider_thread_id?: string | null;
  status: string;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  received_at?: string | null;
  failed_at?: string | null;
  failure_code?: string | null;
  failure_reason?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  message_attempts?: MessageAttempt[];
};

export type CustomerSummary = {
  id?: number;
  sap_business_partner_id?: string | null;
  sap_customer_number?: string | null;
  display_name?: string;
  legal_name?: string | null;
  language_code?: string | null;
  country_code?: string | null;
  default_currency?: string | null;
  is_active?: boolean;
  last_synced_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type InvoiceSummary = {
  id?: number;
  sap_billing_document?: string;
  billing_document_type?: string;
  billing_document_category?: string | null;
  billing_document_date?: string;
  creation_datetime?: string | null;
  sales_organization?: string | null;
  distribution_channel?: string | null;
  division?: string | null;
  transaction_currency?: string;
  total_net_amount?: number;
  total_tax_amount?: number;
  total_gross_amount?: number;
  accounting_posting_status?: string | null;
  overall_billing_status?: string | null;
  is_cancelled?: boolean;
  source_version?: number;
  eligibility_status?: string;
  eligibility_reason?: string | null;
  last_synced_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type DeliveryJob = {
  id: number;
  status: string;
  channel?: string;
  source_version?: number;
  attempt_count: number;
  max_attempts: number;
  approval_status?: string;
  scheduled_at: string;
  available_at?: string;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
  last_error?: string | null;
  idempotency_key?: string;
  metadata?: { masked_recipient?: string; source?: string; fixture_id?: string };
  customers?: CustomerSummary | CustomerSummary[];
  invoices?: InvoiceSummary | InvoiceSummary[];
  messages?: DeliveryMessage | DeliveryMessage[];
};

export type DeliveryJobDetail = Omit<DeliveryJob, 'messages'> & {
  messages?: DeliveryMessage[];
  agent_run?: {
    id: number;
    agent_type: string;
    trigger_type: string;
    status: string;
    started_at: string;
    finished_at?: string | null;
    records_examined: number;
    records_succeeded: number;
    records_failed: number;
    error_summary?: string | null;
    metadata?: Record<string, unknown>;
  } | null;
  customer_contacts?: {
    id: number;
    channel: string;
    label?: string | null;
    is_primary: boolean;
    is_verified: boolean;
    is_whatsapp_capable?: boolean | null;
    consent_status: string;
    do_not_contact: boolean;
    is_active: boolean;
    validation_error?: string | null;
    created_at: string;
    updated_at: string;
  };
  communication_templates?: {
    id: number;
    code: string;
    purpose: string;
    channel: string;
    locale: string;
    name: string;
    body_template: string;
    provider_template_id?: string | null;
    version: number;
    status: string;
    required_variables: string[];
    created_at: string;
    updated_at: string;
  };
  invoice_items?: Array<{
    id: number;
    sap_item_number: string;
    product_id?: string | null;
    description?: string | null;
    quantity?: number | null;
    quantity_unit?: string | null;
    net_amount?: number | null;
    tax_amount?: number | null;
    currency?: string | null;
  }>;
  invoice_documents?: Array<{
    id: number;
    document_type: string;
    source_version: number;
    storage_bucket: string;
    storage_path: string;
    file_name?: string | null;
    mime_type: string;
    size_bytes?: number | null;
    is_current: boolean;
    created_at: string;
    preview_url?: string | null;
    download_url?: string | null;
  }>;
};

export type SimulationResult = {
  jobId: number;
  duplicate: boolean;
  status: string;
  billingDocument: string;
  customerName: string;
  amount: number;
  currency: string;
  maskedRecipient: string;
  pdfFileName: string;
};

export type AppRoute =
  | { page: 'overview' }
  | { page: 'deliveries' }
  | { page: 'delivery'; jobId: number };

export function relationOne<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}
