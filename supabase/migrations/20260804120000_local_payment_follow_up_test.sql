-- Local-only payment follow-up test configuration.
--
-- This migration does not enable sending and does not contain a recipient number.
-- The backend still requires explicit local environment switches and enforces its
-- single-recipient safety boundary before a job can be created or processed.

insert into public.communication_templates (
  code,
  purpose,
  channel,
  locale,
  name,
  body_template,
  provider_integration_id,
  provider_template_id,
  version,
  status,
  required_variables
)
select
  'payment_due_whatsapp_en',
  'payment_reminder',
  'whatsapp',
  'en',
  'Payment due reminder - English',
  'Hello {{1}}, payment of INR {{2}} is pending against invoice {{3}} dated {{4}}. Regards, Team {{5}}.',
  integrations.id,
  'payment_reminder_v1',
  1,
  'approved',
  '["body_1", "body_2", "body_3", "body_4", "body_5"]'::jsonb
from public.provider_integrations as integrations
where integrations.provider = 'msg91'
  and integrations.channel = 'whatsapp'
on conflict (code, channel, locale, version) do update
set
  purpose = excluded.purpose,
  name = excluded.name,
  body_template = excluded.body_template,
  provider_integration_id = excluded.provider_integration_id,
  provider_template_id = excluded.provider_template_id,
  status = excluded.status,
  required_variables = excluded.required_variables,
  updated_at = now();

insert into public.reminder_policies (
  name,
  description,
  consolidation_mode,
  is_active,
  criteria
)
select
  'Local controlled payment follow-up test',
  'One-invoice, one-recipient policy used only during local validation.',
  'per_invoice',
  true,
  '{"environment":"local_test","receivable_source":"test_fixture"}'::jsonb
where not exists (
  select 1
  from public.reminder_policies
  where name = 'Local controlled payment follow-up test'
);

insert into public.reminder_policy_stages (
  reminder_policy_id,
  code,
  name,
  timing_basis,
  offset_days,
  severity,
  requires_approval,
  attach_invoice,
  attach_account_statement,
  max_delivery_attempts,
  sort_order,
  is_active
)
select
  policies.id,
  'due_today',
  'Due today',
  'on_due',
  0,
  'due',
  false,
  false,
  false,
  3,
  1,
  true
from public.reminder_policies as policies
where policies.name = 'Local controlled payment follow-up test'
on conflict (reminder_policy_id, code) do update
set
  name = excluded.name,
  timing_basis = excluded.timing_basis,
  offset_days = excluded.offset_days,
  severity = excluded.severity,
  requires_approval = excluded.requires_approval,
  attach_invoice = excluded.attach_invoice,
  attach_account_statement = excluded.attach_account_statement,
  max_delivery_attempts = excluded.max_delivery_attempts,
  is_active = excluded.is_active,
  updated_at = now();

insert into public.reminder_stage_templates (
  reminder_stage_id,
  channel,
  template_id,
  is_enabled
)
select
  stages.id,
  'whatsapp',
  templates.id,
  true
from public.reminder_policy_stages as stages
join public.reminder_policies as policies
  on policies.id = stages.reminder_policy_id
join public.communication_templates as templates
  on templates.code = 'payment_due_whatsapp_en'
 and templates.channel = 'whatsapp'
 and templates.locale = 'en'
 and templates.version = 1
where policies.name = 'Local controlled payment follow-up test'
  and stages.code = 'due_today'
on conflict (reminder_stage_id, channel) do update
set
  template_id = excluded.template_id,
  is_enabled = excluded.is_enabled;
