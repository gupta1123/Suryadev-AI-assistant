import { env } from '../../config/env.js';

export type ODataRecord = Record<string, unknown>;

export class SapODataClient {
  private readonly authorization: string;

  constructor(
    private readonly apiBaseUrl = env.SAP_API_BASE_URL ?? '',
    username = env.SAP_API_USERNAME ?? '',
    password = env.SAP_API_PASSWORD ?? '',
  ) {
    if (!apiBaseUrl || !username || !password) {
      throw new Error('SAP read-only API credentials are not configured');
    }
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  async collection(
    service: string,
    entitySet: string,
    options: { filter?: string; orderBy?: string; select?: string[]; top?: number } = {},
  ): Promise<ODataRecord[]> {
    const url = this.serviceUrl(service, entitySet);
    url.searchParams.set('$format', 'json');
    url.searchParams.set('$top', String(options.top ?? 5000));
    if (options.filter) url.searchParams.set('$filter', options.filter);
    if (options.orderBy) url.searchParams.set('$orderby', options.orderBy);
    if (options.select?.length) url.searchParams.set('$select', options.select.join(','));

    const rows: ODataRecord[] = [];
    let nextUrl = url.toString();
    while (nextUrl) {
      const payload = await this.getJson(nextUrl);
      const page = isRecord(payload.d) && Array.isArray(payload.d.results)
        ? payload.d.results.filter(isRecord)
        : [];
      rows.push(...page);
      nextUrl = isRecord(payload.d) && typeof payload.d.__next === 'string'
        ? payload.d.__next
        : '';
    }
    return rows;
  }

  async functionImport(
    service: string,
    functionName: string,
    parameters: Record<string, string>,
  ): Promise<ODataRecord> {
    const url = this.serviceUrl(service, functionName);
    url.searchParams.set('$format', 'json');
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, `'${escapeODataString(value)}'`);
    }
    return this.getJson(url.toString());
  }

  private serviceUrl(service: string, resource: string): URL {
    const base = this.apiBaseUrl.replace(/\/$/, '');
    return new URL(`${base}/${service}/${resource}`);
  }

  private async getJson(url: string): Promise<ODataRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.SAP_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: this.authorization,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text.slice(0, 1000) };
      }
      if (!response.ok) {
        throw new Error(`SAP read request failed with HTTP ${response.status}: ${sapErrorMessage(body)}`);
      }
      if (!isRecord(body)) throw new Error('SAP returned an invalid JSON response');
      return body;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('SAP read request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function escapeODataString(value: string): string {
  return value.replaceAll("'", "''");
}

function sapErrorMessage(body: unknown): string {
  if (!isRecord(body)) return 'Unknown SAP error';
  const error = isRecord(body.error) ? body.error : undefined;
  const message = error && isRecord(error.message) ? error.message.value : undefined;
  return typeof message === 'string' && message ? message : 'Unknown SAP error';
}

export function isRecord(value: unknown): value is ODataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
