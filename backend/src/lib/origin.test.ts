import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { env } from '../config/env.js';
import { isTrustedRequestOrigin } from './origin.js';

describe('trusted request origins', () => {
  it('accepts requests without a browser origin and the configured frontend', () => {
    assert.equal(isTrustedRequestOrigin(undefined), true);
    assert.equal(isTrustedRequestOrigin(env.FRONTEND_ORIGIN), true);
  });

  it('accepts local frontend aliases during development', () => {
    assert.equal(isTrustedRequestOrigin('http://localhost:3000'), true);
    assert.equal(isTrustedRequestOrigin('http://127.0.0.1:3000'), true);
  });

  it('rejects non-local origins', () => {
    assert.equal(isTrustedRequestOrigin('https://example.invalid'), false);
    assert.equal(isTrustedRequestOrigin('not a URL'), false);
  });
});
