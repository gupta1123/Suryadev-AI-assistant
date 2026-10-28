import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Real Postgres semantics in an isolated in-memory database. No project access.
const migration = await readFile(new URL('../../../../supabase/migrations/20261027070417_manual_payment_journeys.sql', import.meta.url), 'utf8');
const rules = { dueDays:3, firstReminderDelaySeconds:120, repeatReminderDelaySeconds:180, maximumReminders:3, updatedAt:null as string | null };
async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.system_settings(id bigint primary key,settings jsonb);
    create table public.customers(id bigint primary key,sap_customer_number text);
    create table public.customer_messaging_settings(sap_customer_number text primary key,enabled boolean,approved_phone text,enabled_at timestamptz);
    create table public.invoices(id bigint primary key,sold_to_customer_id bigint,sap_billing_document text,billing_document_type text,
      billing_document_date date,creation_datetime timestamptz,is_cancelled boolean,transaction_currency text,total_gross_amount numeric);
    create table public.invoice_items(invoice_id bigint,product_id text);
    create table public.payment_follow_up_cases(id bigint generated always as identity primary key,invoice_id bigint unique,status text,next_action_at timestamptz);
    create table public.invoice_receivables(invoice_id bigint primary key,original_amount numeric,outstanding_amount numeric,paid_amount numeric,
      currency text,due_date date,payment_status text,aging_bucket text,days_overdue int,raw_data jsonb,last_synced_at timestamptz);
    create table public.audit_logs(actor_type text,action text,entity_type text,entity_id text,after_data jsonb,metadata jsonb);
    insert into public.system_settings values (1,'{}');
    insert into public.customers values (1,'510191');
    insert into public.customer_messaging_settings values ('510191',true,'918098868251','2026-10-20T00:00:00Z');
    insert into public.invoices values (1,1,'26ST000042','F2','2026-10-24','2026-10-24T14:00:00Z',false,'INR',1000);
    insert into public.invoice_items values (1,'30000123');
  `);
  await db.exec(migration);
  return db;
}
async function start(db: PGlite, nextRules = rules, amount = 700, recipient = '918098868251') {
  return db.query('select public.start_manual_payment_journey($1,$2,$3,$4,$5,$6) as id', [1,recipient,amount,JSON.stringify(nextRules),['30000123'],'test-admin']);
}
it('atomic manual start snapshots due date, partial balance, timing and consent without sending', async () => {
  const db = await database();
  try {
    const { rows } = await start(db);
    assert.equal(rows.length,1);
    const balance = (await db.query<any>('select * from invoice_receivables')).rows[0];
    assert.equal(Number(balance.outstanding_amount),700);
    assert.equal(Number(balance.paid_amount),300);
    assert.equal(balance.payment_status,'partially_paid');
    assert.equal(new Date(balance.due_date).toISOString().slice(0,10),'2026-10-27');
    assert.deepEqual(balance.raw_data.journey_settings,rules);
    assert.equal(balance.raw_data.source,'user_confirmed');
    assert.equal(balance.raw_data.manual_payment_journey,true);
    await db.exec(`update system_settings set settings='{"payment_reminders":{"dueDays":7,"updatedAt":"2026-10-27T00:00:00Z"}}'`);
    assert.deepEqual((await db.query<any>('select raw_data from invoice_receivables')).rows[0].raw_data.journey_settings,rules);
    assert.equal((await db.query('select * from audit_logs')).rows.length,1);
  } finally { await db.close(); }
});
it('changing due days later keeps an existing journey frozen and starts nothing', async () => {
  const db = await database();
  try {
    await start(db);
    const before = (await db.query<any>('select c.next_action_at, r.due_date, r.raw_data from payment_follow_up_cases c join invoice_receivables r using (invoice_id)')).rows[0];
    await db.exec(`update system_settings set settings='{"payment_reminders":{"dueDays":90,"updatedAt":"2026-10-27T00:00:00Z"}}'`);
    const after = (await db.query<any>('select c.next_action_at, r.due_date, r.raw_data from payment_follow_up_cases c join invoice_receivables r using (invoice_id)')).rows[0];
    assert.deepEqual(after, before);
    assert.equal(new Date(after.due_date).toISOString().slice(0,10),'2026-10-27');
    assert.equal((await db.query('select * from payment_follow_up_cases')).rows.length,1);
    // A new start under a longer setting (invoice date + 90 days) is not due yet. 90 keeps this independent of today's date.
    await db.exec('delete from payment_follow_up_cases; delete from invoice_receivables;');
    await assert.rejects(start(db,{ ...rules, dueDays:90, updatedAt:'2026-10-27T00:00:00Z' }),/not due yet/);
  } finally { await db.close(); }
});
it('double-clicks/concurrent starts cannot create a second journey or reset a paid case', async () => {
  const db = await database();
  try {
    const results = await Promise.allSettled([start(db),start(db)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal((await db.query('select * from payment_follow_up_cases')).rows.length,1);
    await db.exec(`update payment_follow_up_cases set status='resolved'; update invoice_receivables set outstanding_amount=0,payment_status='paid'`);
    await assert.rejects(start(db),/already exists/);
    assert.equal(Number((await db.query<any>('select outstanding_amount from invoice_receivables')).rows[0].outstanding_amount),0);
  } finally { await db.close(); }
});
for (const [label,setup,pattern] of [
  ['disabled customer', `update customer_messaging_settings set enabled=false`, /not enabled/],
  ['changed phone', `update customer_messaging_settings set approved_phone='919999999999'`, /not enabled/],
  ['not due', `update invoices set billing_document_date=current_date`, /not due/],
  ['old invoice', `update invoices set billing_document_date='2026-10-19'`, /boundary/],
  ['pre-enablement invoice', `update customer_messaging_settings set enabled_at='2026-10-25'`, /boundary/],
  ['cancelled invoice', `update invoices set is_cancelled=true`, /boundary/],
  ['disabled material', `update system_settings set settings='{"tmt_material_controls":{"materials":{"30000123":{"enabled":false}}}}'`, /material/],
  ['mixed materials', `insert into invoice_items values(1,'30000032')`, /material/],
  ['missing materials', `delete from invoice_items`, /material/],
  ['settings changed', `update system_settings set settings='{"payment_reminders":{"updatedAt":"2026-10-27T01:00:00Z"}}'`, /settings changed/],
] as const) it(`start refuses ${label} and rolls back every journey write`, async () => {
  const db = await database();
  try {
    await db.exec(setup);
    await assert.rejects(start(db),pattern);
    assert.equal((await db.query('select * from payment_follow_up_cases')).rows.length,0);
    assert.equal((await db.query('select * from invoice_receivables')).rows.length,0);
    assert.equal((await db.query('select * from audit_logs')).rows.length,0);
  } finally { await db.close(); }
});
it('RPC rejects bad balances/settings and cannot be called by anonymous or authenticated browser roles', async () => {
  const db = await database();
  try {
    for (const amount of [0,-1,1001]) await assert.rejects(start(db,rules,amount),/balance/);
    for (const dueDays of [0,91]) await assert.rejects(start(db,{...rules,dueDays}),/settings/);
    const permissions = await db.query<any>(`select has_function_privilege('anon','public.start_manual_payment_journey(bigint,text,numeric,jsonb,text[],text)','execute') as anon,
      has_function_privilege('authenticated','public.start_manual_payment_journey(bigint,text,numeric,jsonb,text[],text)','execute') as browser,
      has_function_privilege('service_role','public.start_manual_payment_journey(bigint,text,numeric,jsonb,text[],text)','execute') as backend`);
    assert.deepEqual(permissions.rows[0],{anon:false,browser:false,backend:true});
  } finally { await db.close(); }
});
