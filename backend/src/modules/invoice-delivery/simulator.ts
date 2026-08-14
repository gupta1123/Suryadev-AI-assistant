import type { InvoiceCandidate } from './domain.js';
import { FixtureInvoiceSource, normalizeFixture } from './fixture-source.js';
import type { SapInvoiceFixture } from './fixture-schema.js';
import { sapInvoiceFixtureSchema } from './fixture-schema.js';
import { generateDummyInvoicePdf } from './pdf-generator.js';

const BASE_FIXTURE_ID = 'sap-invoice-0090000001';
let lastSimulationNumber = 0n;

export class InvoiceSimulator {
  constructor(private readonly fixtures = new FixtureInvoiceSource()) {}

  async create(now = new Date()): Promise<InvoiceCandidate> {
    const base = await this.fixtures.getRaw(BASE_FIXTURE_ID);
    return normalizeFixture(createSimulatedSapFixture(base, now));
  }
}

export function createSimulatedSapFixture(
  baseFixture: SapInvoiceFixture,
  now = new Date(),
): SapInvoiceFixture {
  const fixture = structuredClone(baseFixture);
  const billingDocument = nextBillingDocument(now);
  const invoiceDate = dateInIndia(now);
  const midnightUtc = Date.parse(`${invoiceDate}T00:00:00Z`);
  const billing = fixture.responses.billingDocument.d.results[0];
  const partner = fixture.responses.businessPartner.d.results[0];
  if (!billing || !partner) throw new Error('Simulation base fixture is incomplete');

  fixture.fixtureId = `simulated-invoice-${billingDocument}`;
  fixture.label = `Simulated SAP invoice ${billingDocument}`;
  billing.BillingDocument = billingDocument;
  billing.BillingDocumentDate = `/Date(${midnightUtc})/`;
  billing.CreationDateTime = now.toISOString();
  billing.LastChangeDateTime = now.toISOString();

  for (const item of fixture.responses.billingDocumentItems.d.results) {
    item.BillingDocument = billingDocument;
  }
  for (const billingPartner of fixture.responses.billingDocumentPartners.d.results) {
    billingPartner.BillingDocument = billingDocument;
  }

  const pdf = fixture.responses.getPdf.d;
  pdf.BillingDocument = billingDocument;
  pdf.FileName = `TEST-Invoice-${billingDocument}.pdf`;
  pdf.BillingDocumentBinary = generateDummyInvoicePdf({
    invoiceNumber: billingDocument,
    invoiceDate,
    customerName:
      partner.BusinessPartnerFullName ??
      partner.BusinessPartnerName ??
      partner.OrganizationBPName1 ??
      billing.SoldToParty,
    amount: Number(billing.TotalGrossAmount ?? billing.TotalNetAmount),
    currency: billing.TransactionCurrency,
  });

  return sapInvoiceFixtureSchema.parse(fixture);
}

export function dateInIndia(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function nextBillingDocument(now: Date): string {
  const clockValue = BigInt(now.getTime()) % 10_000_000_000n;
  const next = clockValue > lastSimulationNumber
    ? clockValue
    : (lastSimulationNumber + 1n) % 10_000_000_000n;
  lastSimulationNumber = next;
  return next.toString().padStart(10, '0');
}
