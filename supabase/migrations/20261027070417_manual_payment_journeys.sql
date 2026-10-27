-- Atomic opt-in only. No journeys, messages, or settings are created by this migration.
-- Called exclusively by the authenticated backend using its service-role client.
create or replace function public.start_manual_payment_journey(
  p_invoice_id bigint, p_recipient text, p_outstanding numeric,
  p_rules jsonb, p_default_materials text[], p_username text
) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare
  inv public.invoices%rowtype;
  approval public.customer_messaging_settings%rowtype;
  settings jsonb;
  due_day date;
  days integer;
  first_delay integer;
  repeat_delay integer;
  cap integer;
  case_id bigint;
  cycle text;
  raw jsonb;
begin
  select s.settings into strict settings from public.system_settings s where s.id = 1 for share;
  if (settings #>> '{payment_reminders,updatedAt}') is distinct from (p_rules ->> 'updatedAt') then
    raise exception 'Reminder settings changed. Refresh before starting.';
  end if;
  days := (p_rules ->> 'dueDays')::integer;
  first_delay := (p_rules ->> 'firstReminderDelaySeconds')::integer;
  repeat_delay := (p_rules ->> 'repeatReminderDelaySeconds')::integer;
  cap := (p_rules ->> 'maximumReminders')::integer;
  if days is null or days not between 1 and 90 or first_delay is null or first_delay not between 10 and 2592000
    or repeat_delay is null or repeat_delay not between 10 and 2592000 or cap is null or cap not between 1 and 10 then
    raise exception 'Invalid journey settings';
  end if;
  if coalesce((settings #>> '{payment_reminders,dueDays}')::integer,3) <> days
    or coalesce((settings #>> '{payment_reminders,firstReminderDelaySeconds}')::integer,first_delay) <> first_delay
    or coalesce((settings #>> '{payment_reminders,repeatReminderDelaySeconds}')::integer,repeat_delay) <> repeat_delay
    or coalesce((settings #>> '{payment_reminders,maximumReminders}')::integer,cap) <> cap then
    raise exception 'Reminder settings changed. Refresh before starting.';
  end if;
  select * into strict inv from public.invoices where id = p_invoice_id for update;
  select cms.* into strict approval from public.customer_messaging_settings cms
    join public.customers c on c.sap_customer_number = cms.sap_customer_number
    where c.id = inv.sold_to_customer_id for share of cms;
  if not approval.enabled or approval.approved_phone is distinct from p_recipient or approval.enabled_at is null then
    raise exception 'Customer is not enabled at the confirmed number';
  end if;
  if inv.billing_document_type <> 'F2' or inv.is_cancelled or inv.transaction_currency <> 'INR'
    or inv.billing_document_date < date '2026-10-20' or inv.creation_datetime is null
    or inv.creation_datetime < timestamptz '2026-10-20 00:00:00+05:30'
    or inv.creation_datetime < approval.enabled_at then
    raise exception 'Invoice is outside the eligible customer/date boundary';
  end if;
  due_day := inv.billing_document_date + days;
  if due_day > (pg_catalog.now() at time zone 'Asia/Kolkata')::date then raise exception 'Invoice is not due yet'; end if;
  if p_outstanding is null or p_outstanding <= 0 or p_outstanding > inv.total_gross_amount then
    raise exception 'Confirm a valid outstanding balance';
  end if;
  if not exists (select 1 from public.invoice_items where invoice_id = inv.id) or exists (
    select 1 from public.invoice_items i where i.invoice_id = inv.id and not coalesce(
      (settings -> 'tmt_material_controls' -> 'materials' -> pg_catalog.upper(pg_catalog.btrim(i.product_id)) ->> 'enabled')::boolean,
      pg_catalog.upper(pg_catalog.btrim(i.product_id)) = any(p_default_materials), false)
  ) then raise exception 'An invoice material is Off or not approved'; end if;
  if exists (select 1 from public.payment_follow_up_cases where invoice_id = inv.id) then
    raise exception 'A journey already exists for this invoice';
  end if;
  if exists (select 1 from public.invoice_receivables where invoice_id = inv.id
    and (outstanding_amount <= 0 or payment_status in ('paid','written_off','cancelled'))) then
    raise exception 'Invoice is already closed';
  end if;
  insert into public.payment_follow_up_cases(invoice_id,status,next_action_at)
    values (inv.id,'active',pg_catalog.now() + pg_catalog.make_interval(secs => first_delay)) returning id into case_id;
  cycle := 'manual-journey-' || case_id;
  raw := pg_catalog.jsonb_build_object('source','user_confirmed','invoice_source','sap',
    'manual_payment_journey',true,'journey_case_id',case_id,'confirmed_by',p_username,
    'confirmed_at',pg_catalog.now(),'approved_recipient',p_recipient,'payment_test_cycle_id',cycle,
    'journey_settings',p_rules,'due_date_source','invoice_date_plus_configured_days');
  insert into public.invoice_receivables(invoice_id,original_amount,outstanding_amount,paid_amount,currency,
    due_date,payment_status,aging_bucket,days_overdue,raw_data)
    values (inv.id,inv.total_gross_amount,p_outstanding,inv.total_gross_amount-p_outstanding,inv.transaction_currency,
      due_day,case when p_outstanding < inv.total_gross_amount then 'partially_paid' else 'open' end,
      case when due_day = (pg_catalog.now() at time zone 'Asia/Kolkata')::date then 'due' else 'overdue' end,
      (pg_catalog.now() at time zone 'Asia/Kolkata')::date-due_day,raw)
    on conflict (invoice_id) do update set original_amount=excluded.original_amount,
      outstanding_amount=excluded.outstanding_amount,paid_amount=excluded.paid_amount,currency=excluded.currency,
      due_date=excluded.due_date,payment_status=excluded.payment_status,aging_bucket=excluded.aging_bucket,
      days_overdue=excluded.days_overdue,raw_data=excluded.raw_data,last_synced_at=pg_catalog.now();
  insert into public.audit_logs(actor_type,action,entity_type,entity_id,after_data,metadata)
    values ('user','manual_payment_journey_started','payment_follow_up_case',case_id::text,
      pg_catalog.jsonb_build_object('invoice',inv.sap_billing_document,'due_date',due_day,'outstanding',p_outstanding,'rules',p_rules),
      pg_catalog.jsonb_build_object('username',p_username));
  return case_id;
end;
$$;
revoke all on function public.start_manual_payment_journey(bigint,text,numeric,jsonb,text[],text) from public, anon, authenticated;
grant execute on function public.start_manual_payment_journey(bigint,text,numeric,jsonb,text[],text) to service_role;
