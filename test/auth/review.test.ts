import assert from 'node:assert/strict';
import test from 'node:test';
import { startAuthRuntime, users } from './runtime.ts';
import { assetsTransport } from './assets-fixture.ts';

void test('review requires its own grant and an owned binding without calling Binance', async (t) => {
  let calls = 0;
  const runtime = await startAuthRuntime({
    transport: async (...args) => {
      calls++;
      return assetsTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const login = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
    body: JSON.stringify({ email: users[0]!.email, password: users[0]!.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const grant = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'review:read' }),
  });
  assert.equal(grant.status, 200);
  const { token } = (await grant.json()) as { token: string };
  const path = `${runtime.businessOrigin}/v1/users/${users[0]!.id}/review/missing-binding/trades`;
  assert.equal((await fetch(path)).status, 401);
  const denied = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(denied.status, 404);
  assert.equal(calls, 0);
});

void test('two users persist identical cycle IDs and read only their own PostgreSQL summaries and evidence', async (t) => {
  const { PostgresReviewLedger } = await import('../../src/postgres-review-ledger.ts');
  const { reviewCycles } = await import('./review-fixture.ts');
  const { randomUUID } = await import('node:crypto');
  let calls = 0;
  const runtime = await startAuthRuntime({
    simulation: true,
    transport: async (...args) => {
      calls++;
      return assetsTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const readers = [];
  for (const [index, user] of users.entries()) {
    const response = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const grant = async (scope: string) => {
      const response = await fetch(`${runtime.webOrigin}/api/delegation`, {
        method: 'POST',
        headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { token: string }).token;
    };
    const name = index ? 'bob' : 'alice';
    const bound = await fetch(`${runtime.businessOrigin}/v1/users/${user.id}/binding`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await grant('binding:write')}`,
        Origin: runtime.webOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiKey: `synthetic-key-${name}`,
        apiSecret: `synthetic-secret-${name}`,
        requestId: randomUUID(),
      }),
    });
    assert.equal(bound.status, 200);
    const { binding } = (await bound.json()) as { binding: { id: string; uid: string } };
    const ledger = new PostgresReviewLedger(runtime.database, {
      userId: user.id,
      bindingId: binding.id,
      source: 'demo',
      accountId: binding.uid,
    });
    await ledger.store(reviewCycles(binding.uid));
    const token = await grant('review:read');
    const path = `${runtime.businessOrigin}/v1/users/${user.id}/review/${binding.id}/trades`;
    readers.push({ path, token, binding, ledger, grant, cookie });
  }
  const before = calls;
  for (const [index, reader] of readers.entries()) {
    const list = await fetch(reader.path, { headers: { Authorization: `Bearer ${reader.token}` } });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.total, index ? 2 : 25);
    assert.equal(body.trades.length, index ? 2 : 20);
    assert.equal(body.pageSize, 20);
    assert.equal(body.trades[0].evidence, undefined);
    const detail = await fetch(reader.path + '/cycle-00', {
      headers: { Authorization: `Bearer ${reader.token}` },
    });
    assert.equal(detail.status, 200);
    const data = await detail.json();
    assert.equal(data.trade.netPnl, index ? '29.8' : '9.8');
    assert.equal(data.trade.accountId, reader.binding.uid);
    assert.equal(data.trade.evidence.fills.length, 2);
    assert.equal(list.headers.get('cache-control'), 'no-store');
  }
  const alice = readers[0]!;
  const bob = readers[1]!;
  const get = (reader: typeof alice, suffix = '', token = reader.token) =>
    fetch(reader.path + suffix, { headers: { Authorization: `Bearer ${token}` } });
  await t.test(
    'paging and Shanghai date boundaries preserve incomplete records and stable ordering',
    async () => {
      const page = await (await get(alice, '?page=2')).json();
      assert.equal(page.trades.length, 5);
      assert.equal(page.nextPage, null);
      assert.equal(page.trades.at(-1).id, 'missing-start');
      assert.equal((await (await get(alice, '?page=999999')).json()).trades.length, 0);
      const { reviewCycle } = await import('./review-fixture.ts');
      await alice.ledger.store([
        reviewCycle('10001', 'before-midnight', '2026-10-13T15:59:00.000Z'),
        reviewCycle('10001', 'at-midnight', '2026-10-13T16:00:00.000Z'),
      ]);
      const day = await (await get(alice, '?from=2026-10-13&to=2026-10-13')).json();
      assert.deepEqual(
        day.trades.map((row: { id: string }) => row.id),
        ['before-midnight'],
      );
      const next = await (await get(alice, '?from=2026-10-14&to=2026-10-14&page=2')).json();
      assert.ok(next.trades.some((row: { id: string }) => row.id === 'at-midnight'));
      assert.ok(next.trades.every((row: { id: string }) => row.id !== 'missing-start'));
      const pending = await (await get(alice, '?pnl=pending&status=incomplete')).json();
      assert.equal(pending.total, 2);
      assert.equal((await (await get(alice, '?symbol=ETHUSDT')).json()).total, 0);
    },
  );
  await t.test(
    'unknown costs and starting position retain known facts without inventing zero net profit',
    async () => {
      const cost = (await (await get(alice, '/missing-cost')).json()).trade;
      assert.equal(cost.netPnl, null);
      assert.equal(cost.realizedPnl, '10');
      assert.equal(cost.commission, null);
      assert.equal(cost.evidence.fills[1].commission, null);
      const start = (await (await get(alice, '/missing-start')).json()).trade;
      assert.equal(start.openedAt, null);
      assert.equal(start.netPnl, null);
      assert.equal(start.evidence.startPosition, null);
      assert.ok(start.missing.length > 0);
    },
  );
  await t.test(
    'foreign user, binding, record, grant, malformed and unsupported requests are denied',
    async () => {
      assert.equal((await get(bob, '/cycle-00', alice.token)).status, 403);
      const foreign = alice.path.replace(alice.binding.id, bob.binding.id);
      assert.equal(
        (
          await fetch(foreign + '/cycle-00', {
            headers: { Authorization: `Bearer ${alice.token}` },
          })
        ).status,
        404,
      );
      assert.equal((await get(bob, '/missing-cost')).status, 404);
      assert.equal((await get(alice, '', await alice.grant('account:read'))).status, 403);
      for (const suffix of [
        '?page=0',
        '?page=1&page=2',
        '?page=1.5',
        '?from=2026-02-30',
        '?from=2026-10-15&to=2026-10-14',
        '?timeZone=UTC',
        '?symbol=bad',
        '?userId=synthetic-bob',
        '/cycle-00?page=2',
      ])
        assert.equal((await get(alice, suffix)).status, 400, suffix);
      assert.equal(
        (
          await fetch(alice.path, {
            method: 'POST',
            headers: { Authorization: `Bearer ${alice.token}` },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(alice.path, {
            headers: { Authorization: `Bearer ${alice.token}`, Origin: 'https://foreign.invalid' },
          })
        ).status,
        403,
      );
      await assert.rejects(() => bob.ledger.store(reviewCycles('10001')));
      assert.equal((await (await get(bob)).json()).total, 2);
    },
  );
  await t.test(
    'reversal allocations and hedge directions retain stable original fill identities',
    async () => {
      const { reviewCycle } = await import('./review-fixture.ts');
      const closing = reviewCycle('10001', 'reversal-close');
      closing.evidence.fills[1]!.id = 'shared-reversal-fill';
      closing.evidence.fills[1]!.allocation = 'close';
      const opening = reviewCycle('10001', 'reversal-open');
      opening.side = 'short';
      opening.evidence.fills[0]!.id = 'shared-reversal-fill';
      opening.evidence.fills[0]!.allocation = 'open';
      opening.evidence.fills[0]!.side = 'SELL';
      opening.evidence.fills[0]!.price = '110';
      opening.evidence.fills[1]!.side = 'BUY';
      opening.evidence.fills[1]!.price = '100';
      opening.evidence.orders[0]!.side = 'SELL';
      opening.evidence.orders[1]!.side = 'BUY';
      const long = reviewCycle('10001', 'hedge-long');
      const short = structuredClone(opening);
      short.id = 'hedge-short';
      for (const fill of long.evidence.fills) fill.positionSide = 'LONG';
      for (const fill of short.evidence.fills) fill.positionSide = 'SHORT';
      await alice.ledger.store([closing, opening, long, short]);
      const first = (await (await get(alice, '/reversal-close')).json()).trade;
      const second = (await (await get(alice, '/reversal-open')).json()).trade;
      assert.equal(first.evidence.fills[1].id, second.evidence.fills[0].id);
      assert.equal(first.evidence.fills[1].allocation, 'close');
      assert.equal(second.evidence.fills[0].allocation, 'open');
      assert.equal(second.side, 'short');
      assert.equal(
        (await (await get(alice, '/hedge-long')).json()).trade.evidence.fills[0].positionSide,
        'LONG',
      );
      assert.equal(
        (await (await get(alice, '/hedge-short')).json()).trade.evidence.fills[0].positionSide,
        'SHORT',
      );
      const invalid = reviewCycle('10002', 'wrong-owner');
      await assert.rejects(() =>
        alice.ledger.store([reviewCycle('10001', 'must-not-save'), invalid]),
      );
      assert.equal((await get(alice, '/must-not-save')).status, 404);
    },
  );
  await t.test(
    'large original evidence travels directly and lossless decimals survive a new reader',
    async () => {
      const { reviewCycle } = await import('./review-fixture.ts');
      const large = reviewCycle('10001', 'large-evidence');
      large.evidence.raw = Array.from({ length: 5500 }, (_, index) => ({
        kind: 'trades' as const,
        id: `original-${index}`,
        time: 1791936000000,
        payload: { description: 'x'.repeat(1000), price: '123456789012345.12345678' },
      }));
      await alice.ledger.store([large]);
      const response = await get(alice, '/large-evidence');
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.ok(Buffer.byteLength(raw) > 4.5 * 1024 * 1024);
      const trade = JSON.parse(raw).trade;
      assert.equal(trade.evidence.raw.length, 5500);
      assert.equal(trade.evidence.raw.at(-1).payload.price, '123456789012345.12345678');
      const reopened = new PostgresReviewLedger(runtime.database, {
        userId: users[0]!.id,
        bindingId: alice.binding.id,
        source: 'demo',
        accountId: alice.binding.uid,
      });
      assert.equal((await reopened.get('large-evidence'))!.evidence.raw!.length, 5500);
      const live = new PostgresReviewLedger(runtime.database, {
        userId: users[0]!.id,
        bindingId: alice.binding.id,
        source: 'binance',
        accountId: alice.binding.uid,
      });
      assert.equal(await live.get('cycle-00'), null);
    },
  );
  assert.equal(calls, before);
  await t.test(
    'same UID rotation preserves cycles and revokes old review grants; logout blocks reads',
    async () => {
      const rotated = await fetch(alice.path.split('/review/')[0] + '/binding', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await alice.grant('binding:write')}`,
          Origin: runtime.webOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: 'synthetic-key-alice-rotated',
          apiSecret: 'synthetic-secret-alice-rotated',
          requestId: randomUUID(),
        }),
      });
      assert.equal(rotated.status, 200);
      assert.equal((await get(alice)).status, 401);
      const token = await alice.grant('review:read');
      assert.equal((await (await get(alice, '/cycle-00', token)).json()).trade.netPnl, '9.8');
      await fetch(`${runtime.webOrigin}/api/auth/sign-out`, {
        method: 'POST',
        headers: {
          cookie: alice.cookie,
          Origin: runtime.webOrigin,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.equal((await get(alice, '', token)).status, 401);
      assert.equal((await get(bob)).status, 200);
    },
  );
});
