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
controls the session lifetime and defaults to eight hours.

Successful login creates an opaque, HTTP-only, same-site cookie. The backend
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
- MSG91 `share_invoice` document-template delivery;
- delivery attempts, safe manual retries, and sent/delivered/read/failed status history;
- admin login, preflight, delivery history, and job timeline UI.

Apply `supabase/migrations/20260728170000_invoice_delivery_worker.sql` after the
core schema. It adds the atomic queue claim and records the already-approved
MSG91 template.

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
```

During controlled testing, keep `DELIVERY_MODE=test` and put only the approved
country-code-prefixed number in `WHATSAPP_TEST_RECIPIENTS`. A newly created SAP
invoice is deliverable only when all of these are true:

- its sold-to customer is explicitly allowlisted;
- its SAP creation date is on or after the configured start date;
- it is not cancelled;
- SAP returns a valid PDF and a valid customer phone number;
- in test mode, that phone number is also on the WhatsApp test allowlist.

The dashboard shows the last SAP polling result and provides a read-only
**Check SAP now** action. Normal polling runs automatically at the configured
interval.

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

Each click on **Send sample invoice** creates a new 10-digit invoice number,
keeps the SAP OData-shaped response structure, generates a PDF containing the
same invoice details, stores and queues it, and sends it through the real MSG91
path to the masked fixed test number. It does not call SAP. Because every click
has a new invoice number, the production-style idempotency protection remains
enabled instead of being bypassed.

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
