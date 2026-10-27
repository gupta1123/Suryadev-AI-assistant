import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, { DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-only' });
const { countRemindersByCase } = await import('./repository.js');

it('counts only the current cycle of each journey, as the reminder cap does', () => {
  const job = (caseId: number, cycle?: string) => ({ payment_follow_up_case_id: caseId, metadata: cycle ? { payment_test_cycle_id: cycle } : {} });
  const counts = countRemindersByCase(
    [job(1, 'manual-journey-1'), job(1, 'manual-journey-1'), job(1, 'old-run'), job(2, 'manual-journey-2')],
    new Map([[1, 'manual-journey-1'], [2, 'manual-journey-2'], [3, 'manual-journey-3']]),
  );
  assert.equal(counts.get(1), 2);
  assert.equal(counts.get(2), 1);
  assert.equal(counts.get(3), undefined);
});
