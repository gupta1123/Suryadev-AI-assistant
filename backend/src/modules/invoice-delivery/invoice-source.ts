import { env } from '../../config/env.js';
import type { InvoiceCandidate } from './domain.js';
import { FixtureInvoiceSource } from './fixture-source.js';
import { SapInvoiceSource } from './sap-source.js';

export type InvoiceSourceSummary = {
  id: string;
  label: string;
  billingDocument: string;
  billingDocumentType: string;
  customerName: string;
  amount: number;
  currency: string;
  // Header facts known from the list call, so cheap checks can run before the heavy read.
  customerNumber?: string;
  billingDocumentDate?: string;
  creationDateTime?: string | null;
};

export interface InvoiceSource {
  list(): Promise<InvoiceSourceSummary[]>;
  get(id: string): Promise<InvoiceCandidate>;
}

export function getInvoiceSource(): InvoiceSource {
  return env.INVOICE_SOURCE === 'fixture'
    ? new FixtureInvoiceSource()
    : new SapInvoiceSource();
}
