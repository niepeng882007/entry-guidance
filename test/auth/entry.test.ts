import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startAuthRuntime, users } from './runtime.ts';
import { entryTransport } from './entry-fixture.ts';
type Runtime = Awaited<ReturnType<typeof startAuthRuntime>>;
const input = {
  symbol: 'BTCUSDT',
  side: 'long',
  budgetMode: 'amount',
  budget: '20',
  stopMode: 'price',
  stop: '98',
  slippage: '1',
  funding: '1',
  leverage: '10',
  minimumBuffer: '1',
  fundingCap: '5',
  entryType: 'MARKET',
  stopLevels: 'single',
};
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

async function request(runtime: Runtime, cookie: string, path: string, body?: unknown, index = 0) {
  return fetch(`${runtime.businessOrigin}/v1/users/${users[index]!.id}/entry/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${await grant(runtime, cookie, body === undefined ? 'entry:read' : 'entry:write')}`,
      Origin: runtime.webOrigin,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
void test('a strictly refreshed fixed plan is durably readable only by its owner', async (t) => {
  let accountReads = 0;
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      if (url.pathname === '/fapi/v2/account') accountReads++;
      return entryTransport(url, headers, signal);
    },
  });
  t.after(() => runtime.close());
  const alice = await login(runtime),
    bob = await login(runtime, 1);
  const binding = await bind(runtime, alice);
  await bind(runtime, bob, 1);
  const market = await request(runtime, alice, 'market?symbol=BTCUSDT');
  assert.equal(market.status, 200);
  const before = accountReads;
  const response = await request(runtime, alice, 'plans', input);
  assert.equal(response.status, 201, await response.clone().text());
  const saved = await response.json();
  assert.ok(accountReads > before);
  assert.equal(saved.plan.budget, '20');
  assert.equal(saved.plan.stopPrice, '98');
  assert.equal(saved.plan.quantity, '0.4');
  assert.equal(saved.binding.id, binding.id);
  assert.deepEqual(saved.input, input);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-key|synthetic-secret|sealedCredential/);
  assert.deepEqual(await (await request(runtime, alice, `plans/${saved.plan.id}`)).json(), saved);
  assert.equal((await request(runtime, bob, `plans/${saved.plan.id}`, undefined, 1)).status, 404);
});

void test('invalid market, occupied account, unsupported inputs and failed storage never return a usable plan', async (t) => {
  let scenario = '';
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      const result = await entryTransport(url, headers, signal);
      if (scenario === 'stale' && url.pathname === '/fapi/v1/premiumIndex')
        return {
          status: 200,
          body: { symbol: 'BTCUSDT', markPrice: '100', time: Date.now() - 60000 },
        };
      if (scenario === 'occupied' && url.pathname === '/fapi/v2/account')
        return {
          ...result,
          body: {
            ...(result.body as object),
            positions: [
              { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '1', isolated: true },
            ],
          },
        };
      if (scenario === 'wrong-uid' && url.pathname === '/api/v3/account')
        return { status: 200, body: { uid: 98765 } };
      return result;
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  for (const value of [
    { ...input, stop: '101' },
    { ...input, entryType: 'LIMIT' },
    { ...input, stopLevels: 'two' },
    { ...input, ownerUserId: users[1]!.id },
  ]) {
    const response = await request(runtime, cookie, 'plans', value);
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).plan, undefined);
  }
  for (scenario of ['stale', 'occupied', 'wrong-uid']) {
    const response = await request(runtime, cookie, 'plans', input);
    assert.ok(response.status >= 400, scenario);
    assert.equal((await response.json()).plan, undefined);
  }
  scenario = '';
  await runtime.database.$executeRawUnsafe(
    `ALTER TABLE entry_plan ADD CONSTRAINT synthetic_storage_failure CHECK (false) NOT VALID`,
  );
  const failed = await request(runtime, cookie, 'plans', input);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).plan, undefined);
  await runtime.database.$executeRawUnsafe(
    `ALTER TABLE entry_plan DROP CONSTRAINT synthetic_storage_failure`,
  );
  assert.equal((await request(runtime, cookie, 'plans', input)).status, 201);
});

void test('rotating the binding during generation rejects the old request before it can save', async (t) => {
  let holding = false;
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      if (holding && url.pathname === '/fapi/v1/time') {
        holding = false;
        entered();
        await gate;
      }
      return entryTransport(url, headers, signal);
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  holding = true;
  const pending = request(runtime, cookie, 'plans', input);
  try {
    await seen;
    const rotating = bind(runtime, cookie, 0, true);
    // The current read holds the shared egress lease; let it finish so rotation can proceed.
    release();
    await rotating;
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.json()).plan, undefined);
  } finally {
    release();
  }
});
