import {
  env,
  sapAllowedCustomers,
} from '../../config/env.js';
import type { InvoiceCandidate } from './domain.js';
import type { InvoiceSource, InvoiceSourceSummary } from './invoice-source.js';
import {
  escapeODataString,
  isRecord,
  type ODataRecord,
  SapODataClient,
} from './sap-client.js';

export class SapInvoiceSource implements InvoiceSource {
  constructor(private readonly client = new SapODataClient()) {}

  async list(): Promise<InvoiceSourceSummary[]> {
    if (sapAllowedCustomers.size === 0) return [];
    const customerFilter = [...sapAllowedCustomers]
      .map((customer) => `SoldToParty eq '${escapeODataString(customer)}'`)
      .join(' or ');
    const start = `${env.SAP_POLL_START_DATE}T00:00:00`;
    const rows = await this.client.collection(
      'API_BILLING_DOCUMENT_SRV',
      'A_BillingDocument',
      {
        filter: `(${customerFilter}) and CreationDate ge datetime'${start}'`,
        orderBy: 'CreationDate asc,CreationTime asc,BillingDocument asc',
        top: 500,
      },
    );

    return rows
      .filter((row) => isEligibleHeader(row))
      .map((row) => ({
        id: text(row.BillingDocument),
        label: `SAP invoice ${text(row.BillingDocument)}`,
        billingDocument: text(row.BillingDocument),
        customerName: text(row.SoldToParty),
        amount: number(row.TotalGrossAmount, number(row.TotalNetAmount)),
        currency: text(row.TransactionCurrency),
      }));
  }

  async get(id: string): Promise<InvoiceCandidate> {
    if (!/^[a-z0-9][a-z0-9-]{0,34}$/i.test(id)) throw new Error('Invalid SAP billing document identifier');
    const headers = await this.client.collection(
      'API_BILLING_DOCUMENT_SRV',
      'A_BillingDocument',
      { filter: `BillingDocument eq '${escapeODataString(id)}'`, top: 1 },
    );
    const header = headers[0];
    if (!header) throw new Error(`SAP billing document ${id} was not found`);
    if (!isEligibleHeader(header)) {
      throw new Error(`SAP billing document ${id} is outside the configured customer/date boundary`);
    }

    const soldToParty = text(header.SoldToParty);
    const [items, partners, addresses, pdfPayload] = await Promise.all([
      this.client.collection('API_BILLING_DOCUMENT_SRV', 'A_BillingDocumentItem', {
        filter: `BillingDocument eq '${escapeODataString(id)}'`,
      }),
      this.client.collection('API_BUSINESS_PARTNER', 'A_BusinessPartner', {
        filter: `BusinessPartner eq '${escapeODataString(soldToParty)}'`,
        top: 1,
      }),
      this.client.collection('API_BUSINESS_PARTNER', 'A_BusinessPartnerAddress', {
        filter: `BusinessPartner eq '${escapeODataString(soldToParty)}'`,
      }),
      this.client.functionImport('API_BILLING_DOCUMENT_SRV', 'GetPDF', {
        BillingDocument: id,
      }),
    ]);

    const phoneRows = await this.readPhones(addresses);
    const phone = choosePhone(phoneRows);
    if (!phone) throw new Error(`No WhatsApp phone number is available for SAP customer ${soldToParty}`);
    const normalizedPhone = normalizeIndianPhone(
      text(phone.InternationalPhoneNumber) || text(phone.PhoneNumber),
    );
    if (!/^[1-9]\d{7,14}$/.test(normalizedPhone)) {
      throw new Error(`SAP customer ${soldToParty} has an invalid WhatsApp phone number`);
    }

    const businessPartner = partners[0] ?? {};
    const pdf = extractPdf(pdfPayload);
    const totalNet = number(header.TotalNetAmount);
    const totalGross = number(header.TotalGrossAmount, totalNet);
    const totalTax = number(header.TotalTaxAmount, totalGross - totalNet);
    const creationDateTime = combineSapDateAndTime(header.CreationDate, header.CreationTime);

    return {
      fixtureId: id,
      fixtureLabel: `SAP invoice ${id}`,
      billingDocument: id,
      billingDocumentType: text(header.BillingDocumentType),
      ...(text(header.BillingDocumentCategory)
        ? { billingDocumentCategory: text(header.BillingDocumentCategory) }
        : {}),
      billingDocumentDate: sapDateOnly(header.BillingDocumentDate),
      ...(creationDateTime ? { creationDateTime } : {}),
      ...(sapDateTime(header.LastChangeDateTime)
        ? { lastChangedAt: sapDateTime(header.LastChangeDateTime) }
        : {}),
      customer: {
        businessPartnerId: soldToParty,
        customerNumber: soldToParty,
        displayName:
          text(businessPartner.BusinessPartnerFullName) ||
          text(businessPartner.BusinessPartnerName) ||
          text(businessPartner.OrganizationBPName1) ||
          soldToParty,
        ...(text(businessPartner.OrganizationBPName1)
          ? { legalName: text(businessPartner.OrganizationBPName1) }
          : {}),
        ...(text(businessPartner.Country)
          ? { countryCode: text(businessPartner.Country) }
          : {}),
        currency: text(header.TransactionCurrency),
        rawData: businessPartner,
      },
      contact: {
        originalValue: text(phone.PhoneNumber) || text(phone.InternationalPhoneNumber),
        normalizedValue: normalizedPhone,
        isPrimary: boolean(phone.IsDefaultPhoneNumber),
        isVerified: false,
        rawData: phone,
      },
      ...(text(header.SalesOrganization) ? { salesOrganization: text(header.SalesOrganization) } : {}),
      ...(text(header.DistributionChannel) ? { distributionChannel: text(header.DistributionChannel) } : {}),
      ...(text(header.Division) ? { division: text(header.Division) } : {}),
      currency: text(header.TransactionCurrency),
      totalNetAmount: totalNet,
      totalTaxAmount: totalTax,
      totalGrossAmount: totalGross,
      ...(text(header.AccountingPostingStatus)
        ? { accountingPostingStatus: text(header.AccountingPostingStatus) }
        : {}),
      ...(text(header.OverallBillingStatus)
        ? { overallBillingStatus: text(header.OverallBillingStatus) }
        : {}),
      isCancelled:
        Boolean(text(header.CancelledBillingDocument)) ||
        boolean(header.BillingDocumentIsCancelled),
      items: items.map(normalizeItem),
      pdf: {
        fileName: `Invoice-${id}.pdf`,
        mimeType: 'application/pdf',
        base64: pdf,
      },
      rawData: {
        billingDocument: header,
        billingDocumentItems: items,
        businessPartner,
        addresses,
        selectedPhone: phone,
      },
    };
  }

  private async readPhones(addresses: ODataRecord[]): Promise<ODataRecord[]> {
    const addressIds = [...new Set(addresses.map((row) => text(row.AddressID)).filter(Boolean))];
    if (addressIds.length === 0) return [];
    const filter = addressIds
      .map((addressId) => `AddressID eq '${escapeODataString(addressId)}'`)
      .join(' or ');
    return this.client.collection('API_BUSINESS_PARTNER', 'A_AddressPhoneNumber', {
      filter: `(${filter})`,
    });
  }
}

function isEligibleHeader(row: ODataRecord): boolean {
  const customer = text(row.SoldToParty);
  const creationDate = sapDateOnly(row.CreationDate);
  return Boolean(
    text(row.BillingDocument) &&
      sapAllowedCustomers.has(customer) &&
      creationDate >= env.SAP_POLL_START_DATE,
  );
}

function choosePhone(rows: ODataRecord[]): ODataRecord | undefined {
  return [...rows]
    .filter((row) => text(row.PhoneNumber) || text(row.InternationalPhoneNumber))
    .sort((left, right) => {
      const defaultDifference = Number(boolean(right.IsDefaultPhoneNumber)) - Number(boolean(left.IsDefaultPhoneNumber));
      if (defaultDifference) return defaultDifference;
      return text(left.OrdinalNumber).localeCompare(text(right.OrdinalNumber), undefined, { numeric: true });
    })[0];
}

function normalizeItem(item: ODataRecord): InvoiceCandidate['items'][number] {
  return {
    itemNumber: text(item.BillingDocumentItem),
    ...(text(item.Material) || text(item.Product)
      ? { productId: text(item.Material) || text(item.Product) }
      : {}),
    ...(text(item.BillingDocumentItemText)
      ? { description: text(item.BillingDocumentItemText) }
      : {}),
    ...(text(item.BillingQuantity)
      ? { quantity: number(item.BillingQuantity) }
      : {}),
    ...(text(item.BillingQuantityUnit)
      ? { quantityUnit: text(item.BillingQuantityUnit) }
      : {}),
    ...(text(item.NetAmount) ? { netAmount: number(item.NetAmount) } : {}),
    ...(text(item.TaxAmount) ? { taxAmount: number(item.TaxAmount) } : {}),
    ...(text(item.TransactionCurrency)
      ? { currency: text(item.TransactionCurrency) }
      : {}),
    rawData: item,
  };
}

function extractPdf(payload: ODataRecord): string {
  const root = isRecord(payload.d) ? payload.d : {};
  const result = isRecord(root.GetPDF) ? root.GetPDF : root;
  const base64 = text(result.BillingDocumentBinary);
  const bytes = Buffer.from(base64, 'base64');
  if (!base64 || !bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    throw new Error('SAP invoice PDF is not ready or is invalid');
  }
  return base64;
}

export function normalizeIndianPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(1);
  return digits;
}

export function sapDateOnly(value: unknown): string {
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 10);
  const raw = text(value);
  const odata = raw.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (odata?.[1]) return new Date(Number(odata[1])).toISOString().slice(0, 10);
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso?.[1] ?? '';
}

export function sapDateTime(value: unknown): string {
  if (typeof value === 'number') return new Date(value).toISOString();
  const raw = text(value);
  if (!raw) return '';
  const odata = raw.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (odata?.[1]) return new Date(Number(odata[1])).toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

export function combineSapDateAndTime(dateValue: unknown, timeValue: unknown): string {
  const date = sapDateOnly(dateValue);
  if (!date) return '';
  const time = text(timeValue).match(/^PT(\d+)H(\d+)M(\d+(?:\.\d+)?)S$/);
  if (!time) return `${date}T00:00:00.000Z`;
  const hours = String(Number(time[1])).padStart(2, '0');
  const minutes = String(Number(time[2])).padStart(2, '0');
  const seconds = String(Math.floor(Number(time[3]))).padStart(2, '0');
  return `${date}T${hours}:${minutes}:${seconds}.000Z`;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value: unknown): boolean {
  return value === true || text(value).toLowerCase() === 'true' || text(value) === 'X';
}
