import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startAuthRuntime, users } from './runtime.ts';
import { assetsTransport } from './assets-fixture.ts';
import { createBusinessServer } from '../../src/business-server.ts';
import { once } from 'node:events';
import { get } from 'node:http';
import { setTimeout } from 'node:timers/promises';

type Runtime = Awaited<ReturnType<typeof startAuthRuntime>>;

void test(
  'a stalled asset read times out without making old data current or blocking another binding',
  { timeout: 30000 },
  async (t) => {
    let stall = false;
    const runtime = await startAuthRuntime({
      transport: async (url, headers, signal) => {
        if (
          stall &&
          url.pathname === '/fapi/v2/account' &&
          headers['X-MBX-APIKEY'] === 'synthetic-key-alice'
        ) {
          await new Promise<void>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return assetsTransport(url, headers, signal);
      },
    });
    t.after(() => runtime.close());
    const cookies = [await login(runtime), await login(runtime, 1)];
    for (const [index, cookie] of cookies.entries()) await bind(runtime, cookie, index);
    stall = true;
    const failed = await read(runtime, cookies[0]!);
    assert.equal(failed.status, 504);
    const body = await failed.json();
    assert.equal(body.code, 'timeout');
    assert.ok(Date.parse(body.retryAt) > Date.now());
    assert.equal(body.equity, undefined);
    assert.equal((await read(runtime, cookies[1]!, 1)).status, 200);
  },
);
async function login(runtime: Runtime, index = 0) {
  const user = users[index]!;
  const response = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  assert.equal(response.status, 200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function grant(runtime: Runtime, cookie: string, scope: string) {
  const response = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}
async function bind(runtime: Runtime, cookie: string, index = 0, rotated = false) {
  const name = index ? 'bob' : `alice${rotated ? '-rotated' : ''}`;
  const response = await fetch(`${runtime.businessOrigin}/v1/users/${users[index]!.id}/binding`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await grant(runtime, cookie, 'binding:write')}`,
      Origin: runtime.webOrigin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apiKey: `synthetic-key-${name}`,
      apiSecret: `synthetic-secret-${name}`,
      requestId: randomUUID(),
    }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { binding: { id: string; credentialVersion: number } })
    .binding;
}
async function read(
  runtime: Runtime,
  cookie: string,
  index = 0,
  resource = 'assets',
  automatic = false,
) {
  return fetch(`${runtime.businessOrigin}/v1/users/${users[index]!.id}/account/${resource}`, {
    headers: {
      Authorization: `Bearer ${await grant(runtime, cookie, 'account:read')}`,
      ...(automatic ? { 'X-Account-Refresh': 'automatic' } : {}),
    },
  });
}
void test('two users concurrently read their own signed assets and cached query times', async (t) => {
  const calls: string[] = [];
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      calls.push(`${headers['X-MBX-APIKEY']}:${url.pathname}`);
      return assetsTransport(url, headers, signal);
    },
  });
  t.after(() => runtime.close());
  const cookies = await Promise.all([login(runtime), login(runtime, 1)]);
  const bindings = await Promise.all(cookies.map((cookie, i) => bind(runtime, cookie, i)));
  const responses = await Promise.all(cookies.map((cookie, i) => read(runtime, cookie, i)));
  for (const response of responses) assert.equal(response.status, 200);
  const [alice, bob] = await Promise.all(responses.map((response) => response.json()));
  assert.equal(alice.equity, '975.09999999');
  assert.equal(bob.equity, '2050.00000000');
  assert.equal(alice.binding.id, bindings[0]!.id);
  assert.equal(bob.binding.id, bindings[1]!.id);
  assert.equal(alice.userId, users[0]!.id);
  assert.equal(alice.source, 'binance');
  const before = calls.length;
  const cached = await (await read(runtime, cookies[0]!, 0, 'assets', true)).json();
  assert.equal(cached.queriedAt, alice.queriedAt);
  assert.equal(cached.reused, true);
  assert.equal(calls.length, before);
  assert.doesNotMatch(JSON.stringify(alice), /synthetic-key|synthetic-secret|sealedCredential/);
});

void test('revoking the session during a read rejects its response and stops subsequent private calls', async (t) => {
  let hold = false;
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      if (hold) {
        calls.push(url.pathname);
        if (url.pathname === '/sapi/v1/account/apiRestrictions') {
          entered();
          await gate;
        }
      }
      return assetsTransport(url, headers, signal);
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  hold = true;
  const pending = read(runtime, cookie);
  try {
    await seen;
    const out = await fetch(`${runtime.webOrigin}/api/auth/sign-out`, {
      method: 'POST',
      headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(out.status, 200);
    release();
    assert.equal((await pending).status, 401);
    assert.deepEqual(calls, ['/sapi/v1/account/apiRestrictions']);
  } finally {
    release();
  }
});

void test('permission failure is private, rotation invalidates cache, and account routes reject foreign grants', async (t) => {
  let denyAlice = false;
  const calls: string[] = [];
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      calls.push(headers['X-MBX-APIKEY'] ?? 'public');
      if (
        denyAlice &&
        headers['X-MBX-APIKEY'] === 'synthetic-key-alice' &&
        url.pathname === '/sapi/v1/account/apiRestrictions'
      )
        return { status: 401, body: { code: -2015 } };
      return assetsTransport(url, headers, signal);
    },
  });
  t.after(() => runtime.close());
  const cookies = [await login(runtime), await login(runtime, 1)];
  await bind(runtime, cookies[0]!);
  await bind(runtime, cookies[1]!, 1);
  assert.equal((await read(runtime, cookies[0]!)).status, 200);
  await setTimeout(3000);
  denyAlice = true;
  const denied = await read(runtime, cookies[0]!);
  assert.equal(denied.status, 502);
  assert.equal((await denied.json()).scopeConfirmed, false);
  assert.equal((await read(runtime, cookies[1]!, 1)).status, 200);
  const before = calls.length;
  const oldToken = await grant(runtime, cookies[0]!, 'account:read');
  assert.equal(
    (
      await fetch(`${runtime.businessOrigin}/v1/users/${users[1]!.id}/account/assets`, {
        headers: { Authorization: `Bearer ${oldToken}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(
        `${runtime.businessOrigin}/v1/users/${users[0]!.id}/account/assets?symbol=BTCUSDT`,
        { headers: { Authorization: `Bearer ${oldToken}` } },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/account/assets`, {
        headers: { Authorization: `Bearer ${await grant(runtime, cookies[0]!, 'profile:read')}` },
      })
    ).status,
    403,
  );
  assert.equal(calls.length, before);
  const binding = await bind(runtime, cookies[0]!, 0, true);
  const rotated = await read(runtime, cookies[0]!);
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).binding.credentialVersion, binding.credentialVersion);
  assert.ok(calls.includes('synthetic-key-alice-rotated'));
  assert.equal(
    (
      await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/account/assets`, {
        headers: { Authorization: `Bearer ${oldToken}` },
      })
    ).status,
    401,
  );
  for (const resource of ['positions', 'orders', 'conditional-orders'])
    assert.equal((await read(runtime, cookies[0]!, 0, resource)).status, 200);
});

void test('an upstream cooldown blocks both users and survives a second business instance', async (t) => {
  let limited = false;
  let calls = 0;
  const transport: typeof assetsTransport = async (url, headers, signal) => {
    calls++;
    if (limited && url.pathname === '/fapi/v2/account')
      return { status: 429, body: { code: -1003 }, headers: { 'Retry-After': '60' } };
    return assetsTransport(url, headers, signal);
  };
  const runtime = await startAuthRuntime({ transport });
  t.after(() => runtime.close());
  const cookies = [await login(runtime), await login(runtime, 1)];
  for (const [i, cookie] of cookies.entries()) await bind(runtime, cookie, i);
  limited = true;
  const first = await read(runtime, cookies[0]!);
  assert.equal(first.status, 429);
  const failure = await first.json();
  const before = calls;
  const second = await read(runtime, cookies[1]!, 1);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).retryAt, failure.retryAt);
  const replica = createBusinessServer({
    database: runtime.database,
    authOrigin: runtime.webOrigin,
    businessOrigin: runtime.businessOrigin,
    publicKey: runtime.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    credentialMaster: runtime.credentialMaster,
    transport,
  });
  replica.listen(0, '127.0.0.1');
  await once(replica, 'listening');
  t.after(() => {
    replica.closeAllConnections();
    replica.close();
  });
  const address = replica.address();
  assert.ok(address && typeof address !== 'string');
  const token = await grant(runtime, cookies[1]!, 'account:read');
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(
      `http://127.0.0.1:${address.port}/v1/users/${users[1]!.id}/account/assets`,
      { headers: { Host: new URL(runtime.businessOrigin).host, Authorization: `Bearer ${token}` } },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += String(chunk);
        });
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      },
    ).on('error', reject);
  });
  assert.equal(response.status, 429);
  assert.equal(JSON.parse(response.body).retryAt, failure.retryAt);
  assert.equal(calls, before);
});
