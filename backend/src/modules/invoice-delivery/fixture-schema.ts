import { z } from 'zod';

const billingDocumentSchema = z
  .object({
    BillingDocument: z.string().min(1),
    BillingDocumentType: z.string().min(1),
    BillingDocumentCategory: z.string().optional(),
    BillingDocumentDate: z.union([z.string(), z.number()]),
    CreationDateTime: z.union([z.string(), z.number()]).optional(),
    LastChangeDateTime: z.union([z.string(), z.number()]).optional(),
    SoldToParty: z.string().min(1),
    PayerParty: z.string().optional(),
    SalesOrganization: z.string().optional(),
    DistributionChannel: z.string().optional(),
    Division: z.string().optional(),
    TransactionCurrency: z.string().min(1),
    TotalNetAmount: z.union([z.string(), z.number()]),
    TotalTaxAmount: z.union([z.string(), z.number()]).default('0'),
    TotalGrossAmount: z.union([z.string(), z.number()]).optional(),
    AccountingPostingStatus: z.string().optional(),
    OverallBillingStatus: z.string().optional(),
    CancelledBillingDocument: z.string().optional(),
  })
  .passthrough();

const billingItemSchema = z
  .object({
    BillingDocument: z.string().min(1),
    BillingDocumentItem: z.string().min(1),
    Material: z.string().optional(),
    BillingDocumentItemText: z.string().optional(),
    BillingQuantity: z.union([z.string(), z.number()]).optional(),
    BillingQuantityUnit: z.string().optional(),
    NetAmount: z.union([z.string(), z.number()]).optional(),
    TaxAmount: z.union([z.string(), z.number()]).optional(),
    TransactionCurrency: z.string().optional(),
  })
  .passthrough();

const billingPartnerSchema = z
  .object({
    BillingDocument: z.string().min(1),
    PartnerFunction: z.string().min(1),
    Customer: z.string().min(1),
  })
  .passthrough();

const businessPartnerSchema = z
  .object({
    BusinessPartner: z.string().min(1),
    Customer: z.string().optional(),
    BusinessPartnerFullName: z.string().optional(),
    BusinessPartnerName: z.string().optional(),
    OrganizationBPName1: z.string().optional(),
    Country: z.string().optional(),
    Language: z.string().optional(),
  })
  .passthrough();

const phoneSchema = z
  .object({
    BusinessPartner: z.string().min(1),
    PhoneNumber: z.string().min(1),
    Country: z.string().optional(),
    IsDefaultPhoneNumber: z.boolean().optional(),
  })
  .passthrough();

const collection = <T extends z.ZodType>(rowSchema: T) =>
  z.object({
    d: z.object({
      results: z.array(rowSchema),
    }),
  });

export const sapInvoiceFixtureSchema = z.object({
  fixtureId: z.string().min(1),
  label: z.string().min(1),
  responses: z.object({
    billingDocument: collection(billingDocumentSchema),
    billingDocumentItems: collection(billingItemSchema),
    billingDocumentPartners: collection(billingPartnerSchema),
    businessPartner: collection(businessPartnerSchema),
    phoneNumbers: collection(phoneSchema),
    getPdf: z.object({
      d: z.object({
        BillingDocument: z.string().min(1),
        FileName: z.string().min(1),
        MimeType: z.literal('application/pdf'),
        BillingDocumentBinary: z.string().min(1),
      }),
    }),
  }),
});

export type SapInvoiceFixture = z.infer<typeof sapInvoiceFixtureSchema>;
