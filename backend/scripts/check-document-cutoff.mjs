// Read-only release audit. No application/worker entry points are imported.
import { documentDateBlocker, DOCUMENT_SEND_CUTOFF } from '../dist/modules/messaging/document-date-policy.js';
const base = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) throw new Error('Backend Supabase credentials must be supplied securely in the environment');
async function read(table, select, filters = {}) {
  const url = new URL(`/rest/v1/${table}`, base);
  url.searchParams.set('select', select);
  url.searchParams.set('limit', '1000');
  for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
  const response = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Read-only audit failed: ${table} HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length >= 1000) throw new Error(`Audit safety cap reached for ${table}; no partial totals reported`);
  return rows;
}
async function byIds(table, select, values) {
  const ids = [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  const rows = [];
  for (let start = 0; start < ids.length; start += 100) rows.push(...await read(table, select, { id: `in.(${ids.slice(start, start + 100).join(',')})` }));
  return rows;
}
const [jobs, copies, alerts] = await Promise.all([
  read('communication_jobs', 'id,job_type,primary_invoice_id', { status: 'in.(queued,processing)' }),
  read('marketing_whatsapp_copies', 'id,source_job_id', { status: 'in.(pending,processing)' }),
  read('help_request_notifications', 'id,review_task_id', { status: 'in.(pending,processing)' }),
]);
const [sourceJobs, tasks] = await Promise.all([
  byIds('communication_jobs', 'id,primary_invoice_id', copies.map(row => row.source_job_id)),
  byIds('review_tasks', 'id,invoice_id', alerts.map(row => row.review_task_id)),
]);
const invoices = new Map((await byIds('invoices', 'id,billing_document_date,creation_datetime',
  [...jobs, ...sourceJobs].map(row => row.primary_invoice_id).concat(tasks.map(row => row.invoice_id))))
  .map(row => [row.id, row]));
const sources = new Map(sourceJobs.map(row => [row.id, row.primary_invoice_id]));
const linkedTasks = new Map(tasks.map(row => [row.id, row.invoice_id]));
function blocked(id) {
  const invoice = invoices.get(id);
  return Boolean(documentDateBlocker({ documentDate: invoice?.billing_document_date, documentCreatedAt: invoice?.creation_datetime }));
}
console.log(JSON.stringify({ readOnly: true, cutoffInclusive: DOCUMENT_SEND_CUTOFF,
  communicationJobs: { pending: jobs.length, blockedByDate: jobs.filter(row => blocked(row.primary_invoice_id)).length },
  managerCopies: { pending: copies.length, blockedByDate: copies.filter(row => blocked(sources.get(row.source_job_id))).length },
  helpAlerts: { pending: alerts.length, blockedByDate: alerts.filter(row => blocked(linkedTasks.get(row.review_task_id))).length },
}, null, 2));
