import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { documentDateBlocker } from './document-date-policy.js';

describe('non-overridable 20 October 2026 messaging cutoff', () => {
  const fresh = { documentDate: '2026-10-20', documentCreatedAt: '2026-10-20T12:00:00Z' };
  it('includes 20 October and later document dates', () => {
    assert.equal(documentDateBlocker(fresh), null);
    assert.equal(documentDateBlocker({ ...fresh, documentDate: '2026-10-24' }), null);
  });
  it('blocks a backdated document even if created/imported/retried today', () => {
    assert.match(documentDateBlocker({ documentDate: '2026-10-19', documentCreatedAt: '2026-10-24T12:00:00Z' })!, /dated before/);
  });
  it('uses midnight India time for timestamp boundaries', () => {
    assert.equal(documentDateBlocker({ ...fresh, documentCreatedAt: '2026-10-19T18:30:00Z' }), null);
    assert.equal(documentDateBlocker({ ...fresh, documentCreatedAt: '2026-10-20T00:00:00+05:30' }), null);
    assert.match(documentDateBlocker({ ...fresh, documentCreatedAt: '2026-10-19T18:29:59Z' })!, /created before/);
  });
  it('fails closed for missing/invalid dates and timezone-less timestamps', () => {
    for (const day of [null, '', '2026-02-30', '2026-10-32', '20 Oct 2026']) {
      assert.match(documentDateBlocker({ ...fresh, documentDate: day })!, /missing or invalid/);
    }
    for (const instant of [null, '', 'bad', '2026-10-20T12:00:00']) {
      assert.match(documentDateBlocker({ ...fresh, documentCreatedAt: instant })!, /missing or invalid/);
    }
  });
  it('also excludes documents created before activation or reapproval', () => {
    assert.equal(documentDateBlocker(fresh, '2026-10-20T12:00:00Z'), null);
    assert.match(documentDateBlocker(fresh, '2026-10-24T08:00:00Z')!, /before this customer was enabled/);
    assert.match(documentDateBlocker(fresh, null)!, /before this customer was enabled/);
  });
});
