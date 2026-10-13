-- Independent internal copies: never insert them into customer messages/jobs.
create table public.marketing_whatsapp_copies (
  id bigint generated always as identity primary key,
  source_job_id bigint not null references public.communication_jobs(id) on delete cascade,
  recipient text not null check (recipient ~ '^[1-9][0-9]{7,14}$'),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'accepted', 'failed', 'unknown')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  provider_request_id text,
  provider_message_id text,
  accepted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (source_job_id, recipient)
);
create index marketing_whatsapp_copies_queue_idx
  on public.marketing_whatsapp_copies(next_attempt_at, id) where status = 'pending';
create index marketing_whatsapp_copies_message_idx
  on public.marketing_whatsapp_copies(provider_message_id) where provider_message_id is not null;
alter table public.marketing_whatsapp_copies enable row level security;
revoke all on public.marketing_whatsapp_copies from public, anon, authenticated;
revoke all on sequence public.marketing_whatsapp_copies_id_seq from public, anon, authenticated;
grant select, insert, update on public.marketing_whatsapp_copies to service_role;
grant usage, select on sequence public.marketing_whatsapp_copies_id_seq to service_role;

create function public.claim_next_marketing_whatsapp_copy(worker_name text)
returns setof public.marketing_whatsapp_copies
language sql security invoker set search_path = ''
as $$
  update public.marketing_whatsapp_copies
  set status = 'processing', attempt_count = attempt_count + 1,
      locked_at = now(), locked_by = worker_name
  where id = (
    select copy.id from public.marketing_whatsapp_copies as copy
    where copy.status = 'pending' and copy.next_attempt_at <= now()
      and exists (
        select 1 from public.messages as message
        where message.communication_job_id = copy.source_job_id
          and message.direction = 'outbound'
          and message.status in ('accepted', 'sent', 'delivered', 'read')
      )
    order by copy.next_attempt_at, copy.id
    limit 1 for update of copy skip locked
  ) returning *;
$$;
revoke all on function public.claim_next_marketing_whatsapp_copy(text) from public, anon, authenticated;
grant execute on function public.claim_next_marketing_whatsapp_copy(text) to service_role;
