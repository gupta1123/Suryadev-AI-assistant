export type DummyInvoicePdfInput = {
  invoiceNumber: string;
  invoiceDate: string;
  customerName: string;
  amount: number;
  currency: string;
};

export function generateDummyInvoicePdf(input: DummyInvoicePdfInput): string {
  const content = [
    'BT',
    '/F1 22 Tf',
    '72 710 Td',
    '(SURYADEV TEST INVOICE) Tj',
    '/F1 12 Tf',
    '0 -42 Td',
    `(${escapePdfText(`Invoice: ${input.invoiceNumber}`)}) Tj`,
    '0 -22 Td',
    `(${escapePdfText(`Invoice date: ${input.invoiceDate}`)}) Tj`,
    '0 -22 Td',
    `(${escapePdfText(`Customer: ${input.customerName}`)}) Tj`,
    '0 -22 Td',
    `(${escapePdfText(`Amount: ${input.currency} ${input.amount.toFixed(2)}`)}) Tj`,
    '0 -42 Td',
    '(SIMULATED SAP DATA - NOT A COMMERCIAL DOCUMENT) Tj',
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf).toString('base64');
}

function escapePdfText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/([\\()])/g, '\\$1');
}
