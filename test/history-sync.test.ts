import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server.ts';
import type { Transport } from '../src/account.ts';

async function start(t: TestContext, transport: Transport, path?: string, apiKey = 'test-key') {
  const server = createServer({ password: 'history-test-only', mode: 'real', apiKey, apiSecret: 'test-secret', transport, reviewLedgerPath: path });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=history-test-only' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  const sync = (symbol = 'BTCUSDT') => fetch(`${base}/api/review/sync`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol }) });
  return { server, base, cookie, get, sync };
}

const permissions = { enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, enableMargin: false, enableFutures: false, permitsUniversalTransfer: false, enableVanillaOptions: false, enableFixApiTrade: false, enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false };

const opened = Date.now() - 2 * 86_400_000;
const closed = opened + 60_000;
const fills = [
  { id: 1, orderId: 11, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', qty: '1', price: '100', time: opened, realizedPnl: '0', commission: '0.1', commissionAsset: 'USDT' },
  { id: 2, orderId: 12, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', qty: '1', price: '110', time: closed, realizedPnl: '10', commission: '0.1', commissionAsset: 'USDT' },
];
const orders = fills.map((fill) => ({ orderId: fill.orderId, symbol: fill.symbol, side: fill.side, positionSide: 'BOTH', type: 'MARKET', origQty: '1', executedQty: '1', time: fill.time, updateTime: fill.time, status: 'FILLED' }));
function fixture(overrides: Partial<Record<string, unknown>> = {}): Transport {
  return async (url) => {
    const bodies: Record<string, unknown> = {
      '/sapi/v1/account/apiRestrictions': permissions, '/api/v3/account': { uid: 12345 },
      '/fapi/v1/time': { serverTime: Date.now() },
      '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', updateTime: closed }],
      '/fapi/v1/userTrades': fills, '/fapi/v1/allOrders': orders,
      '/fapi/v1/allAlgoOrders': [], '/fapi/v1/forceOrders': [],
      '/fapi/v1/income': [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', tranId: 1, time: opened + 1000, income: '-0.2', asset: 'USDT', tradeId: '' }],
      ...overrides,
    };
    assert.ok(Object.hasOwn(bodies, url.pathname), `unexpected GET ${url.pathname}`);
    let body = bodies[url.pathname];
    if (Array.isArray(body) && url.searchParams.has('startTime')) {
      const start = Number(url.searchParams.get('startTime')), end = Number(url.searchParams.get('endTime'));
      body = body.filter((row) => row.time >= start && row.time <= end);
    }
    return { status: 200, body };
  };
}
async function finished(app: Awaited<ReturnType<typeof start>>) {
  for (let index = 0; index < 500; index++) {
    const response = await app.get('/api/review/trades');
    assert.equal(response.status, 200);
    const data = await response.json();
    if (data.sync?.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('history did not finish');
}

test('history refuses an unverifiable account before reading or archiving history', async (t) => {
  const app = await start(t, async (url) => {
    if (url.pathname === '/sapi/v1/account/apiRestrictions') return { status: 200, body: permissions };
    if (url.pathname === '/api/v3/account') return { status: 200, body: {} };
    throw new Error('no history may be read without identity');
  });
  const response = await app.sync();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'unverified_identity');
  assert.deepEqual(await (await app.get('/api/review/trades')).json(), { source: 'binance', accountId: null, syncStatus: 'not-synced', trades: [] });
});

test('stable UID preserves history on key rotation and isolates another account', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'history-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'real.sqlite');
  let app = await start(t, fixture(), path);
  assert.equal((await app.sync()).status, 202);
  await finished(app);
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  app = await start(t, fixture(), path, 'rotated-test-key');
  assert.equal((await (await app.get('/api/review/trades')).json()).trades[0].netPnl, '9.6');
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  app = await start(t, fixture({ '/api/v3/account': { uid: 67890 } }), path, 'another-test-key');
  const isolated = await (await app.get('/api/review/trades')).json();
  assert.equal(isolated.accountId, '67890');
  assert.equal(isolated.trades.length, 0);
  assert.equal(isolated.sync, null);
});

test('forced-order evidence distinguishes liquidation and ADL rather than guessing from market type', async (t) => {
  for (const reason of ['LIQUIDATION', 'ADL'] as const) await t.test(reason, async (t) => {
    const base = fixture();
    const app = await start(t, async (url, headers, signal) => {
      if (url.pathname === '/fapi/v1/forceOrders' && url.searchParams.get('autoCloseType') === reason && Number(url.searchParams.get('startTime')) <= closed && Number(url.searchParams.get('endTime')) >= closed) return { status: 200, body: [{ ...orders[1], orderId: 12, time: closed }] };
      return base(url, headers, signal);
    });
    await app.sync();
    const data = await finished(app);
    const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
    assert.equal(detail.exitReason, reason);
    assert.ok(detail.evidence.raw.some((row: { kind: string }) => row.kind === 'forceOrders'));
  });
});

test('a simple real trade has confirmed net PnL and survives restart and repeated sync', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'history-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'real.sqlite');
  let app = await start(t, fixture(), path);
  assert.equal((await app.sync()).status, 202);
  let data = await finished(app);
  assert.equal(data.accountId, '12345');
  assert.equal(data.sync.status, 'complete', JSON.stringify(data.sync.missing));
  assert.equal(data.trades.length, 1);
  assert.equal(data.trades[0].status, 'closed');
  assert.equal(data.trades[0].netPnl, '9.6');
  const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
  assert.equal(detail.evidence.fills.length, 2);
  assert.equal(detail.evidence.funding[0].amount, '-0.2');
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  app = await start(t, fixture(), path);
  assert.equal((await (await app.get('/api/review/trades')).json()).trades.length, 1);
  assert.equal((await app.sync()).status, 202);
  data = await finished(app);
  assert.equal(data.trades.length, 1);
  assert.equal(data.trades[0].netPnl, '9.6');
});

test('full trade pages are split and income pages continue before coverage is confirmed', async (t) => {
  const manyFills = Array.from({ length: 1000 }, (_, index) => ({ ...fills[0], id: index + 1, qty: '0.001', commission: '0.0001', time: opened + index }));
  manyFills.push({ ...fills[1]!, id: 1001 });
  const incomes = Array.from({ length: 1001 }, (_, index) => ({ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', tranId: index + 1, time: opened + 10_000, income: '-0.0001', asset: 'USDT' }));
  const base = fixture({ '/fapi/v1/userTrades': manyFills, '/fapi/v1/income': incomes });
  const app = await start(t, async (url, headers, signal) => {
    const response = await base(url, headers, signal);
    if (Array.isArray(response.body) && url.searchParams.has('limit')) {
      const limit = Number(url.searchParams.get('limit'));
      const page = Number(url.searchParams.get('page') ?? 1);
      response.body = url.pathname === '/fapi/v1/income' ? response.body.slice((page - 1) * limit, page * limit) : response.body.slice(-limit);
    }
    return response;
  });
  assert.equal((await app.sync()).status, 202);
  const data = await finished(app);
  assert.equal(data.sync.status, 'complete', JSON.stringify(data.sync.missing));
  assert.equal(data.trades[0].netPnl, '9.6999');
  const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
  assert.equal(detail.evidence.fills.length, 1001);
  assert.equal(detail.evidence.funding.length, 1001);
});

test('rate limiting preserves evidence and unfinished pages across restart for explicit retry', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'history-retry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'real.sqlite');
  let limited = true;
  const base = fixture();
  const transport: Transport = async (url, headers, signal) => url.pathname === '/fapi/v1/allOrders' && limited ? { status: 429, body: { code: -1003 } } : base(url, headers, signal);
  let app = await start(t, transport, path);
  assert.equal((await app.sync()).status, 202);
  let data = await finished(app);
  assert.equal(data.sync.status, 'failed');
  assert.match(data.sync.missing.join(' '), /限流/);
  assert.ok(data.sync.pending.length > 0);
  assert.equal(data.sync.lastSuccessAt, null);
  assert.equal(data.trades[0].netPnl, null);
  const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
  assert.equal(detail.evidence.fills.length, 2);
  const pages = data.sync.pages;
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  limited = false;
  app = await start(t, transport, path);
  assert.equal((await (await app.get('/api/review/trades')).json()).sync.status, 'failed');
  assert.equal((await app.sync()).status, 202);
  data = await finished(app);
  assert.equal(data.sync.status, 'complete');
  assert.ok(data.sync.pages > pages);
  assert.equal(data.trades[0].netPnl, '9.6');
});

test('unknown starting position and non-USDT costs remain inspectable incomplete records', async (t) => {
  for (const [label, overrides] of [
    ['starting position', { '/fapi/v1/userTrades': [fills[1]] }],
    ['non-USDT commission', { '/fapi/v1/userTrades': fills.map((fill) => ({ ...fill, commissionAsset: 'BNB' })) }],
    ['unknown position mode', { '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0' }] }],
    ['missing order metadata', { '/fapi/v1/allOrders': [] }],
    ['missing order executed quantity', { '/fapi/v1/allOrders': orders.map((order) => ({ ...order, executedQty: null })) }],
  ] as const) {
    await t.test(label, async (t) => {
      const app = await start(t, fixture(overrides));
      assert.equal((await app.sync()).status, 202);
      const data = await finished(app);
      assert.equal(data.trades[0].status, 'incomplete');
      assert.equal(data.trades[0].netPnl, null);
      assert.ok(data.trades[0].missing.length > 0);
      const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
      assert.ok(detail.evidence.fills.length > 0);
      if (label === 'starting position') assert.equal(detail.openedAt, null);
      if (label === 'non-USDT commission') assert.equal(detail.evidence.fills[0].commissionAsset, 'BNB');
    });
  }
});

test('an interrupted service keeps its pending interval and resumes only on explicit sync', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'history-interrupted-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'real.sqlite');
  const base = fixture();
  let notify!: () => void;
  const waiting = new Promise<void>((resolve) => { notify = resolve; });
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname !== '/fapi/v1/allOrders') return base(url, headers, signal);
    notify();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  }, path);
  assert.equal((await app.sync()).status, 202);
  await waiting;
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  const reopened = await start(t, base, path);
  const state = await (await reopened.get('/api/review/trades')).json();
  assert.equal(state.sync.status, 'interrupted');
  assert.ok(state.sync.pending.length > 0);
  assert.equal((await reopened.sync()).status, 202);
  const complete = await finished(reopened);
  assert.equal(complete.trades[0].netPnl, '9.6');
});

test('conflicting immutable evidence cannot overwrite an archive or advance failed-page coverage', async (t) => {
  let changed = false;
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    const response = await base(url, headers, signal);
    if (changed && url.pathname === '/fapi/v1/userTrades' && Array.isArray(response.body)) response.body = response.body.map((fill) => ({ ...fill, qty: '2' }));
    return response;
  });
  await app.sync();
  await finished(app);
  changed = true;
  await app.sync();
  const data = await finished(app);
  assert.equal(data.sync.status, 'failed');
  assert.ok(data.sync.pending.some((page: { source: string; startTime: number; endTime: number }) => page.source === 'trades' && page.startTime <= opened && page.endTime >= opened));
  assert.equal(data.trades[0].netPnl, '9.6');
  const evidence = await (await app.get('/api/review/evidence?symbol=BTCUSDT')).json();
  assert.equal(evidence.records.find((row: { kind: string }) => row.kind === 'trades').payload.qty, '1');
});

test('unsafe permissions, expired sessions and concurrent submissions cannot start extra syncs', async (t) => {
  const unsafe = await start(t, fixture({ '/sapi/v1/account/apiRestrictions': { ...permissions, enableFutures: true } }));
  const refusal = await unsafe.sync();
  assert.equal(refusal.status, 502);
  assert.equal((await refusal.json()).code, 'unsafe_permissions');
  let notify!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { notify = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/api/v3/account') { notify(); await gate; }
    return base(url, headers, signal);
  });
  const pending = app.sync();
  await waiting;
  await fetch(`${app.base}/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: app.cookie, Origin: app.base } });
  release();
  assert.equal((await pending).status, 401);
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const concurrent = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/allOrders') await blocked;
    return base(url, headers, signal);
  });
  const responses = await Promise.all([concurrent.sync(), concurrent.sync()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  unblock();
  assert.equal((await finished(concurrent)).trades.length, 1);
});

test('resuming an older symbol reports its own progress rather than another completed symbol', async (t) => {
  let phase = 'fail';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/allOrders' && url.searchParams.get('symbol') === 'BTCUSDT') {
      if (phase === 'fail') return { status: 429, body: { code: -1003 } };
      if (phase === 'resume') await gate;
    }
    const response = await base(url, headers, signal);
    if (Array.isArray(response.body) && url.searchParams.get('symbol') === 'ETHUSDT') response.body = response.body.map((row) => ({ ...row, symbol: 'ETHUSDT' }));
    return response;
  });
  await app.sync();
  assert.equal((await finished(app)).sync.status, 'failed');
  await app.sync('ETHUSDT');
  assert.equal((await finished(app)).sync.symbol, 'ETHUSDT');
  phase = 'resume';
  await app.sync();
  const running = await (await app.get('/api/review/trades')).json();
  release();
  assert.equal(running.sync.symbol, 'BTCUSDT');
  assert.equal(running.sync.status, 'running');
  assert.equal((await finished(app)).sync.symbol, 'BTCUSDT');
});

test('a failed later sync retains old closed trades and exposes newly read fills as incomplete', async (t) => {
  let later = false;
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (later && url.pathname === '/fapi/v1/allOrders') return { status: 429, body: { code: -1003 } };
    const response = await base(url, headers, signal);
    if (later && url.pathname === '/fapi/v1/userTrades' && Number(url.searchParams.get('startTime')) <= opened + 600_000 && Number(url.searchParams.get('endTime')) >= opened + 600_000) response.body = [...(response.body as unknown[]), { ...fills[0], id: 3, orderId: 13, time: opened + 600_000 }];
    return response;
  });
  await app.sync();
  await finished(app);
  later = true;
  await app.sync();
  const data = await finished(app);
  assert.equal(data.sync.status, 'failed');
  assert.equal(data.trades.length, 2);
  assert.equal(data.trades.find((trade: { status: string }) => trade.status === 'closed').netPnl, '9.6');
  const incomplete = data.trades.find((trade: { status: string }) => trade.status === 'incomplete');
  const detail = await (await app.get(`/api/review/trades/${incomplete.id}`)).json();
  assert.deepEqual(detail.evidence.fills.map((fill: { id: string }) => fill.id), ['3']);
  assert.equal(detail.netPnl, null);
});

test('a missing reported cost preserves the fill and keeps net PnL pending', async (t) => {
  const app = await start(t, fixture({ '/fapi/v1/userTrades': fills.map((fill) => ({ ...fill, commission: null, commissionAsset: null, realizedPnl: null })) }));
  await app.sync();
  const data = await finished(app);
  assert.equal(data.trades.length, 1);
  assert.equal(data.trades[0].status, 'incomplete');
  assert.equal(data.trades[0].netPnl, null);
  const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
  assert.equal(detail.evidence.fills.length, 2);
  assert.equal(detail.evidence.fills[0].commission, null);
});

test('raw JSON preserves int64 account, trade and order identities without numeric rounding', async (t) => {
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/api/v3/account') return { status: 200, body: '{"uid":9007199254740993}' };
    const response = await base(url, headers, signal);
    if (['/fapi/v1/userTrades', '/fapi/v1/allOrders', '/fapi/v1/income', '/fapi/v1/allAlgoOrders', '/fapi/v1/forceOrders'].includes(url.pathname)) response.body = JSON.stringify(response.body)
      .replaceAll('"id":1,', '"id":9007199254741001,').replaceAll('"id":2,', '"id":9007199254741002,')
      .replaceAll('"orderId":11,', '"orderId":9007199254741011,').replaceAll('"orderId":12,', '"orderId":9007199254741012,');
    return response;
  });
  assert.equal((await app.sync()).status, 202);
  const data = await finished(app);
  assert.equal(data.accountId, '9007199254740993');
  assert.equal(data.trades[0].netPnl, '9.6');
  const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
  assert.equal(detail.evidence.fills[0].id, '9007199254741001');
  assert.equal(detail.evidence.fills[0].orderId, '9007199254741011');
});

test('retry enriches unknown costs and income but rejects changes to previously known costs', async (t) => {
  let phase = 'missing';
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    const response = await base(url, headers, signal);
    if (Array.isArray(response.body)) {
      const rows = response.body;
      if (url.pathname === '/fapi/v1/userTrades') response.body = rows.map((fill) => phase === 'missing' ? { ...fill, commission: null, commissionAsset: null, realizedPnl: null } : phase === 'conflict' ? { ...fill, commission: '0.2' } : fill);
      if (url.pathname === '/fapi/v1/income' && phase === 'missing') response.body = rows.map((income) => ({ ...income, income: null, asset: null }));
    }
    return response;
  });
  await app.sync();
  assert.equal((await finished(app)).trades[0].netPnl, null);
  phase = 'complete';
  await app.sync();
  let data = await finished(app);
  assert.equal(data.sync.status, 'complete', JSON.stringify(data.sync.missing));
  assert.equal(data.trades[0].netPnl, '9.6');
  phase = 'conflict';
  await app.sync();
  data = await finished(app);
  assert.equal(data.sync.status, 'failed');
  assert.equal(data.trades[0].netPnl, '9.6');
});
