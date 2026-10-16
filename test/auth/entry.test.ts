import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { startAuthRuntime, users } from './runtime.ts';
import { entryTransport, entryScenarios } from './entry-fixture.ts';
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
void test('restoring a saved plan never restores approval and checking a flat account keeps the original budget', async (t) => {
  const runtime = await startAuthRuntime({ transport: entryTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  const saved = await (await request(runtime, cookie, 'plans', input)).json();
  const relogged = await login(runtime);
  await runtime.restartBusiness();
  const restored = await (await request(runtime, relogged, `plans/${saved.plan.id}`)).json();
  assert.equal(restored.plan.budget, '20');
  assert.equal(restored.plan.stopPrice, '98');
  assert.equal(restored.verification, undefined);
  const checked = await request(runtime, relogged, `plans/${saved.plan.id}/verify`, {});
  assert.equal(checked.status, 200, await checked.clone().text());
  const result = await checked.json();
  assert.equal(result.verification.status, 'waiting');
  assert.equal(result.verification.entryCheck.status, 'ready');
  assert.equal(result.verification.reviewRetention, 'saved');
  assert.equal(
    (await request(runtime, relogged, `plans/${saved.plan.id}/verify`, { budget: '999' })).status,
    400,
  );
});
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

void test('actual fills and costs are checked against the original stop, and missing evidence or failed storage cannot pass', async (t) => {
  const scenarios = entryScenarios();
  const runtime = await startAuthRuntime({ transport: scenarios.transport });
  t.after(() => runtime.close());
  const alice = await login(runtime),
    bob = await login(runtime, 1);
  await bind(runtime, alice);
  await bind(runtime, bob, 1);
  const saved = await (await request(runtime, alice, 'plans', input)).json();
  const path = `plans/${saved.plan.id}/verify`;
  for (const [scenario, status] of [
    ['protected', 'verified'],
    ['missing-stop', 'needs-action'],
    ['wrong-stop', 'needs-action'],
    ['missing-cost', 'error'],
  ]) {
    scenarios.select({ user: 'alice', scenario });
    const response = await request(runtime, alice, path, {});
    if (status === 'error') {
      assert.equal(response.status, 502);
      assert.equal((await response.json()).verification, undefined);
      continue;
    }
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.verification.status, status, JSON.stringify(result.verification));
    assert.equal(result.plan.budget, '20');
    assert.equal(result.plan.stopPrice, '98');
    if (scenario === 'protected') {
      assert.equal(result.verification.paidCommission, '0.04');
      assert.equal(result.verification.paidFunding, '0.3');
      assert.equal(result.verification.quantity, '0.4');
    }
  }
  assert.equal((await request(runtime, bob, path, {}, 1)).status, 404);
  scenarios.select({ user: 'alice', scenario: 'protected' });
  assert.ok((await request(runtime, alice, 'plans', { ...input, budget: '999' })).status >= 400);
  await runtime.database.$executeRawUnsafe(
    'ALTER TABLE entry_verification ADD CONSTRAINT synthetic_write_failure CHECK (false) NOT VALID',
  );
  const failed = await request(runtime, alice, path, {});
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).verification, undefined);
  await runtime.database.$executeRawUnsafe(
    'ALTER TABLE entry_verification DROP CONSTRAINT synthetic_write_failure',
  );
  assert.equal(
    (await (await request(runtime, alice, path, {})).json()).verification.status,
    'verified',
  );
  await runtime.restartBusiness();
  assert.equal(
    (await (await request(runtime, alice, path, {})).json()).verification.status,
    'verified',
  );
  await bind(runtime, alice, 0, true);
  const restored = await (await request(runtime, alice, `plans/${saved.plan.id}`)).json();
  assert.equal(restored.binding.credentialVersion, 2);
  assert.equal(restored.plan.budget, '20');
  assert.equal(
    (await (await request(runtime, alice, path, {})).json()).verification.status,
    'verified',
  );
  await runtime.database.entryPlan.update({
    where: { id: saved.plan.id },
    data: { trustedCurrent: false },
  });
  assert.equal((await request(runtime, alice, path, {})).status, 404);
  assert.equal((await request(runtime, alice, `plans/${saved.plan.id}`)).status, 404);
});

void test('wrong UID, stale market, session revocation and changed binding reject a pending verification', async (t) => {
  const scenarios = entryScenarios();
  let mode = '';
  let revoke: (() => Promise<void>) | undefined;
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      if (mode === 'wrong-uid' && url.pathname === '/api/v3/account')
        return { status: 200, body: { uid: 99999 } };
      const response = await scenarios.transport(url, headers, signal);
      if (mode === 'stale' && url.pathname === '/fapi/v1/premiumIndex')
        return { ...response, body: { ...(response.body as object), time: Date.now() - 60000 } };
      if (revoke && url.pathname === '/fapi/v1/userTrades') {
        const action = revoke;
        revoke = undefined;
        await action();
      }
      return response;
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  const saved = await (await request(runtime, cookie, 'plans', input)).json();
  scenarios.select({ user: 'alice', scenario: 'protected' });
  const path = `plans/${saved.plan.id}/verify`;
  mode = 'wrong-uid';
  const wrong = await request(runtime, cookie, path, {});
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).verification, undefined);
  mode = 'stale';
  const stale = await request(runtime, cookie, path, {});
  const staleBody = await stale.json();
  assert.ok(stale.status >= 400 || staleBody.verification.status !== 'verified');
  mode = '';
  revoke = async () => {
    await runtime.database.binanceBinding.update({
      where: { id: saved.binding.id },
      data: { credentialVersion: { increment: 1 } },
    });
  };
  const changedBinding = await request(runtime, cookie, path, {});
  assert.ok(changedBinding.status >= 400);
  assert.equal((await changedBinding.json()).verification, undefined);
  await runtime.database.binanceBinding.update({
    where: { id: saved.binding.id },
    data: { credentialVersion: 1 },
  });
  revoke = async () => {
    await runtime.database.session.deleteMany({ where: { userId: users[0]!.id } });
  };
  assert.equal((await request(runtime, cookie, path, {})).status, 401);
  const relogged = await login(runtime);
  await runtime.database.entryPlan.update({
    where: { id: saved.plan.id },
    data: { owner: { ...saved.binding, uid: 'wrong' } },
  });
  assert.equal((await request(runtime, relogged, `plans/${saved.plan.id}`)).status, 409);
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

void test('market data that expires during strict generation cannot become a saved executable card', async (t) => {
  let active = false,
    identities = 0;
  const runtime = await startAuthRuntime({
    transport: async (url, headers, signal) => {
      const response = await entryTransport(url, headers, signal);
      if (active && ['/fapi/v1/ticker/bookTicker', '/fapi/v1/premiumIndex'].includes(url.pathname))
        return { ...response, body: { ...(response.body as object), time: Date.now() - 29500 } };
      if (active && url.pathname === '/api/v3/account' && ++identities === 2)
        await setTimeout(1200, undefined, { signal });
      return response;
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  active = true;
  const response = await request(runtime, cookie, 'plans', input);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).plan, undefined);
});

void test('GTC limit generation uses limit lot sizes and restores the fixed plan after restart', async (t) => {
  const runtime = await startAuthRuntime({ transport: entryTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  const limit = { ...input, entryType: 'LIMIT', limitPrice: '100' };
  const response = await request(runtime, cookie, 'plans', limit);
  assert.equal(response.status, 201, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.plan.quantity, '0.495');
  assert.equal(saved.plan.limitPrice, '100');
  assert.equal(saved.plan.execution.entryType, 'LIMIT');
  assert.equal(saved.plan.execution.timeInForce, 'GTC');
  assert.equal(saved.plan.budget, '20');
  assert.equal(saved.plan.stopPrice, '98');
  await runtime.restartBusiness();
  const restored = await request(runtime, cookie, `plans/${saved.plan.id}`);
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), saved);
  for (const limitPrice of ['', '100.01', '121']) {
    const invalid = await request(runtime, cookie, 'plans', { ...limit, limitPrice });
    assert.ok(invalid.status >= 400);
    assert.equal((await invalid.json()).plan, undefined);
  }
});

void test('limit remainder blocks approval until cancellation reconciles, without counting unfilled quantity or costs', async (t) => {
  const scenarios = entryScenarios();
  const runtime = await startAuthRuntime({ transport: scenarios.transport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await bind(runtime, cookie);
  const saved = await (
    await request(runtime, cookie, 'plans', { ...input, entryType: 'LIMIT', limitPrice: '100' })
  ).json();
  const path = `plans/${saved.plan.id}/verify`;
  for (const [scenario, status, quantity, remainder, commission] of [
    ['limit-waiting', 'waiting', '0', '0.495', undefined],
    ['limit-unfilled-canceled', 'ended', '0', undefined, undefined],
    ['limit-partial', 'needs-action', '0.1', '0.395', '0.01'],
    ['limit-partial-more', 'needs-action', '0.4', '0.095', '0.04'],
    ['limit-inconsistent', 'incomplete', '0.4', undefined, undefined],
    ['limit-missing-stop', 'needs-action', '0.4', undefined, '0.04'],
    ['limit-canceled', 'verified', '0.4', undefined, '0.04'],
  ]) {
    scenarios.select({ user: 'alice', scenario });
    const response = await request(runtime, cookie, path, {});
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const checked = result.verification;
    assert.equal(checked.status, status, JSON.stringify(checked));
    assert.equal(checked.quantity, quantity);
    assert.equal(checked.pendingEntries[0]?.remainingQuantity, remainder);
    if (commission) assert.equal(checked.paidCommission, commission);
    assert.deepEqual(result.plan, saved.plan);
    if (scenario === 'limit-canceled') {
      assert.equal(checked.paidFunding, '0.3');
      assert.equal(checked.remainingFunding, '0.7');
      assert.equal(checked.plannedLoss, '2.270808');
    }
  }
  scenarios.select({ user: 'alice', scenario: 'limit-missing-cost' });
  const missing = await request(runtime, cookie, path, {});
  assert.equal(missing.status, 502);
  assert.equal((await missing.json()).verification, undefined);
  const bob = await login(runtime, 1);
  await bind(runtime, bob, 1);
  assert.equal((await request(runtime, bob, path, {}, 1)).status, 404);
  assert.equal((await request(runtime, bob, `plans/${saved.plan.id}`, undefined, 1)).status, 404);
});
