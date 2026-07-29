-- Atomic database-backed queue claim for the invoice delivery worker.
-- The external MSG91 request happens after this short transaction completes.

create or replace function public.claim_next_communication_job(
  worker_name text,
  requested_job_type text default 'invoice_delivery'
)
returns setof public.communication_jobs
language sql
security definer
set search_path = ''
as $$
  update public.communication_jobs
  set
    status = 'processing',
    locked_at = now(),
    locked_by = worker_name,
    updated_at = now()
  where id = (
    select jobs.id
    from public.communication_jobs as jobs
    where jobs.job_type = requested_job_type
      and jobs.status in ('pending', 'queued')
      and jobs.available_at <= now()
    order by jobs.available_at, jobs.id
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.claim_next_communication_job(text, text) from public;
revoke all on function public.claim_next_communication_job(text, text) from anon;
revoke all on function public.claim_next_communication_job(text, text) from authenticated;
grant execute on function public.claim_next_communication_job(text, text) to service_role;

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
  'invoice_delivery_whatsapp_en',
  'invoice_delivery',
  'whatsapp',
  'en',
  'Invoice delivery - English',
  'Dear {{var_1}}, your invoice {{var_2}} dated {{var_3}} for INR {{var_4}} is attached. Thank you, {{var_5}}.',
  integrations.id,
  'share_invoice',
  1,
  'approved',
  '["header_1", "var_1", "var_2", "var_3", "var_4", "var_5"]'::jsonb
from public.provider_integrations as integrations
where integrations.provider = 'msg91'
  and integrations.channel = 'whatsapp'
on conflict (code, channel, locale, version) do update
set
  provider_integration_id = excluded.provider_integration_id,
  provider_template_id = excluded.provider_template_id,
  status = excluded.status,
  required_variables = excluded.required_variables,
  updated_at = now();
