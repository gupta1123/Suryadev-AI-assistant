-- Payment is due 3 days after the invoice date. Existing controlled-test
-- receivables were created with a configured or same-day due date, so move them
-- onto the same rule. Aging is derived from due_date when read, so the stored
-- aging columns are only refreshed here for consistency.
update public.invoice_receivables as receivables
set
  due_date = invoices.billing_document_date + 3,
  aging_bucket = case
    when receivables.outstanding_amount <= 0 then 'closed'
    when invoices.billing_document_date + 3 > current_date then 'upcoming'
    when invoices.billing_document_date + 3 = current_date then 'due'
    when current_date - (invoices.billing_document_date + 3) >= 30 then 'critical'
    else 'overdue'
  end,
  days_overdue = case
    when receivables.outstanding_amount <= 0 then 0
    else greatest(0, current_date - (invoices.billing_document_date + 3))
  end,
  updated_at = now()
from public.invoices as invoices
where invoices.id = receivables.invoice_id
  and receivables.raw_data ->> 'source' = 'test_fixture';
