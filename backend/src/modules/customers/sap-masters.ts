import { isSapConfigured } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { SapODataClient, type ODataRecord } from '../invoice-delivery/sap-client.js';
import { choosePhone } from '../invoice-delivery/sap-source.js';
import { normalizeIndianPhone } from '../invoice-delivery/fixture-source.js';

type Client = Pick<SapODataClient, 'collection'>;
export type SapMasterCustomer = {
  customerNumber: string;
  name: string;
  primaryPhone: string | null;
  phones: { number: string; isDefault: boolean }[];
};
const CACHE_MS = 5 * 60_000;
const MAX_ROWS = 10_000;
let cache: { items: SapMasterCustomer[]; checkedAt: string; loadedAt: number } | undefined;
let inFlight: Promise<NonNullable<typeof cache>> | undefined;

export async function readSapMasterCustomers(client: Client): Promise<SapMasterCustomer[]> {
  const [customers, addresses, phones] = await Promise.all([
    client.collection('API_BUSINESS_PARTNER', 'A_Customer', {
      select: ['Customer', 'CustomerFullName', 'CustomerName'], top: MAX_ROWS,
    }),
    client.collection('API_BUSINESS_PARTNER', 'A_BusinessPartnerAddress', {
      select: ['BusinessPartner', 'AddressID'], top: MAX_ROWS,
    }),
    client.collection('API_BUSINESS_PARTNER', 'A_AddressPhoneNumber', {
      select: ['AddressID', 'OrdinalNumber', 'IsDefaultPhoneNumber', 'PhoneNumber', 'InternationalPhoneNumber'], top: MAX_ROWS,
    }),
  ]);
  // Never present an explicitly capped SAP result as the complete master list.
  if ([customers, addresses, phones].some((rows) => rows.length >= MAX_ROWS)) {
    throw new HttpError(502, 'SAP master directory exceeds the supported size; no partial list is displayed');
  }
  const byAddress = new Map<string, ODataRecord[]>();
  for (const phone of phones) {
    const id = text(phone.AddressID);
    byAddress.set(id, [...(byAddress.get(id) ?? []), phone]);
  }
  const byCustomer = new Map<string, ODataRecord[]>();
  for (const address of addresses) {
    const id = text(address.BusinessPartner);
    byCustomer.set(id, [...(byCustomer.get(id) ?? []), ...(byAddress.get(text(address.AddressID)) ?? [])]);
  }
  return customers.map((customer) => {
    const customerNumber = text(customer.Customer);
    const rows = byCustomer.get(customerNumber) ?? [];
    const selected = choosePhone(rows);
    const unique = new Map<string, boolean>();
    for (const row of rows) {
      const number = normalizeIndianPhone(text(row.InternationalPhoneNumber) || text(row.PhoneNumber));
      if (number) unique.set(number, Boolean(unique.get(number)) || row.IsDefaultPhoneNumber === true || row.IsDefaultPhoneNumber === 'true');
    }
    return {
      customerNumber,
      name: text(customer.CustomerFullName) || text(customer.CustomerName) || customerNumber,
      primaryPhone: selected ? normalizeIndianPhone(text(selected.InternationalPhoneNumber) || text(selected.PhoneNumber)) || null : null,
      phones: [...unique].map(([number, isDefault]) => ({ number, isDefault })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.customerNumber.localeCompare(b.customerNumber));
}

export async function getSapMasterCustomers(refresh = false) {
  if (!isSapConfigured) throw new HttpError(409, 'SAP API connection is not configured');
  if (!inFlight && (refresh || !cache || Date.now() - cache.loadedAt >= CACHE_MS)) {
    inFlight = readSapMasterCustomers(new SapODataClient()).then((items) => {
      cache = { items, checkedAt: new Date().toISOString(), loadedAt: Date.now() };
      return cache;
    }).finally(() => { inFlight = undefined; });
  }
  const result = inFlight ? await inFlight : cache!;
  return { items: result.items, checkedAt: result.checkedAt, source: 'sap' as const };
}

function text(value: unknown): string { return value == null ? '' : String(value).trim(); }
