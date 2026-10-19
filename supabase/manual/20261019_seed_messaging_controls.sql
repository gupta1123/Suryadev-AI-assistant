-- ONE-TIME seed for the messaging controls. Not a migration: it is never run by
-- `supabase db push`. Run it manually, once, AFTER the 20261019120000 migration
-- and BEFORE deploying the code that reads these tables.
--
-- Why that order: the currently deployed code ignores these tables, so seeding
-- first changes nothing. `enabled_at = now()` then marks the point from which
-- documents are governed by the new rules; anything created earlier was already
-- handled by the old code (deliveries are idempotent per document + recipient).
--
-- Inputs, all verified read-only on 2026-10-19:
--   * Six customers already exist in `customers` with one active primary WhatsApp
--     contact each; their phones are copied from that contact.
--   * Appasamy (510730) has no customers row yet. Its live SAP phone was read
--     from SAP on 2026-10-19: 919445029682.
--   * Interim marketing manager for every client: Payal, 917019339764.
--
-- Every insert is `on conflict do nothing`, so re-running it changes nothing.

begin;

insert into public.customer_messaging_settings
  (sap_customer_number, enabled, approved_phone, enabled_at,
   manager_name, manager_phone, manager_source, updated_by)
select c.sap_customer_number, true, cc.normalized_value, now(),
       'Payal', '917019339764', 'manual', 'seed-2026-10-19'
from public.customers c
join public.customer_contacts cc on cc.customer_id = c.id
where c.sap_customer_number in ('510013', '510672', '510719', '530234', '530384', '550044')
  and cc.channel = 'whatsapp'
  and cc.is_primary and cc.is_active and not cc.do_not_contact
  and cc.normalized_value ~ '^[1-9][0-9]{7,14}$'
on conflict (sap_customer_number) do nothing;

insert into public.customer_messaging_settings
  (sap_customer_number, enabled, approved_phone, enabled_at,
   manager_name, manager_phone, manager_source, updated_by)
values
  ('510730', true, '919445029682', now(),
   'Payal', '917019339764', 'manual', 'seed-2026-10-19')
on conflict (sap_customer_number) do nothing;

-- Internal team numbers: the primary contacts of the four test customers that map
-- to team phones. Only these may receive test documents and payment reminders.
-- The server environment still decides which numbers are permitted at all.
insert into public.internal_test_recipients
  (phone, label, allow_simulator, allow_payment_reminders, updated_by)
select distinct cc.normalized_value, null, true, true, 'seed-2026-10-19'
from public.customers c
join public.customer_contacts cc on cc.customer_id = c.id
where c.sap_customer_number in ('510013', '510672', '510719', '530384')
  and cc.channel = 'whatsapp'
  and cc.is_primary and cc.is_active and not cc.do_not_contact
  and cc.normalized_value ~ '^[1-9][0-9]{7,14}$'
on conflict (phone) do nothing;

-- Review before committing: expect 7 customer rows and 4 internal rows.
select sap_customer_number, enabled, right(approved_phone, 4) as phone_end,
       manager_name, right(manager_phone, 4) as manager_end
from public.customer_messaging_settings order by sap_customer_number;
select right(phone, 4) as phone_end, allow_simulator, allow_payment_reminders
from public.internal_test_recipients order by phone;

commit;
