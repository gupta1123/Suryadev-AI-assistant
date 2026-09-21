import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FixtureInvoiceSource, normalizeFixture } from './fixture-source.js';
import { createSimulatedSapFixture, dateInIndia } from './simulator.js';

describe('invoice simulator', () => {
  it('creates a fresh SAP-shaped invoice for every click', async () => {
    const base = await new FixtureInvoiceSource().getRaw('sap-invoice-0090000001');
    const now = new Date('2026-07-28T12:34:56.789Z');
    const first = createSimulatedSapFixture(base, now);
    const second = createSimulatedSapFixture(base, now);
    const firstCandidate = normalizeFixture(first);
    const secondCandidate = normalizeFixture(second);

    assert.match(firstCandidate.billingDocument, /^\d{10}$/);
    assert.match(secondCandidate.billingDocument, /^\d{10}$/);
    assert.notEqual(firstCandidate.billingDocument, secondCandidate.billingDocument);
    assert.equal(firstCandidate.billingDocumentDate, '2026-07-28');
    assert.equal(
      first.responses.billingDocumentItems.d.results[0]?.BillingDocument,
      firstCandidate.billingDocument,
    );
    assert.equal(
      first.responses.billingDocumentPartners.d.results[0]?.BillingDocument,
      firstCandidate.billingDocument,
    );
    assert.equal(first.responses.getPdf.d.BillingDocument, firstCandidate.billingDocument);
  });

  it('generates a valid matching PDF attachment', async () => {
    const base = await new FixtureInvoiceSource().getRaw('sap-invoice-0090000001');
    const fixture = createSimulatedSapFixture(base, new Date('2026-07-28T12:34:56.789Z'));
    const candidate = normalizeFixture(fixture);
    const pdf = Buffer.from(candidate.pdf.base64, 'base64').toString('latin1');

    assert.equal(pdf.startsWith('%PDF-1.4'), true);
    assert.equal(pdf.includes(`Invoice: ${candidate.billingDocument}`), true);
    assert.equal(candidate.pdf.fileName, `TEST-Invoice-${candidate.billingDocument}.pdf`);
  });

  it('creates matching SAP-shaped PDFs for all five supported document types', async () => {
    const base = await new FixtureInvoiceSource().getRaw('sap-invoice-0090000001');
    const expected = {
      F2: ['Invoice', 'Invoice'],
      S1: ['Cancelled-Invoice', 'Cancelled invoice'],
      CBRE: ['Return-Credit-Memo', 'Return credit memo'],
      G2: ['Credit-Memo', 'Credit memo'],
      L2: ['Debit-Memo', 'Debit memo'],
    } as const;

    for (const [type, [filePrefix, documentLabel]] of Object.entries(expected)) {
      const fixture = createSimulatedSapFixture(
        base,
        new Date('2026-07-28T12:34:56.789Z'),
        undefined,
        type as keyof typeof expected,
      );
      const candidate = normalizeFixture(fixture);
      const pdf = Buffer.from(candidate.pdf.base64, 'base64').toString('latin1');

      assert.equal(candidate.billingDocumentType, type);
      assert.equal(
        candidate.pdf.fileName,
        `TEST-${filePrefix}-${candidate.billingDocument}.pdf`,
      );
      assert.equal(pdf.includes(`${documentLabel}: ${candidate.billingDocument}`), true);
    }
  });

  it('uses the current Indian business date near the UTC day boundary', () => {
    assert.equal(
      dateInIndia(new Date('2026-08-13T20:00:00.000Z')),
      '2026-08-14',
    );
  });

  it('locks the generated invoice contact to the controlled test recipient', async () => {
    const base = await new FixtureInvoiceSource().getRaw('sap-invoice-0090000001');
    const fixture = createSimulatedSapFixture(
      base,
      new Date('2026-08-27T08:00:00.000Z'),
      '917019339764',
    );
    assert.equal(normalizeFixture(fixture).contact.normalizedValue, '917019339764');
  });
});
