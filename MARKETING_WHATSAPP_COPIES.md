# SuryaDev marketing-manager copies

Future customer-facing billing messages (F2, S1, CBRE, G2, L2) and payment
reminders can be copied to `919445029682`. Internal Need Help alerts are not
customer-facing and retain their separate configured recipient.

The copy preserves the actual sender, template, language, customer variables,
PDF and filename. No new template is needed. The manager will see the customer's
name, not their own. This is an additional WhatsApp send and may incur a charge.

## Activation

1. In the **SuryaDev** Supabase project, manually run
   `supabase/migrations/20261013094730_marketing_whatsapp_copies.sql`.
2. Deploy the backend changes to `suryadevaiagent`.
3. Set only that app's `MSG91_MARKETING_COPY_ENABLED=true` and
   `MSG91_MARKETING_COPY_RECIPIENT=919445029682`.
4. Run one controlled customer delivery; check both recipient phones and the
   `marketing_whatsapp_copies` record. Do not replay old customer jobs just to
   create copies.

No change to sender selection, customer allowlists, other projects, SAP data,
or MSG91 templates is required. Local copies are disabled by default until the
migration is applied. To disable new copying, set the feature flag to false.

## Isolation and reliability

- A durable unique `(source_job_id, recipient)` record is created before a
  customer send. Dispatch waits for the source message to be accepted/sent.
- Manager copies are not customer communication jobs/messages, so their read
  receipts cannot advance customer status or schedule payment reminders.
- Known manager-copy button responses are ignored for customer confirmations
  and help requests. The identical approved template still shows its buttons.
- The worker signs a fresh URL for the original PDF, preserving its content.
- Copy failures do not retry the customer's send. Explicit temporary failures
  have bounded retries. Timeouts/stale dispatches become `unknown` for manual
  verification rather than risking duplicate sends.
- `accepted` means MSG91 accepted the send, not that the manager read it.
  The queue stores its own provider IDs for troubleshooting.
- No historical backfill is performed. The SQL uses RLS and grants access only
  to the server service role.
