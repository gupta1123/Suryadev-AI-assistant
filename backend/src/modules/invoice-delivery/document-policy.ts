import {
  env,
  sapTmtMaterialGroups,
  sapTmtMaterialIds,
  sapTmtMaterialPrefixes,
} from '../../config/env.js';
import type { InvoiceCandidate, SapInvoiceItem } from './domain.js';

export const SUPPORTED_BILLING_DOCUMENT_TYPES = ['F2', 'S1', 'CBRE', 'G2', 'L2'] as const;

export type SupportedBillingDocumentType =
  (typeof SUPPORTED_BILLING_DOCUMENT_TYPES)[number];

export type BillingDocumentDefinition = {
  type: SupportedBillingDocumentType;
  kind: 'invoice' | 'cancelled_invoice' | 'return_credit_memo' | 'credit_memo' | 'debit_memo';
  label: string;
  fileNamePrefix: string;
  templateName: string;
  parameterFormat: 'named' | 'positional';
};

export function getBillingDocumentDefinition(
  value: string,
): BillingDocumentDefinition | null {
  const type = value.trim().toUpperCase();
  switch (type) {
    case 'F2':
      return {
        type,
        kind: 'invoice',
        label: 'Invoice',
        fileNamePrefix: 'Invoice',
        templateName: env.MSG91_TEMPLATE_NAME,
        parameterFormat: 'named',
      };
    case 'S1':
      return {
        type,
        kind: 'cancelled_invoice',
        label: 'Cancelled invoice',
        fileNamePrefix: 'Cancelled-Invoice',
        templateName: env.MSG91_CANCELLATION_TEMPLATE_NAME,
        parameterFormat: 'positional',
      };
    case 'CBRE':
      return {
        type,
        kind: 'return_credit_memo',
        label: 'Return credit memo',
        fileNamePrefix: 'Return-Credit-Memo',
        templateName: env.MSG91_RETURN_CREDIT_MEMO_TEMPLATE_NAME,
        parameterFormat: 'positional',
      };
    case 'G2':
      return {
        type,
        kind: 'credit_memo',
        label: 'Credit memo',
        fileNamePrefix: 'Credit-Memo',
        templateName: env.MSG91_CREDIT_MEMO_TEMPLATE_NAME,
        parameterFormat: 'positional',
      };
    case 'L2':
      return {
        type,
        kind: 'debit_memo',
        label: 'Debit memo',
        fileNamePrefix: 'Debit-Memo',
        templateName: env.MSG91_DEBIT_MEMO_TEMPLATE_NAME,
        parameterFormat: 'positional',
      };
    default:
      return null;
  }
}

export function isTmtDocument(candidate: Pick<InvoiceCandidate, 'items'>): boolean {
  return candidate.items.some(isTmtItem);
}

export function isTmtItem(item: SapInvoiceItem): boolean {
  const productId = normalize(item.productId);
  if (productId && sapTmtMaterialIds.has(productId)) return true;
  if (
    productId &&
    [...sapTmtMaterialPrefixes].some((prefix) => productId.startsWith(prefix))
  ) {
    return true;
  }

  const materialGroup = normalize(
    item.rawData.MaterialGroup ??
      item.rawData.ProductGroup ??
      item.rawData.MaterialGroupExternal,
  );
  if (materialGroup && sapTmtMaterialGroups.has(materialGroup)) return true;

  // Until the client supplies its final material master mapping, accept only
  // the explicit TMT token in SAP's item description as a controlled fallback.
  return /(^|[^A-Z0-9])TMT([^A-Z0-9]|$)/.test(normalize(item.description));
}

function normalize(value: unknown): string {
  return value == null ? '' : String(value).trim().toUpperCase();
}
