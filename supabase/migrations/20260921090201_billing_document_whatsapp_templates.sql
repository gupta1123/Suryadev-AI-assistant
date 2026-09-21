-- Register the four additional button-free billing-document templates used by
-- the read-only SAP delivery flow. The existing F2 template remains unchanged.

insert into public.communication_templates (
  code, purpose, channel, locale, name, body_template,
  provider_integration_id, provider_template_id, version, status, required_variables
)
select
  templates.code,
  'invoice_delivery',
  'whatsapp',
  'en',
  templates.name,
  templates.body_template,
  integrations.id,
  templates.provider_template_id,
  1,
  'draft',
  '["header_1", "body_1", "body_2", "body_3", "body_4", "body_5"]'::jsonb
from public.provider_integrations as integrations
cross join (
  values
    ('cancelled_invoice_delivery_whatsapp_en', 'Cancelled invoice delivery - English', E'Dear {{1}},\n\nYour invoice cancellation document {{2}} dated {{3}} has been generated.\n\nCancellation Amount: ₹{{4}}\n\nPlease find the cancelled invoice PDF attached above.\n\nThank you,\nThe {{5}} Team', 'share_invoice_cancellation_v2'),
    ('return_credit_memo_delivery_whatsapp_en', 'Return credit memo delivery - English', E'Dear {{1}},\n\nYour return credit memo {{2}} dated {{3}} has been generated.\n\nReturn Credit Amount: ₹{{4}}\n\nPlease find the return credit memo PDF attached above.\n\nThank you,\nThe {{5}} Team', 'share_return_credit_memo_v2'),
    ('credit_memo_delivery_whatsapp_en', 'Credit memo delivery - English', E'Dear {{1}},\n\nYour credit memo {{2}} dated {{3}} has been generated.\n\nCredit Amount: ₹{{4}}\n\nPlease find the credit memo PDF attached above.\n\nThank you,\nThe {{5}} Team', 'share_credit_memo'),
    ('debit_memo_delivery_whatsapp_en', 'Debit memo delivery - English', E'Dear {{1}},\n\nYour debit memo {{2}} dated {{3}} has been generated.\n\nDebit Amount: ₹{{4}}\n\nPlease find the debit memo PDF attached above.\n\nThank you,\nThe {{5}} Team', 'share_debit_memo')
) as templates(code, name, body_template, provider_template_id)
where integrations.provider = 'msg91'
  and integrations.channel = 'whatsapp'
on conflict (code, channel, locale, version) do update
set
  provider_integration_id = excluded.provider_integration_id,
  provider_template_id = excluded.provider_template_id,
  name = excluded.name,
  body_template = excluded.body_template,
  required_variables = excluded.required_variables,
  updated_at = now();
