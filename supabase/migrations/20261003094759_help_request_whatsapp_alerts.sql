create table public.help_request_notifications (
  id bigint generated always as identity primary key,
  review_task_id bigint not null unique
    references public.review_tasks(id) on delete cascade,
  recipient text not null check (recipient ~ '^[1-9][0-9]{7,14}$'),
  template_name text not null,
  template_language text not null default 'en',
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed')),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  provider_request_id text,
  provider_message_id text,
  sent_at timestamptz,
  last_error text,
  details jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index help_request_notifications_queue_idx
  on public.help_request_notifications (status, next_attempt_at, id)
  where status = 'pending';

create trigger set_updated_at
before update on public.help_request_notifications
for each row execute function app_private.set_updated_at();

alter table public.help_request_notifications enable row level security;
revoke all on table public.help_request_notifications from anon, authenticated;
revoke all on sequence public.help_request_notifications_id_seq from anon, authenticated;
grant select, insert, update, delete on table public.help_request_notifications to service_role;
grant usage, select on sequence public.help_request_notifications_id_seq to service_role;

create or replace function public.claim_next_help_request_notification(worker_name text)
returns setof public.help_request_notifications
language sql
security invoker
set search_path = ''
as $$
  update public.help_request_notifications
  set
    status = 'processing',
    attempt_count = attempt_count + 1,
    locked_at = now(),
    locked_by = worker_name,
    updated_at = now()
  where id = (
    select notification.id
    from public.help_request_notifications as notification
    where notification.status = 'pending'
      and notification.next_attempt_at <= now()
    order by notification.next_attempt_at, notification.id
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.claim_next_help_request_notification(text) from public;
revoke all on function public.claim_next_help_request_notification(text) from anon;
revoke all on function public.claim_next_help_request_notification(text) from authenticated;
grant execute on function public.claim_next_help_request_notification(text) to service_role;
