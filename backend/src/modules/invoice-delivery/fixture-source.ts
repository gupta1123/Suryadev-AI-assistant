import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../../config/env.js';
import type { InvoiceCandidate } from './domain.js';
import {
  sapInvoiceFixtureSchema,
  type SapInvoiceFixture,
} from './fixture-schema.js';
import type { InvoiceSource, InvoiceSourceSummary } from './invoice-source.js';

export class FixtureInvoiceSource implements InvoiceSource {
  constructor(private readonly directory = resolve(env.FIXTURE_DIRECTORY)) {}

  async list(): Promise<InvoiceSourceSummary[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const fixture = await this.readFixture(entry.name.replace(/\.json$/, ''));
          const candidate = normalizeFixture(fixture);
          return {
            id: candidate.fixtureId,
            label: candidate.fixtureLabel,
            billingDocument: candidate.billingDocument,
            customerName: candidate.customer.displayName,
            amount: candidate.totalGrossAmount,
            currency: candidate.currency,
          };
        }),
    );

    return summaries.sort((left, right) => left.billingDocument.localeCompare(right.billingDocument));
  }

  async get(id: string): Promise<InvoiceCandidate> {
    return normalizeFixture(await this.readFixture(id));
  }

  async getRaw(id: string): Promise<SapInvoiceFixture> {
    return this.readFixture(id);
  }

  private async readFixture(id: string): Promise<SapInvoiceFixture> {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
      throw new Error('Invalid fixture identifier');
    }
    const raw = await readFile(resolve(this.directory, `${id}.json`), 'utf8');
    return sapInvoiceFixtureSchema.parse(JSON.parse(raw) as unknown);
  }
}

export function normalizeFixture(fixture: SapInvoiceFixture): InvoiceCandidate {
  const billing = requiredFirst(
    fixture.responses.billingDocument.d.results,
    'billing document',
  );
  const businessPartner = requiredFirst(
    fixture.responses.businessPartner.d.results,
    'business partner',
  );
  const phone = requiredFirst(fixture.responses.phoneNumbers.d.results, 'phone number');
  const pdf = fixture.responses.getPdf.d;

  if (billing.BillingDocument !== pdf.BillingDocument) {
    throw new Error('Fixture PDF does not belong to the billing document');
  }

  const totalNet = toNumber(billing.TotalNetAmount);
  const totalTax = toNumber(billing.TotalTaxAmount);

  return {
    fixtureId: fixture.fixtureId,
    fixtureLabel: fixture.label,
    billingDocument: billing.BillingDocument,
    billingDocumentType: billing.BillingDocumentType,
    ...(billing.BillingDocumentCategory
      ? { billingDocumentCategory: billing.BillingDocumentCategory }
      : {}),
    billingDocumentDate: toDateOnly(billing.BillingDocumentDate),
    ...(billing.CreationDateTime
      ? { creationDateTime: toDateTime(billing.CreationDateTime) }
      : {}),
    ...(billing.LastChangeDateTime
      ? { lastChangedAt: toDateTime(billing.LastChangeDateTime) }
      : {}),
    customer: {
      businessPartnerId: businessPartner.BusinessPartner,
      customerNumber: businessPartner.Customer ?? billing.SoldToParty,
      displayName:
        businessPartner.BusinessPartnerFullName ??
        businessPartner.BusinessPartnerName ??
        businessPartner.OrganizationBPName1 ??
        billing.SoldToParty,
      ...(businessPartner.OrganizationBPName1
        ? { legalName: businessPartner.OrganizationBPName1 }
        : {}),
      ...(businessPartner.Country ? { countryCode: businessPartner.Country } : {}),
      currency: billing.TransactionCurrency,
      rawData: businessPartner,
    },
    contact: {
      originalValue: phone.PhoneNumber,
      normalizedValue: normalizeIndianPhone(phone.PhoneNumber),
      isPrimary: phone.IsDefaultPhoneNumber ?? true,
      isVerified: false,
      rawData: phone,
    },
    ...(billing.SalesOrganization ? { salesOrganization: billing.SalesOrganization } : {}),
    ...(billing.DistributionChannel
      ? { distributionChannel: billing.DistributionChannel }
      : {}),
    ...(billing.Division ? { division: billing.Division } : {}),
    currency: billing.TransactionCurrency,
    totalNetAmount: totalNet,
    totalTaxAmount: totalTax,
    totalGrossAmount:
      billing.TotalGrossAmount === undefined
        ? totalNet + totalTax
        : toNumber(billing.TotalGrossAmount),
    ...(billing.AccountingPostingStatus
      ? { accountingPostingStatus: billing.AccountingPostingStatus }
      : {}),
    ...(billing.OverallBillingStatus
      ? { overallBillingStatus: billing.OverallBillingStatus }
      : {}),
    isCancelled: Boolean(billing.CancelledBillingDocument),
    items: fixture.responses.billingDocumentItems.d.results.map((item) => ({
      itemNumber: item.BillingDocumentItem,
      ...(item.Material ? { productId: item.Material } : {}),
      ...(item.BillingDocumentItemText ? { description: item.BillingDocumentItemText } : {}),
      ...(item.BillingQuantity === undefined
        ? {}
        : { quantity: toNumber(item.BillingQuantity) }),
      ...(item.BillingQuantityUnit ? { quantityUnit: item.BillingQuantityUnit } : {}),
      ...(item.NetAmount === undefined ? {} : { netAmount: toNumber(item.NetAmount) }),
      ...(item.TaxAmount === undefined ? {} : { taxAmount: toNumber(item.TaxAmount) }),
      ...(item.TransactionCurrency ? { currency: item.TransactionCurrency } : {}),
      rawData: item,
    })),
    pdf: {
      fileName: pdf.FileName,
      mimeType: pdf.MimeType,
      base64: pdf.BillingDocumentBinary,
    },
    rawData: fixture.responses,
  };
}

function requiredFirst<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Fixture is missing ${label} data`);
  return row;
}

function toNumber(value: string | number): number {
  const result = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid SAP numeric value: ${value}`);
  return result;
}

function toDateOnly(value: string | number): string {
  return toDate(value).toISOString().slice(0, 10);
}

function toDateTime(value: string | number): string {
  return toDate(value).toISOString();
}

function toDate(value: string | number): Date {
  const sapTimestamp = typeof value === 'string' ? value.match(/^\/Date\((\d+)/)?.[1] : undefined;
  const date = new Date(sapTimestamp ? Number(sapTimestamp) : value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid SAP date value: ${value}`);
  return date;
}

export function normalizeIndianPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}
