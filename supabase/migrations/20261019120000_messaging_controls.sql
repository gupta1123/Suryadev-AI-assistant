-- Per-customer messaging controls managed from Settings.
--
-- Additive only: this migration creates two new tables and changes nothing that
-- already exists. Rolling back is `drop table` on the two tables below.
--
-- These tables can only NARROW what the server environment already permits. The
-- application requires BOTH the env ceiling (SAP_ALLOWED_CUSTOMERS,
-- WHATSAPP_TEST_RECIPIENTS, MARKETING_MANAGER_ALLOWED_RECIPIENTS, ...) AND the
-- row here to approve a recipient. Empty tables therefore mean nothing is sent.

create table public.customer_messaging_settings (
  sap_customer_number text primary key check (sap_customer_number ~ '^[A-Za-z0-9]{1,20}$'),
  enabled boolean not null default false,
  -- The SAP phone an administrator approved when enabling the customer. Sending
  -- is refused if SAP later reports a different number.
  approved_phone text check (approved_phone is null or approved_phone ~ '^[1-9][0-9]{7,14}$'),
  -- Only documents created at or after this moment may be sent to the customer.
  enabled_at timestamptz,
  manager_name text check (manager_name is null or char_length(manager_name) <= 120),
  manager_phone text check (manager_phone is null or manager_phone ~ '^[1-9][0-9]{7,14}$'),
  -- 'manual' until the client grants access to the SAP marketing-manager object.
  manager_source text not null default 'manual' check (manager_source in ('manual', 'sap')),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not enabled or (approved_phone is not null and enabled_at is not null))
);

create table public.internal_test_recipients (
  phone text primary key check (phone ~ '^[1-9][0-9]{7,14}$'),
  label text check (label is null or char_length(label) <= 120),
  allow_simulator boolean not null default false,
  allow_payment_reminders boolean not null default false,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_messaging_settings enable row level security;
alter table public.internal_test_recipients enable row level security;

revoke all on public.customer_messaging_settings from public, anon, authenticated;
revoke all on public.internal_test_recipients from public, anon, authenticated;

grant select, insert, update on public.customer_messaging_settings to service_role;
grant select, insert, update on public.internal_test_recipients to service_role;

create trigger set_updated_at before update on public.customer_messaging_settings
  for each row execute function app_private.set_updated_at();
create trigger set_updated_at before update on public.internal_test_recipients
  for each row execute function app_private.set_updated_at();
