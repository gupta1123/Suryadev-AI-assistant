import { env, isSapConfigured } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { escapeODataString, SapODataClient, type ODataRecord } from '../invoice-delivery/sap-client.js';
import { choosePhone } from '../invoice-delivery/sap-source.js';
import { normalizeIndianPhone } from '../invoice-delivery/fixture-source.js';

type Client = Pick<SapODataClient, 'collection'>;
export type SapSalesAssignment = {
  salesOrganization: string; distributionChannel: string; division: string;
  salesGroup: string; salesOffice: string;
  marketingManagerPhone: string | null;
  managerStatus: 'mapped' | 'missing' | 'unavailable' | 'conflicting';
};
export type SapMasterCustomer = {
  customerNumber: string;
  name: string;
  primaryPhone: string | null;
  phones: { number: string; isDefault: boolean }[];
  salesAssignments: SapSalesAssignment[];
};
type Directory = { items: SapMasterCustomer[]; managerMappingAvailable: boolean };
const CACHE_MS = 5 * 60_000;
const MAX_ROWS = 50_000;

/** Fresh, targeted check for already queued SAP messages; never use directory cache. */
export async function readCurrentSapPrimaryPhone(customerNumber: string): Promise<string | null> {
  if (!isSapConfigured) throw new Error('SAP verification is unavailable');
  const client = new SapODataClient();
  const [customers, addresses] = await Promise.all([
    client.collection('API_BUSINESS_PARTNER', 'A_Customer', { filter: `Customer eq '${escapeODataString(customerNumber)}'`, select: ['Customer'], top: 1 }),
    client.collection('API_BUSINESS_PARTNER', 'A_BusinessPartnerAddress', { filter: `BusinessPartner eq '${escapeODataString(customerNumber)}'`, select: ['AddressID'], top: MAX_ROWS }),
  ]);
  if (!customers.length || !addresses.length || addresses.length >= MAX_ROWS) return null;
  const filter = addresses.map(row => `AddressID eq '${escapeODataString(text(row.AddressID))}'`).join(' or ');
  const phones = await client.collection('API_BUSINESS_PARTNER', 'A_AddressPhoneNumber', { filter: `(${filter})`, top: MAX_ROWS });
  if (phones.length >= MAX_ROWS) throw new Error('SAP phone verification returned a partial result');
  const phone = choosePhone(phones);
  return phone ? normalizeIndianPhone(text(phone.InternationalPhoneNumber) || text(phone.PhoneNumber)) || null : null;
}
let cache: (Directory & { checkedAt: string; loadedAt: number }) | undefined;
let inFlight: Promise<NonNullable<typeof cache>> | undefined;

export async function readSapMasterCustomers(client: Client, managerClient: Client = client): Promise<Directory> {
  // This custom service needs its own SAP authorization. Its failure must not hide
  // the customer directory, or be mistaken for a customer with no assigned manager.
  const managerRead = managerClient.collection('YY1_SALESGROUP_CDS', 'YY1_SALESGROUP', {
    select: ['SalesGroupid', 'SalesOffice', 'MobileNo'], top: MAX_ROWS,
  }).then((rows) => ({ rows, available: rows.length < MAX_ROWS }))
    .catch(() => ({ rows: [] as ODataRecord[], available: false }));
  const [customers, addresses, phones, salesAreas, managers] = await Promise.all([
    client.collection('API_BUSINESS_PARTNER', 'A_Customer', {
      select: ['Customer', 'CustomerFullName', 'CustomerName'], top: MAX_ROWS,
    }),
    client.collection('API_BUSINESS_PARTNER', 'A_BusinessPartnerAddress', {
      select: ['BusinessPartner', 'AddressID'], top: MAX_ROWS,
    }),
    client.collection('API_BUSINESS_PARTNER', 'A_AddressPhoneNumber', {
      select: ['AddressID', 'OrdinalNumber', 'IsDefaultPhoneNumber', 'PhoneNumber', 'InternationalPhoneNumber'], top: MAX_ROWS,
    }),
    client.collection('API_BUSINESS_PARTNER', 'A_CustomerSalesArea', {
      select: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'SalesGroup', 'SalesOffice'], top: MAX_ROWS,
    }),
    managerRead,
  ]);
  // Never present an explicitly capped SAP result as the complete master list.
  if ([customers, addresses, phones, salesAreas].some((rows) => rows.length >= MAX_ROWS)) {
    throw new HttpError(502, 'SAP master directory exceeds the supported size; no partial list is displayed');
  }
  const assignments = joinSalesAssignments(salesAreas, managers.rows, managers.available);
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
  const items = customers.map((customer) => {
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
      salesAssignments: (assignments.get(customerNumber) ?? []).sort((a, b) =>
        `${a.salesOrganization}/${a.distributionChannel}/${a.division}`.localeCompare(`${b.salesOrganization}/${b.distributionChannel}/${b.division}`)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.customerNumber.localeCompare(b.customerNumber));
  return { items, managerMappingAvailable: managers.available };
}

function joinSalesAssignments(salesAreas: ODataRecord[], managers: ODataRecord[], available: boolean) {
  const assignments = new Map<string, SapSalesAssignment[]>();
  for (const area of salesAreas) {
    const salesGroup = text(area.SalesGroup);
    const salesOffice = text(area.SalesOffice);
    // SAP can maintain both 8 and 08. Only combine equivalent keys when the
    // office matches; conflicting mobile numbers must never be silently picked.
    const matches = salesGroup ? managers.filter((manager) =>
      groupKey(text(manager.SalesGroupid)) === groupKey(salesGroup) && text(manager.SalesOffice) === salesOffice) : [];
    const numbers = [...new Set(matches.map((manager) => normalizeIndianPhone(text(manager.MobileNo))).filter(Boolean))];
    const assignment: SapSalesAssignment = {
      salesOrganization: text(area.SalesOrganization), distributionChannel: text(area.DistributionChannel), division: text(area.Division),
      salesGroup, salesOffice,
      marketingManagerPhone: available && numbers.length === 1 ? numbers[0]! : null,
      managerStatus: !available ? 'unavailable' : numbers.length > 1 ? 'conflicting' : numbers.length === 1 ? 'mapped' : 'missing',
    };
    const customer = text(area.Customer);
    assignments.set(customer, [...(assignments.get(customer) ?? []), assignment]);
  }
  return assignments;
}

function salesGroupClient(customerClient: SapODataClient): SapODataClient {
  return env.SAP_SALES_GROUP_API_USERNAME && env.SAP_SALES_GROUP_API_PASSWORD
    ? new SapODataClient(env.SAP_API_BASE_URL, env.SAP_SALES_GROUP_API_USERNAME, env.SAP_SALES_GROUP_API_PASSWORD)
    : customerClient;
}

// Read just this customer's sales areas at queue/dispatch time, not the full
// 1,620-customer directory or its cached contact list. Always fail closed.
export async function readCurrentSapManagerAssignments(customerNumber: string): Promise<SapSalesAssignment[]> {
  if (!isSapConfigured) throw new HttpError(409, 'SAP API connection is not configured');
  const customerClient = new SapODataClient();
  const [areas, managers] = await Promise.all([
    customerClient.collection('API_BUSINESS_PARTNER', 'A_CustomerSalesArea', {
      filter: `Customer eq '${escapeODataString(customerNumber)}'`,
      select: ['Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'SalesGroup', 'SalesOffice'], top: MAX_ROWS,
    }),
    salesGroupClient(customerClient).collection('YY1_SALESGROUP_CDS', 'YY1_SALESGROUP', {
      select: ['SalesGroupid', 'SalesOffice', 'MobileNo'], top: MAX_ROWS,
    }),
  ]);
  if ([areas, managers].some((rows) => rows.length >= MAX_ROWS)) throw new Error('SAP manager lookup returned a capped result');
  return joinSalesAssignments(areas, managers, true).get(customerNumber) ?? [];
}

export async function getSapMasterCustomers(refresh = false) {
  if (!isSapConfigured) throw new HttpError(409, 'SAP API connection is not configured');
  if (!inFlight && (refresh || !cache || Date.now() - cache.loadedAt >= CACHE_MS)) {
    const customerClient = new SapODataClient();
    // Reuse the approved SAP host, but never replace the working billing login.
    const managerClient = salesGroupClient(customerClient);
    inFlight = readSapMasterCustomers(customerClient, managerClient).then((directory) => {
      cache = { ...directory, checkedAt: new Date().toISOString(), loadedAt: Date.now() };
      return cache;
    }).finally(() => { inFlight = undefined; });
  }
  const result = inFlight ? await inFlight : cache!;
  return { items: result.items, managerMappingAvailable: result.managerMappingAvailable, checkedAt: result.checkedAt, source: 'sap' as const };
}

function text(value: unknown): string { return value == null ? '' : String(value).trim(); }
function groupKey(value: string): string { return /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value; }
