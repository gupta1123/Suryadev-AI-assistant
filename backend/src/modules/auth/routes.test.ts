import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { app } from '../../app.js';
import { env } from '../../config/env.js';
import { resetAdminSessions } from './session.js';

let server: Server;
let baseUrl = '';

before(async () => {
  resetAdminSessions();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe('administrator authentication routes', () => {
  it('rejects protected invoice APIs without a session', async () => {
    const response = await fetch(`${baseUrl}/invoice-delivery/config`);
    assert.equal(response.status, 401);
  });

  it('rejects incorrect credentials with a generic response', async () => {
    const response = await login(env.ADMIN_USERNAME, 'incorrect');
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Invalid username or password' });
  });

  it('rejects cross-origin login requests', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
      body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
    });
    assert.equal(response.status, 403);
  });

  it('logs in, restores the session, protects the invoice API and revokes on logout', async () => {
    const loginResponse = await login(env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
    assert.equal(loginResponse.status, 200);
    const setCookie = loginResponse.headers.get('set-cookie');
    assert.ok(setCookie?.includes('HttpOnly'));
    const cookie = setCookie?.split(';', 1)[0];
    assert.ok(cookie);

    const sessionResponse = await fetch(`${baseUrl}/auth/session`, {
      headers: { cookie },
    });
    assert.equal(sessionResponse.status, 200);
    const sessionBody = await sessionResponse.json() as { data: { user: { role: string } } };
    assert.equal(sessionBody.data.user.role, 'admin');

    const protectedResponse = await fetch(`${baseUrl}/invoice-delivery/config`, {
      headers: { cookie },
    });
    assert.equal(protectedResponse.status, 200);

    const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(logoutResponse.status, 204);
    assert.match(logoutResponse.headers.get('set-cookie') ?? '', /Max-Age=0/);

    const revokedResponse = await fetch(`${baseUrl}/auth/session`, {
      headers: { cookie },
    });
    assert.equal(revokedResponse.status, 401);
  });
});

function login(username: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}
