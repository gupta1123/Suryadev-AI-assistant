import { env, isSapConfigured } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { SapODataClient, type ODataRecord } from '../invoice-delivery/sap-client.js';
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
const MAX_ROWS = 10_000;
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
  const assignments = new Map<string, SapSalesAssignment[]>();
  for (const area of salesAreas) {
    const salesGroup = text(area.SalesGroup);
    const salesOffice = text(area.SalesOffice);
    // SAP can maintain both 8 and 08. Only combine equivalent keys when the
    // office matches; conflicting mobile numbers must never be silently picked.
    const matches = salesGroup ? managers.rows.filter((manager) =>
      groupKey(text(manager.SalesGroupid)) === groupKey(salesGroup) && text(manager.SalesOffice) === salesOffice) : [];
    const numbers = [...new Set(matches.map((manager) => normalizeIndianPhone(text(manager.MobileNo))).filter(Boolean))];
    const assignment: SapSalesAssignment = {
      salesOrganization: text(area.SalesOrganization), distributionChannel: text(area.DistributionChannel), division: text(area.Division),
      salesGroup, salesOffice,
      marketingManagerPhone: managers.available && numbers.length === 1 ? numbers[0]! : null,
      managerStatus: !managers.available ? 'unavailable' : numbers.length > 1 ? 'conflicting' : numbers.length === 1 ? 'mapped' : 'missing',
    };
    const customer = text(area.Customer);
    assignments.set(customer, [...(assignments.get(customer) ?? []), assignment]);
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

export async function getSapMasterCustomers(refresh = false) {
  if (!isSapConfigured) throw new HttpError(409, 'SAP API connection is not configured');
  if (!inFlight && (refresh || !cache || Date.now() - cache.loadedAt >= CACHE_MS)) {
    const customerClient = new SapODataClient();
    // Reuse the approved SAP host, but never replace the working billing login.
    const managerClient = env.SAP_SALES_GROUP_API_USERNAME && env.SAP_SALES_GROUP_API_PASSWORD
      ? new SapODataClient(env.SAP_API_BASE_URL, env.SAP_SALES_GROUP_API_USERNAME, env.SAP_SALES_GROUP_API_PASSWORD)
      : customerClient;
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
