import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

// env.ts reads the environment once when it is loaded, so each case runs in its own process.
const BASE = {
  DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-only',
  NODE_ENV: 'production', DELIVERY_MODE: 'production', ALLOW_PRODUCTION_DELIVERY: 'true',
  PAYMENT_FOLLOW_UP_ENABLED: 'true', PAYMENT_FOLLOW_UP_SEND_ENABLED: 'true', MSG91_SEND_ENABLED: 'true',
  PAYMENT_JOURNEY_MODE: 'manual', PAYMENT_PRODUCTION_ENABLED: 'true',
};

function gate(change: Record<string, string>) {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e',
    "import('./src/config/env.ts').then(m=>console.log(JSON.stringify({configured:m.isPaymentFollowUpSchedulerConfigured,production:m.isPaymentManualProductionAllowed})))"],
  { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...BASE, ...change }, cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop()!) as { configured: boolean; production: boolean };
}

it('production payment journeys are closed until PAYMENT_PRODUCTION_ENABLED is set', () => {
  assert.deepEqual(gate({ PAYMENT_PRODUCTION_ENABLED: 'false' }), { configured: false, production: false });
});

it('they open only when every condition holds', () => {
  assert.deepEqual(gate({}), { configured: true, production: true });
  const cases: Array<Record<string, string>> = [{ MSG91_SEND_ENABLED: 'false' }, { PAYMENT_FOLLOW_UP_SEND_ENABLED: 'false' }, { PAYMENT_FOLLOW_UP_ENABLED: 'false' }, { PAYMENT_JOURNEY_MODE: 'legacy_test' }];
  for (const off of cases) {
    assert.deepEqual(gate(off), { configured: false, production: false }, JSON.stringify(off));
  }
});

it('the flag does nothing outside production delivery', () => {
  const result = gate({ DELIVERY_MODE: 'test', NODE_ENV: 'development' });
  assert.equal(result.production, false, 'the production gate is for the live deployment only');
});
