import { ArrowRight } from 'lucide-react';
import { formatDateTime } from '../lib/format';
import type { DeliveryJob } from '../types';
import { relationOne } from '../types';
import { StatusBadge } from './StatusBadge';

export function DeliveryTable({
  jobs,
  onOpen,
}: {
  jobs: DeliveryJob[];
  onOpen: (jobId: number) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="empty-table">
        <strong>No invoice deliveries yet</strong>
        <p>Your first test delivery will appear here with its complete history.</p>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="delivery-table">
        <thead>
          <tr><th>Invoice</th><th>Customer</th><th>Destination</th><th>Status</th><th>Created</th><th><span className="sr-only">Open</span></th></tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const invoice = relationOne(job.invoices);
            const customer = relationOne(job.customers);
            const message = relationOne(job.messages);
            return (
              <tr key={job.id}>
                <td><strong className="invoice-number">{invoice?.sap_billing_document ?? `Job #${job.id}`}</strong><small>Job #{job.id}</small></td>
                <td>{customer?.display_name ?? '—'}</td>
                <td className="mono">{job.metadata?.masked_recipient ?? '—'}</td>
                <td><StatusBadge status={message?.status ?? job.status} /></td>
                <td>{formatDateTime(job.created_at ?? job.scheduled_at)}</td>
                <td>
                  <button className="row-open-button" type="button" onClick={() => onOpen(job.id)} aria-label={`Open delivery ${invoice?.sap_billing_document ?? job.id}`}>
                    <ArrowRight size={17} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
