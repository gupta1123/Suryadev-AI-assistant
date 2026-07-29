-- Safe live-SAP polling and asynchronous MSG91 delivery reconciliation.
-- SAP remains read-only; this migration only coordinates local application work.

create index if not exists message_attempts_provider_request_idx
  on public.message_attempts (provider_request_id)
  where provider_request_id is not null;

create or replace function public.claim_sap_sync_checkpoint(
  connection_id bigint,
  requested_resource_type text,
  minimum_watermark timestamptz,
  worker_name text,
  stale_after_seconds integer default 300
)
returns setof public.sap_sync_checkpoints
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.sap_sync_checkpoints (
    sap_connection_id,
    resource_type,
    cursor_value,
    watermark_at
  )
  values (
    connection_id,
    requested_resource_type,
    worker_name,
    minimum_watermark
  )
  on conflict (sap_connection_id, resource_type) do nothing;

  return query
  update public.sap_sync_checkpoints as checkpoints
  set
    cursor_value = worker_name,
    watermark_at = greatest(checkpoints.watermark_at, minimum_watermark),
    last_started_at = now(),
    last_status = 'running',
    last_error = null,
    updated_at = now()
  where checkpoints.id = (
    select candidate.id
    from public.sap_sync_checkpoints as candidate
    where candidate.sap_connection_id = connection_id
      and candidate.resource_type = requested_resource_type
      and (
        candidate.last_status <> 'running'
        or candidate.last_started_at < now() - make_interval(secs => stale_after_seconds)
      )
    for update skip locked
  )
  returning checkpoints.*;
end;
$$;

revoke all on function public.claim_sap_sync_checkpoint(
  bigint,
  text,
  timestamptz,
  text,
  integer
) from public;
revoke all on function public.claim_sap_sync_checkpoint(
  bigint,
  text,
  timestamptz,
  text,
  integer
) from anon;
revoke all on function public.claim_sap_sync_checkpoint(
  bigint,
  text,
  timestamptz,
  text,
  integer
) from authenticated;
grant execute on function public.claim_sap_sync_checkpoint(
  bigint,
  text,
  timestamptz,
  text,
  integer
) to service_role;
