-- SuryaDev AI Agents core platform schema.
-- Single-tenant application supporting:
--   1. SAP Invoice Delivery Agent
--   2. SAP Pending Payment Follow-up Agent
-- Production SAP integrations remain read-only. QAS test utilities are isolated
-- through the connection environment and application permissions.

-- -----------------------------------------------------------------------------
-- Shared functions
-- -----------------------------------------------------------------------------

create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Application configuration, users, and role-based access
-- -----------------------------------------------------------------------------

create table public.system_settings (
  id smallint primary key default 1 check (id = 1),
  application_name text not null default 'SuryaDev AI Agents',
  default_timezone text not null default 'Asia/Kolkata',
  default_locale text not null default 'en-IN',
  sap_poll_interval_seconds integer not null default 300
    check (sap_poll_interval_seconds between 60 and 86400),
  invoice_delivery_enabled boolean not null default true,
  payment_follow_up_enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.legal_entities (
  id bigint generated always as identity primary key,
  name text not null,
  sap_company_code text not null unique,
  default_currency text,
  default_sales_organization text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  phone_number text,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (code = lower(code))
);

create table public.permissions (
  id bigint generated always as identity primary key,
  code text not null unique,
  description text,
  created_at timestamptz not null default now(),
  check (code = lower(code))
);

create table public.user_roles (
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  role_id bigint not null references public.roles(id) on delete cascade,
  assigned_by uuid references public.user_profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table public.role_permissions (
  role_id bigint not null references public.roles(id) on delete cascade,
  permission_id bigint not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

-- -----------------------------------------------------------------------------
-- SAP and external provider integrations
-- -----------------------------------------------------------------------------

create table public.sap_connections (
  id bigint generated always as identity primary key,
  name text not null,
  environment text not null
    check (environment in ('qas', 'production')),
  base_url text not null,
  api_base_url text not null,
  communication_user_name text,
  secret_reference text,
  is_read_only boolean not null default true,
  is_active boolean not null default true,
  last_successful_connection_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (environment)
);

create table public.sap_sync_checkpoints (
  id bigint generated always as identity primary key,
  sap_connection_id bigint not null
    references public.sap_connections(id) on delete cascade,
  resource_type text not null,
  cursor_value text,
  watermark_at timestamptz,
  overlap_seconds integer not null default 300 check (overlap_seconds >= 0),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_status text not null default 'never_run'
    check (last_status in ('never_run', 'running', 'succeeded', 'failed')),
  last_error text,
  records_processed bigint not null default 0 check (records_processed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sap_connection_id, resource_type)
);

create table public.provider_integrations (
  id bigint generated always as identity primary key,
  name text not null,
  provider text not null,
  channel text not null check (channel in ('whatsapp', 'email')),
  secret_reference text,
  webhook_secret_reference text,
  is_active boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, channel)
);

-- -----------------------------------------------------------------------------
-- Customers and communication preferences
-- -----------------------------------------------------------------------------

create table public.customers (
  id bigint generated always as identity primary key,
  sap_business_partner_id text,
  sap_customer_number text,
  display_name text not null,
  legal_name text,
  language_code text,
  country_code text,
  default_currency text,
  is_active boolean not null default true,
  sap_last_changed_at timestamptz,
  last_synced_at timestamptz not null default now(),
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (sap_business_partner_id is not null or sap_customer_number is not null)
);

create unique index customers_business_partner_unique_idx
  on public.customers (sap_business_partner_id)
  where sap_business_partner_id is not null;

create unique index customers_customer_number_unique_idx
  on public.customers (sap_customer_number)
  where sap_customer_number is not null;

create table public.customer_contacts (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email', 'phone')),
  original_value text not null,
  normalized_value text,
  label text,
  sap_address_id text,
  sap_person_id text,
  is_primary boolean not null default false,
  is_verified boolean not null default false,
  is_whatsapp_capable boolean,
  consent_status text not null default 'unknown'
    check (consent_status in ('unknown', 'opted_in', 'opted_out', 'not_required')),
  do_not_contact boolean not null default false,
  is_active boolean not null default true,
  validation_error text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index customer_contacts_active_value_unique_idx
  on public.customer_contacts (customer_id, channel, normalized_value)
  where normalized_value is not null and is_active;

create unique index customer_contacts_primary_channel_unique_idx
  on public.customer_contacts (customer_id, channel)
  where is_primary and is_active;

create table public.customer_channel_preferences (
  customer_id bigint not null references public.customers(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email')),
  is_enabled boolean not null default true,
  priority smallint not null default 1 check (priority > 0),
  locale text,
  quiet_hours_start time,
  quiet_hours_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (customer_id, channel)
);

-- -----------------------------------------------------------------------------
-- Billing documents and invoice files
-- -----------------------------------------------------------------------------

create table public.invoices (
  id bigint generated always as identity primary key,
  legal_entity_id bigint references public.legal_entities(id) on delete set null,
  sap_billing_document text not null unique,
  billing_document_type text not null,
  billing_document_category text,
  billing_document_date date not null,
  creation_datetime timestamptz,
  sap_last_changed_at timestamptz,
  sold_to_customer_id bigint references public.customers(id) on delete set null,
  bill_to_customer_id bigint references public.customers(id) on delete set null,
  payer_customer_id bigint references public.customers(id) on delete set null,
  sales_organization text,
  distribution_channel text,
  division text,
  transaction_currency text not null,
  total_net_amount numeric(18, 2),
  total_tax_amount numeric(18, 2),
  total_gross_amount numeric(18, 2),
  accounting_posting_status text,
  overall_billing_status text,
  is_cancelled boolean not null default false,
  cancelled_at timestamptz,
  source_version integer not null default 1 check (source_version > 0),
  eligibility_status text not null default 'pending'
    check (eligibility_status in (
      'pending', 'eligible', 'ineligible', 'awaiting_pdf', 'awaiting_contact',
      'cancelled'
    )),
  eligibility_reason text,
  last_synced_at timestamptz not null default now(),
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invoice_items (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices(id) on delete cascade,
  sap_item_number text not null,
  product_id text,
  description text,
  quantity numeric(18, 3),
  quantity_unit text,
  net_amount numeric(18, 2),
  tax_amount numeric(18, 2),
  currency text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, sap_item_number)
);

create table public.invoice_documents (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices(id) on delete cascade,
  document_type text not null
    check (document_type in ('invoice_pdf', 'account_statement', 'payment_proof', 'other')),
  source_version integer not null default 1 check (source_version > 0),
  storage_bucket text not null default 'invoice-documents',
  storage_path text not null,
  file_name text,
  mime_type text not null default 'application/pdf',
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  checksum_sha256 text,
  is_current boolean not null default true,
  retained_until timestamptz,
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create unique index invoice_documents_current_type_unique_idx
  on public.invoice_documents (invoice_id, document_type)
  where is_current;

-- -----------------------------------------------------------------------------
-- Open receivables and payment follow-up policies
-- -----------------------------------------------------------------------------

create table public.invoice_receivables (
  invoice_id bigint primary key references public.invoices(id) on delete cascade,
  original_amount numeric(18, 2) not null,
  outstanding_amount numeric(18, 2) not null,
  paid_amount numeric(18, 2) not null default 0,
  currency text not null,
  due_date date,
  payment_status text not null
    check (payment_status in (
      'open', 'partially_paid', 'paid', 'disputed', 'written_off', 'cancelled'
    )),
  aging_bucket text not null default 'upcoming'
    check (aging_bucket in ('upcoming', 'due', 'overdue', 'critical', 'closed')),
  days_overdue integer not null default 0,
  payment_detected_at timestamptz,
  last_synced_at timestamptz not null default now(),
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.receivable_snapshots (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices(id) on delete cascade,
  observed_at timestamptz not null default now(),
  original_amount numeric(18, 2) not null,
  outstanding_amount numeric(18, 2) not null,
  paid_amount numeric(18, 2) not null,
  currency text not null,
  due_date date,
  payment_status text not null,
  aging_bucket text not null,
  days_overdue integer not null,
  raw_data jsonb not null default '{}'::jsonb
);

create table public.communication_templates (
  id bigint generated always as identity primary key,
  code text not null,
  purpose text not null
    check (purpose in (
      'invoice_delivery', 'payment_reminder', 'payment_escalation',
      'delivery_failure', 'general'
    )),
  channel text not null check (channel in ('whatsapp', 'email')),
  locale text not null default 'en-IN',
  name text not null,
  subject_template text,
  body_template text not null,
  provider_integration_id bigint
    references public.provider_integrations(id) on delete set null,
  provider_template_id text,
  version integer not null default 1 check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'inactive')),
  required_variables jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (code, channel, locale, version)
);

create table public.reminder_policies (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  legal_entity_id bigint references public.legal_entities(id) on delete set null,
  consolidation_mode text not null default 'per_invoice'
    check (consolidation_mode in ('per_invoice', 'per_customer')),
  is_active boolean not null default true,
  criteria jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reminder_policy_stages (
  id bigint generated always as identity primary key,
  reminder_policy_id bigint not null
    references public.reminder_policies(id) on delete cascade,
  code text not null,
  name text not null,
  timing_basis text not null
    check (timing_basis in ('before_due', 'on_due', 'after_due')),
  offset_days integer not null default 0,
  severity text not null
    check (severity in ('upcoming', 'due', 'overdue', 'critical')),
  requires_approval boolean not null default false,
  attach_invoice boolean not null default true,
  attach_account_statement boolean not null default false,
  max_delivery_attempts smallint not null default 3
    check (max_delivery_attempts between 1 and 10),
  sort_order smallint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reminder_policy_id, code),
  unique (reminder_policy_id, sort_order)
);

create table public.reminder_stage_templates (
  reminder_stage_id bigint not null
    references public.reminder_policy_stages(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email')),
  template_id bigint not null
    references public.communication_templates(id) on delete restrict,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (reminder_stage_id, channel)
);

create table public.payment_follow_up_cases (
  id bigint generated always as identity primary key,
  invoice_id bigint not null unique references public.invoices(id) on delete cascade,
  reminder_policy_id bigint
    references public.reminder_policies(id) on delete set null,
  current_stage_id bigint
    references public.reminder_policy_stages(id) on delete set null,
  status text not null default 'active'
    check (status in (
      'active', 'paused', 'promise_to_pay', 'disputed', 'resolved', 'closed'
    )),
  next_action_at timestamptz,
  paused_until timestamptz,
  promise_to_pay_date date,
  dispute_reason text,
  assigned_user_id uuid references public.user_profiles(id) on delete set null,
  last_reminder_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Agent execution, communication jobs, and provider delivery history
-- -----------------------------------------------------------------------------

create table public.agent_runs (
  id bigint generated always as identity primary key,
  agent_type text not null
    check (agent_type in (
      'sap_sync', 'invoice_delivery', 'payment_follow_up', 'qas_invoice_creator'
    )),
  trigger_type text not null
    check (trigger_type in ('scheduled', 'manual', 'webhook', 'retry')),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled')),
  started_by uuid references public.user_profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_examined bigint not null default 0 check (records_examined >= 0),
  records_succeeded bigint not null default 0 check (records_succeeded >= 0),
  records_failed bigint not null default 0 check (records_failed >= 0),
  error_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.communication_jobs (
  id bigint generated always as identity primary key,
  agent_run_id bigint references public.agent_runs(id) on delete set null,
  job_type text not null
    check (job_type in (
      'invoice_delivery', 'payment_reminder', 'payment_escalation',
      'manual_resend', 'delivery_failure_notification'
    )),
  customer_id bigint not null references public.customers(id) on delete restrict,
  primary_invoice_id bigint references public.invoices(id) on delete restrict,
  payment_follow_up_case_id bigint
    references public.payment_follow_up_cases(id) on delete set null,
  receivable_snapshot_id bigint
    references public.receivable_snapshots(id) on delete set null,
  reminder_stage_id bigint
    references public.reminder_policy_stages(id) on delete set null,
  contact_id bigint references public.customer_contacts(id) on delete set null,
  template_id bigint references public.communication_templates(id) on delete set null,
  channel text not null check (channel in ('whatsapp', 'email')),
  source_version integer check (source_version is null or source_version > 0),
  status text not null default 'pending'
    check (status in (
      'pending', 'awaiting_approval', 'queued', 'processing', 'completed',
      'failed', 'cancelled', 'skipped'
    )),
  approval_status text not null default 'not_required'
    check (approval_status in ('not_required', 'pending', 'approved', 'rejected')),
  approval_decided_by uuid references public.user_profiles(id) on delete set null,
  approval_decided_at timestamptz,
  scheduled_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  idempotency_key text not null unique,
  last_error text,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.communication_job_invoices (
  communication_job_id bigint not null
    references public.communication_jobs(id) on delete cascade,
  invoice_id bigint not null references public.invoices(id) on delete restrict,
  receivable_snapshot_id bigint
    references public.receivable_snapshots(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (communication_job_id, invoice_id)
);

create table public.messages (
  id bigint generated always as identity primary key,
  communication_job_id bigint unique
    references public.communication_jobs(id) on delete set null,
  customer_id bigint not null references public.customers(id) on delete restrict,
  contact_id bigint references public.customer_contacts(id) on delete set null,
  template_id bigint references public.communication_templates(id) on delete set null,
  provider_integration_id bigint
    references public.provider_integrations(id) on delete set null,
  direction text not null check (direction in ('outbound', 'inbound')),
  channel text not null check (channel in ('whatsapp', 'email')),
  purpose text not null,
  subject text,
  body text,
  provider_message_id text,
  provider_thread_id text,
  reply_to_message_id bigint references public.messages(id) on delete set null,
  status text not null default 'created'
    check (status in (
      'created', 'queued', 'accepted', 'sent', 'delivered', 'read',
      'failed', 'received', 'cancelled'
    )),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  received_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index messages_provider_message_unique_idx
  on public.messages (provider_integration_id, provider_message_id)
  where provider_message_id is not null;

create table public.message_attempts (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  provider_integration_id bigint
    references public.provider_integrations(id) on delete set null,
  attempt_number smallint not null check (attempt_number > 0),
  status text not null
    check (status in ('started', 'accepted', 'succeeded', 'failed', 'timed_out')),
  provider_request_id text,
  request_payload jsonb,
  response_status integer,
  response_payload jsonb,
  error_code text,
  error_message text,
  is_retryable boolean,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (message_id, attempt_number)
);

create table public.provider_webhook_events (
  id bigint generated always as identity primary key,
  provider_integration_id bigint
    references public.provider_integrations(id) on delete set null,
  provider text not null,
  external_event_id text,
  provider_message_id text,
  event_type text not null,
  payload jsonb not null,
  signature_verified boolean not null default false,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text
);

create unique index provider_webhook_external_event_unique_idx
  on public.provider_webhook_events (provider, external_event_id)
  where external_event_id is not null;

create table public.customer_response_details (
  id bigint generated always as identity primary key,
  inbound_message_id bigint not null unique
    references public.messages(id) on delete cascade,
  classification text not null
    check (classification in (
      'promise_to_pay', 'already_paid', 'payment_proof', 'invoice_dispute',
      'incorrect_invoice', 'statement_requested', 'callback_requested',
      'opt_out', 'other'
    )),
  promise_to_pay_date date,
  notes text,
  requires_human_review boolean not null default true,
  classified_by text not null default 'agent'
    check (classified_by in ('agent', 'user')),
  reviewed_by uuid references public.user_profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.review_tasks (
  id bigint generated always as identity primary key,
  task_type text not null
    check (task_type in (
      'missing_contact', 'invalid_contact', 'delivery_failure',
      'payment_reminder_approval', 'payment_escalation', 'customer_response',
      'invoice_dispute', 'other'
    )),
  title text not null,
  description text,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'critical')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  customer_id bigint references public.customers(id) on delete set null,
  invoice_id bigint references public.invoices(id) on delete set null,
  communication_job_id bigint
    references public.communication_jobs(id) on delete set null,
  message_id bigint references public.messages(id) on delete set null,
  payment_follow_up_case_id bigint
    references public.payment_follow_up_cases(id) on delete set null,
  assigned_user_id uuid references public.user_profiles(id) on delete set null,
  resolution_notes text,
  due_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.escalations (
  id bigint generated always as identity primary key,
  review_task_id bigint references public.review_tasks(id) on delete set null,
  payment_follow_up_case_id bigint
    references public.payment_follow_up_cases(id) on delete set null,
  escalation_level smallint not null default 1 check (escalation_level > 0),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'cancelled')),
  reason text not null,
  assigned_user_id uuid references public.user_profiles(id) on delete set null,
  escalated_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.user_profiles(id) on delete set null,
  actor_type text not null default 'system'
    check (actor_type in ('system', 'user', 'agent', 'webhook')),
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Indexes for foreign keys and the primary worker/dashboard access patterns
-- -----------------------------------------------------------------------------

create index user_roles_role_id_idx on public.user_roles (role_id);
create index user_roles_assigned_by_idx on public.user_roles (assigned_by);
create index role_permissions_permission_id_idx
  on public.role_permissions (permission_id);
create index sap_sync_checkpoints_connection_idx
  on public.sap_sync_checkpoints (sap_connection_id);
create index customer_contacts_customer_idx
  on public.customer_contacts (customer_id);
create index invoices_legal_entity_idx on public.invoices (legal_entity_id);
create index invoices_sold_to_customer_idx on public.invoices (sold_to_customer_id);
create index invoices_bill_to_customer_idx on public.invoices (bill_to_customer_id);
create index invoices_payer_customer_idx on public.invoices (payer_customer_id);
create index invoices_eligibility_created_idx
  on public.invoices (eligibility_status, creation_datetime desc);
create index invoice_items_invoice_idx on public.invoice_items (invoice_id);
create index invoice_documents_invoice_idx on public.invoice_documents (invoice_id);
create index receivable_snapshots_invoice_observed_idx
  on public.receivable_snapshots (invoice_id, observed_at desc);
create index invoice_receivables_status_due_idx
  on public.invoice_receivables (payment_status, due_date);
create index communication_templates_provider_idx
  on public.communication_templates (provider_integration_id);
create index reminder_policies_legal_entity_idx
  on public.reminder_policies (legal_entity_id);
create index reminder_policy_stages_policy_idx
  on public.reminder_policy_stages (reminder_policy_id);
create index reminder_stage_templates_template_idx
  on public.reminder_stage_templates (template_id);
create index payment_cases_policy_idx
  on public.payment_follow_up_cases (reminder_policy_id);
create index payment_cases_stage_idx
  on public.payment_follow_up_cases (current_stage_id);
create index payment_cases_assigned_user_idx
  on public.payment_follow_up_cases (assigned_user_id);
create index payment_cases_next_action_idx
  on public.payment_follow_up_cases (next_action_at)
  where status in ('active', 'promise_to_pay');
create index agent_runs_type_started_idx
  on public.agent_runs (agent_type, started_at desc);
create index agent_runs_started_by_idx on public.agent_runs (started_by);
create index communication_jobs_agent_run_idx
  on public.communication_jobs (agent_run_id);
create index communication_jobs_customer_idx
  on public.communication_jobs (customer_id);
create index communication_jobs_primary_invoice_idx
  on public.communication_jobs (primary_invoice_id);
create index communication_jobs_case_idx
  on public.communication_jobs (payment_follow_up_case_id);
create index communication_jobs_snapshot_idx
  on public.communication_jobs (receivable_snapshot_id);
create index communication_jobs_stage_idx
  on public.communication_jobs (reminder_stage_id);
create index communication_jobs_contact_idx
  on public.communication_jobs (contact_id);
create index communication_jobs_template_idx
  on public.communication_jobs (template_id);
create index communication_jobs_approval_user_idx
  on public.communication_jobs (approval_decided_by);
create index communication_jobs_worker_queue_idx
  on public.communication_jobs (status, available_at)
  where status in ('pending', 'queued');
create index communication_job_invoices_invoice_idx
  on public.communication_job_invoices (invoice_id);
create index communication_job_invoices_snapshot_idx
  on public.communication_job_invoices (receivable_snapshot_id);
create index messages_customer_created_idx
  on public.messages (customer_id, created_at desc);
create index messages_contact_idx on public.messages (contact_id);
create index messages_template_idx on public.messages (template_id);
create index messages_provider_idx on public.messages (provider_integration_id);
create index messages_reply_to_idx on public.messages (reply_to_message_id);
create index messages_status_created_idx on public.messages (status, created_at desc);
create index message_attempts_message_idx on public.message_attempts (message_id);
create index message_attempts_provider_idx
  on public.message_attempts (provider_integration_id);
create index provider_webhook_integration_idx
  on public.provider_webhook_events (provider_integration_id);
create index provider_webhook_message_idx
  on public.provider_webhook_events (provider_message_id);
create index provider_webhook_unprocessed_idx
  on public.provider_webhook_events (received_at)
  where processed_at is null;
create index customer_response_reviewer_idx
  on public.customer_response_details (reviewed_by);
create index review_tasks_customer_idx on public.review_tasks (customer_id);
create index review_tasks_invoice_idx on public.review_tasks (invoice_id);
create index review_tasks_job_idx on public.review_tasks (communication_job_id);
create index review_tasks_message_idx on public.review_tasks (message_id);
create index review_tasks_case_idx on public.review_tasks (payment_follow_up_case_id);
create index review_tasks_assigned_status_idx
  on public.review_tasks (assigned_user_id, status, created_at desc);
create index escalations_review_task_idx on public.escalations (review_task_id);
create index escalations_case_idx on public.escalations (payment_follow_up_case_id);
create index escalations_assigned_status_idx
  on public.escalations (assigned_user_id, status, escalated_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_user_id);
create index audit_logs_entity_idx
  on public.audit_logs (entity_type, entity_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Updated-at triggers
-- -----------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'system_settings', 'legal_entities', 'user_profiles', 'roles',
    'sap_connections', 'sap_sync_checkpoints', 'provider_integrations',
    'customers', 'customer_contacts', 'customer_channel_preferences',
    'invoices', 'invoice_items', 'invoice_receivables',
    'communication_templates', 'reminder_policies', 'reminder_policy_stages',
    'payment_follow_up_cases', 'communication_jobs', 'messages',
    'customer_response_details', 'review_tasks', 'escalations'
  ]
  loop
    execute format(
      'create trigger set_updated_at before update on public.%I '
      'for each row execute function app_private.set_updated_at()',
      table_name
    );
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Seed the single current role and a future-ready permission catalogue
-- -----------------------------------------------------------------------------

insert into public.system_settings (id) values (1)
on conflict (id) do nothing;

insert into public.roles (code, name, description, is_system)
values ('admin', 'Administrator', 'Full application access', true)
on conflict (code) do nothing;

insert into public.permissions (code, description)
values
  ('dashboard.view', 'View dashboard and operational summaries'),
  ('users.manage', 'Manage users, roles, and permissions'),
  ('settings.manage', 'Manage application settings'),
  ('integrations.manage', 'Manage SAP, MSG91, and email integrations'),
  ('customers.view', 'View customers and customer contacts'),
  ('customers.manage', 'Manage normalized customer contacts and preferences'),
  ('invoices.view', 'View invoices and invoice documents'),
  ('invoice_delivery.manage', 'Manage invoice delivery jobs'),
  ('payments.view', 'View receivables and payment follow-up cases'),
  ('payment_reminders.manage', 'Manage reminder policies and jobs'),
  ('reminders.approve', 'Approve sensitive payment reminders'),
  ('messages.view', 'View communication history'),
  ('messages.resend', 'Retry or manually resend messages'),
  ('templates.manage', 'Manage WhatsApp and email templates'),
  ('reviews.manage', 'Manage human review tasks'),
  ('escalations.manage', 'Manage collection and delivery escalations'),
  ('agent_runs.view', 'View agent and synchronization runs'),
  ('agent_runs.manage', 'Start and manage agent runs'),
  ('audit.view', 'View immutable audit history')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select roles.id, permissions.id
from public.roles
cross join public.permissions
where roles.code = 'admin'
on conflict (role_id, permission_id) do nothing;

insert into public.provider_integrations (
  name,
  provider,
  channel,
  is_active,
  settings
)
values (
  'MSG91 WhatsApp',
  'msg91',
  'whatsapp',
  false,
  '{}'::jsonb
)
on conflict (provider, channel) do nothing;

-- -----------------------------------------------------------------------------
-- Supabase Auth profile synchronization
-- -----------------------------------------------------------------------------

create or replace function app_private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger create_user_profile
after insert on auth.users
for each row execute function app_private.handle_new_auth_user();

insert into public.user_profiles (id, email, display_name)
select
  users.id,
  users.email,
  coalesce(users.raw_user_meta_data ->> 'full_name', split_part(users.email, '@', 1))
from auth.users as users
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Admin-first RLS. Future roles can receive narrower policies without changing
-- the underlying tables or role/permission model.
-- -----------------------------------------------------------------------------

create or replace function app_private.current_user_has_role(requested_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_profiles
    join public.user_roles on user_roles.user_id = user_profiles.id
    join public.roles on roles.id = user_roles.role_id
    where user_profiles.id = (select auth.uid())
      and user_profiles.is_active
      and roles.code = requested_role
  );
$$;

revoke all on function app_private.current_user_has_role(text) from public;
revoke all on function app_private.current_user_has_role(text) from anon;
grant usage on schema app_private to authenticated;
grant execute on function app_private.current_user_has_role(text) to authenticated;
grant execute on function app_private.current_user_has_role(text) to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'system_settings', 'legal_entities', 'user_profiles', 'roles', 'permissions',
    'user_roles', 'role_permissions', 'sap_connections', 'sap_sync_checkpoints',
    'provider_integrations', 'customers', 'customer_contacts',
    'customer_channel_preferences', 'invoices', 'invoice_items',
    'invoice_documents', 'invoice_receivables', 'communication_templates',
    'reminder_policies', 'reminder_policy_stages', 'reminder_stage_templates',
    'payment_follow_up_cases', 'agent_runs', 'communication_jobs',
    'communication_job_invoices', 'messages', 'customer_response_details',
    'review_tasks', 'escalations'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon', table_name);
    execute format(
      'grant select, insert, update, delete on table public.%I to authenticated',
      table_name
    );
    execute format(
      'create policy admin_all_access on public.%I for all to authenticated '
      'using ((select app_private.current_user_has_role(''admin''))) '
      'with check ((select app_private.current_user_has_role(''admin'')))',
      table_name
    );
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'receivable_snapshots', 'message_attempts', 'provider_webhook_events',
    'audit_logs'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon', table_name);
    execute format('revoke all on table public.%I from authenticated', table_name);
    execute format('grant select on table public.%I to authenticated', table_name);
    execute format(
      'create policy admin_read_access on public.%I for select to authenticated '
      'using ((select app_private.current_user_has_role(''admin'')))',
      table_name
    );
  end loop;
end;
$$;

revoke all on all sequences in schema public from anon;
grant usage, select on all sequences in schema public to authenticated;

-- -----------------------------------------------------------------------------
-- Private Supabase Storage bucket for invoice PDFs and account statements
-- -----------------------------------------------------------------------------

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'invoice-documents',
  'invoice-documents',
  false,
  26214400,
  array['application/pdf']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy invoice_documents_admin_select
on storage.objects for select to authenticated
using (
  bucket_id = 'invoice-documents'
  and (select app_private.current_user_has_role('admin'))
);

create policy invoice_documents_admin_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'invoice-documents'
  and (select app_private.current_user_has_role('admin'))
);

create policy invoice_documents_admin_update
on storage.objects for update to authenticated
using (
  bucket_id = 'invoice-documents'
  and (select app_private.current_user_has_role('admin'))
)
with check (
  bucket_id = 'invoice-documents'
  and (select app_private.current_user_has_role('admin'))
);

create policy invoice_documents_admin_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'invoice-documents'
  and (select app_private.current_user_has_role('admin'))
);

comment on table public.invoices is
  'Normalized SAP billing documents used by both delivery and payment agents.';
comment on table public.invoice_receivables is
  'Latest known SAP receivable state for each invoice.';
comment on table public.receivable_snapshots is
  'Immutable history explaining every payment reminder decision.';
comment on table public.communication_jobs is
  'Idempotent queue shared by invoice delivery and payment follow-up agents.';
comment on table public.messages is
  'Normalized inbound and outbound communication history.';
comment on table public.provider_webhook_events is
  'Immutable raw MSG91 or email provider webhook events.';
comment on table public.audit_logs is
  'Immutable audit history written by the backend service role.';
