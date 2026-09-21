# SuryaDev AI Agents

Single-tenant control room for SuryaDev's SAP invoice-delivery agent. It can
run against an SAP-shaped fixture for controlled simulations or poll SAP S/4HANA
Cloud read-only and deliver eligible invoice PDFs through MSG91 WhatsApp.

## Structure

```text
frontend/   React + Vite + TypeScript
backend/    Node.js + Express + TypeScript
supabase/   Supabase configuration, migrations, and seed data
```

## Prerequisites

- Node.js 20 or newer
- npm
- Docker Desktop only when running Supabase locally
- A hosted Supabase project for shared environments

## Setup

```bash
npm install
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run dev
```

The frontend runs at `http://localhost:5173` and the backend at
`http://localhost:3000` by default.

## Administrator login

The application uses a backend-owned administrator session. The default local
credentials are:

```text
Username: admin
Password: admin
```

Configure them in `backend/.env` with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
Change the password before deploying the application. `AUTH_SESSION_HOURS`
controls the session lifetime and defaults to 720 hours (30 days). Configure a
persistent `AUTH_SESSION_SECRET` of at least 32 characters so signed sessions
remain valid across backend restarts and deployments.

Successful login creates a signed, HTTP-only, same-site cookie. The backend
validates that cookie on every invoice-delivery API call, restores the session
after a browser refresh, rate-limits failed login attempts, validates mutation
origins, and revokes the active session on logout. Sessions intentionally reset
when the backend process restarts.

## Supabase

Link this repository to the hosted project before pushing migrations:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npm run supabase:push
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` to the frontend. It belongs only in
the backend environment. Supabase Auth is not used by this single-admin build.

## Invoice-delivery workflow

In fixture mode, the backend reads `backend/fixtures/sap/*.json`. Each fixture
preserves the OData envelope and field names expected from the Billing Document
and Business Partner APIs, including a base64 `GetPDF` response.

In SAP mode, the backend polls `A_BillingDocument`, then reads the eligible
invoice's items, business partner, address phone, and PDF. The SAP client exposes
GET operations only. It cannot create, update, cancel, or post an SAP document.
The customer allowlist and start date are applied both in the SAP query and again
before queueing, and the delivery idempotency key prevents the same invoice from
being sent twice to the same recipient.

The first workflow provides:

- one-click generation of a unique SAP-shaped dummy invoice and matching PDF;
- invoice preview and deterministic template variables;
- test-recipient allowlisting;
- private PDF storage and temporary signed download URLs;
- idempotent delivery jobs;
- database-backed job claiming with `FOR UPDATE SKIP LOCKED`;
- existing MSG91 `share_invoice` F2 document-template delivery;
- delivery attempts, safe manual retries, and sent/delivered/read/failed status history;
- admin login, preflight, delivery history, and job timeline UI.

Apply `supabase/migrations/20260728170000_invoice_delivery_worker.sql` after the
core schema. It adds the atomic queue claim and preserves the approved F2 template.
Then apply `supabase/migrations/20260921090201_billing_document_whatsapp_templates.sql`
to register the four additional button-free templates used by the current workflow.

`supabase/migrations/20260729120000_sap_polling_and_delivery_status.sql` adds an
atomic SAP checkpoint claim and an index for provider-status reconciliation. The
backend has safe single-process fallbacks, so development can run before that
optional migration is applied; apply it before running multiple backend replicas.

## Live SAP polling

Configure these backend-only values:

```dotenv
INVOICE_SOURCE=sap
DELIVERY_MODE=test
SAP_API_BASE_URL=https://<tenant>-api.s4hana.cloud.sap/sap/opu/odata/sap
SAP_API_USERNAME=<communication-user>
SAP_API_PASSWORD=<communication-user-password>
SAP_POLL_ENABLED=true
SAP_POLL_INTERVAL_MS=15000
SAP_POLL_START_DATE=2026-07-29
SAP_ALLOWED_CUSTOMERS=550071
SAP_TMT_MATERIAL_IDS=
SAP_TMT_MATERIAL_PREFIXES=TMT,STEEL-TMT
SAP_TMT_MATERIAL_GROUPS=
```

During controlled testing, keep `DELIVERY_MODE=test` and put only the approved
country-code-prefixed number in `WHATSAPP_TEST_RECIPIENTS`. A newly created SAP
billing document is deliverable only when all of these are true:

- its sold-to customer is explicitly allowlisted;
- its SAP creation date is on or after the configured start date;
- its document type is F2, S1, CBRE, G2, or L2;
- at least one item matches the configured TMT material IDs, prefixes, groups,
  or contains the explicit `TMT` token in its SAP item description;
- it is not a cancelled original (the separate S1 cancellation document is delivered);
- SAP returns a valid PDF and a valid customer phone number;
- in test mode, that phone number is also on the WhatsApp test allowlist.

The dashboard shows the last SAP polling result and provides a **Check SAP now**
action. This action reads SAP only, but eligible records can be stored locally
and queued for WhatsApp delivery when every delivery and approval gate is enabled.
Normal polling runs automatically at the configured interval.

Each document type is routed to its own MSG91 template. Configure
`MSG91_TEMPLATE_NAME` for F2 and the four `MSG91_*_TEMPLATE_NAME` values shown
in `backend/.env.example` for S1, CBRE, G2, and L2. The SAP integration remains
strictly GET-only; it never creates, changes, cancels, or posts SAP data.
The existing F2 template remains unchanged. The new S1, CBRE, G2 and L2 templates
contain a PDF document header and five numbered body variables only; they deliberately
contain no quick-reply, URL, phone, or call-to-action buttons.

## Enabling one real test send

Keep these defaults until the preview is correct:

```dotenv
INVOICE_SOURCE=fixture
DELIVERY_MODE=test
MSG91_SEND_ENABLED=false
```

Then configure the backend-only `SUPABASE_SERVICE_ROLE_KEY`, `MSG91_AUTHKEY`,
`MSG91_INTEGRATED_NUMBER`, a strong `MSG91_WEBHOOK_SECRET`, and one or more
comma-separated `WHATSAPP_TEST_RECIPIENTS`. Set one fixed
`WHATSAPP_DEFAULT_TEST_RECIPIENT` (country code plus number) for the one-click
simulator. The default recipient is automatically included in the backend
allowlist. Set `MSG91_SEND_ENABLED=true` only for the controlled test. Both send
endpoints remain blocked unless every preflight check passes.

The one-click test lets an administrator choose F2, S1, CBRE, G2, or L2. Each
click creates a new 10-digit billing-document number, keeps the SAP OData-shaped
response structure, generates a type-specific PDF containing the same details,
stores and queues it, and sends it through the real MSG91 path to the masked fixed
test number. It does not call SAP. Because every click has a new document number,
the production-style idempotency protection remains enabled instead of being bypassed.

The optional callback URL is:

```text
https://<backend-host>/api/webhooks/msg91/whatsapp
```

Configure MSG91 to include the same secret in the
`x-msg91-webhook-secret` header.

The backend also reconciles pending messages from the MSG91 WhatsApp Logs API at
`MSG91_STATUS_POLL_INTERVAL_MS`. This verifies the provider's final sent,
delivered, read, or failed state even when a webhook cannot be configured.

## Verification

```bash
npm test
npm run typecheck
npm run build
```
