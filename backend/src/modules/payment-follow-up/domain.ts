import type { InvoiceCandidate, ValidationResult } from '../invoice-delivery/domain.js';

export type PaymentStatus = 'open' | 'partially_paid' | 'paid';
export type AgingBucket = 'upcoming' | 'due' | 'overdue' | 'critical' | 'closed';

export type TestReceivable = {
  source: 'test_fixture';
  originalAmount: number;
  outstandingAmount: number;
  paidAmount: number;
  currency: string;
  dueDate: string;
  paymentStatus: PaymentStatus;
  agingBucket: AgingBucket;
  daysOverdue: number;
};

export type PaymentTestPreview = {
  mode: 'controlled_test';
  invoiceSource: 'sap';
  receivableSource: 'test_fixture';
  candidate: InvoiceCandidate;
  receivable: TestReceivable;
  recipient: string;
  maskedRecipient: string;
  template: {
    name: string;
    language: string;
    approved: boolean;
    message: string;
  };
  validations: ValidationResult[];
  sendAllowed: boolean;
  disclosure: string;
};

export type PaymentTestRunResult = {
  caseId: number;
  jobId: number | null;
  duplicate: boolean;
  status: string;
};
