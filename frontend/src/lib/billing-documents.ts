const billingDocuments: Record<string, {
  label: string;
  messageLabel: string;
  amountLabel: string;
  attachmentMessage: string;
}> = {
  F2: {
    label: 'Invoice',
    messageLabel: 'invoice',
    amountLabel: 'Invoice Amount',
    attachmentMessage: 'Please find the invoice PDF attached above.',
  },
  S1: {
    label: 'Cancelled invoice',
    messageLabel: 'invoice cancellation document',
    amountLabel: 'Cancellation Amount',
    attachmentMessage: 'Please find the cancelled invoice PDF attached above.',
  },
  CBRE: {
    label: 'Return credit memo',
    messageLabel: 'return credit memo',
    amountLabel: 'Return Credit Amount',
    attachmentMessage: 'Please find the return credit memo PDF attached above.',
  },
  G2: {
    label: 'Credit memo',
    messageLabel: 'credit memo',
    amountLabel: 'Credit Amount',
    attachmentMessage: 'Please find the credit memo PDF attached above.',
  },
  L2: {
    label: 'Debit memo',
    messageLabel: 'debit memo',
    amountLabel: 'Debit Amount',
    attachmentMessage: 'Please find the debit memo PDF attached above.',
  },
};

export function billingDocumentLabel(type?: string | null): string {
  return billingDocuments[type?.toUpperCase() ?? '']?.label ?? 'Billing document';
}

export function billingDocumentMessage(
  type: string | undefined,
  documentNumber: string,
  documentDate: string,
): string {
  const details = billingDocuments[type?.toUpperCase() ?? ''];
  const label = details?.messageLabel ?? 'billing document';
  return `Your ${label} ${documentNumber} dated ${documentDate} has been generated.`;
}

export function billingDocumentAmountLabel(type?: string | null): string {
  return billingDocuments[type?.toUpperCase() ?? '']?.amountLabel ?? 'Document Amount';
}

export function billingDocumentAttachmentMessage(type?: string | null): string {
  return billingDocuments[type?.toUpperCase() ?? '']?.attachmentMessage ?? 'Please find the PDF attached above.';
}

export function billingDocumentSignature(
  type: string | undefined | null,
  teamName: string,
): string {
  return type?.toUpperCase() === 'F2'
    ? `Team ${teamName}`
    : `The ${teamName} Team`;
}
