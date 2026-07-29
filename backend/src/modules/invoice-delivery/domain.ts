export type SapInvoiceItem = {
  itemNumber: string;
  productId?: string;
  description?: string;
  quantity?: number;
  quantityUnit?: string;
  netAmount?: number;
  taxAmount?: number;
  currency?: string;
  rawData: Record<string, unknown>;
};

export type InvoiceCandidate = {
  fixtureId: string;
  fixtureLabel: string;
  billingDocument: string;
  billingDocumentType: string;
  billingDocumentCategory?: string;
  billingDocumentDate: string;
  creationDateTime?: string;
  lastChangedAt?: string;
  customer: {
    businessPartnerId?: string;
    customerNumber: string;
    displayName: string;
    legalName?: string;
    countryCode?: string;
    currency?: string;
    rawData: Record<string, unknown>;
  };
  contact: {
    originalValue: string;
    normalizedValue: string;
    isPrimary: boolean;
    isVerified: boolean;
    rawData: Record<string, unknown>;
  };
  salesOrganization?: string;
  distributionChannel?: string;
  division?: string;
  currency: string;
  totalNetAmount: number;
  totalTaxAmount: number;
  totalGrossAmount: number;
  accountingPostingStatus?: string;
  overallBillingStatus?: string;
  isCancelled: boolean;
  items: SapInvoiceItem[];
  pdf: {
    fileName: string;
    mimeType: 'application/pdf';
    base64: string;
  };
  rawData: Record<string, unknown>;
};

export type ValidationResult = {
  code: string;
  label: string;
  passed: boolean;
  blocking: boolean;
};

export type InvoicePreview = {
  source: 'fixture';
  fixtureId: string;
  fixtureLabel: string;
  invoice: {
    billingDocument: string;
    billingDocumentDate: string;
    customerName: string;
    customerNumber: string;
    fixtureContact: string;
    currency: string;
    totalGrossAmount: number;
    itemCount: number;
    pdfFileName: string;
  };
  actualRecipient: string;
  maskedRecipient: string;
  template: {
    name: string;
    language: string;
    variables: Record<string, string>;
  };
  validations: ValidationResult[];
  sendAllowed: boolean;
};

export type PersistedDelivery = {
  jobId: number;
  duplicate: boolean;
  status: string;
};

export type Msg91TemplateInput = {
  recipient: string;
  documentUrl: string;
  documentFileName: string;
  customerName: string;
  billingDocument: string;
  billingDocumentDate: string;
  formattedAmount: string;
  teamName: string;
};
