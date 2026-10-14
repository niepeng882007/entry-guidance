import { defaultReviewFilters } from '../src/review-filters.ts';
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
      body = body.filter((row) => {
        const time = url.pathname === '/fapi/v1/allAlgoOrders' ? row.createTime : row.time;
        return time >= start && time <= end;
      });
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

function marketRows(url: URL, bias = 0) {
  const steps: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
  const step = steps[url.searchParams.get('interval')!]!;
  const rows = [];
  for (let time = Number(url.searchParams.get('startTime')); time <= Number(url.searchParams.get('endTime')); time += step) rows.push([time, String(100 + bias), String(110 + bias), String(90 + bias), String(105 + bias), '0', time + step - 1, '0', 0, '0', '0', '0']);
  return rows;
}

test('market pagination retains full raw evidence, separates sources and freezes earlier snapshots', async (t) => {
  const opening = Math.floor((Date.now() - 20 * 86_400_000) / 60_000) * 60_000;
  const closing = opening + 5 * 86_400_000;
  const historyFills = [{ ...fills[0], time: opening }, { ...fills[1], time: closing }];
  const base = fixture({ '/fapi/v1/userTrades': historyFills, '/fapi/v1/allOrders': historyFills.map((fill) => ({ ...orders[0], orderId: fill.orderId, side: fill.side, time: fill.time, updateTime: fill.time })), '/fapi/v1/income': [], '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', updateTime: closing }] });
  let reads = 0;
  const app = await start(t, async (url, headers, signal) => {
    if (['/fapi/v1/klines', '/fapi/v1/markPriceKlines'].includes(url.pathname)) {
      assert.deepEqual(headers, {});
      assert.equal(url.searchParams.has('signature'), false);
      assert.equal(url.searchParams.get('limit'), '499');
      reads++;
      return { status: 200, body: marketRows(url, url.pathname.includes('mark') ? 1 : 0) };
    }
    return base(url, headers, signal);
  });
  await app.sync();
  const list = await finished(app);
  const path = `/api/review/trades/${list.trades[0].id}/market?interval=1m`;
  const first = await (await app.get(path)).json();
  assert.equal(first.series.contract.rawCount, 1996);
  assert.equal(first.series.contract.complete, false);
  assert.equal(first.series.contract.sampled, true);
  assert.ok(first.series.contract.candles.length <= 301);
  let chart = first;
  for (let page = 0; page < 3; page++) chart = await (await app.get(path)).json();
  assert.equal(chart.series.contract.complete, true);
  assert.equal(chart.series.mark.complete, true);
  assert.equal(chart.series.contract.rawCount, 7221);
  const old = await (await app.get(`/api/review/market/${first.snapshotId}?source=contract`)).json();
  assert.equal(old.rawCount, 1996);
  assert.equal(old.queriedAt, first.queriedAt);
  assert.equal(old.candles[0].close, '105');
  assert.equal(old.nextOffset, 499);
  const rawMark = await (await app.get(`/api/review/market/${chart.snapshotId}?source=mark&offset=6986`)).json();
  assert.equal(rawMark.candles.length, 235);
  assert.equal(rawMark.nextOffset, null);
  assert.equal(rawMark.candles[0].close, '106');
  const before = reads;
  assert.equal((await (await app.get(path)).json()).snapshotId, chart.snapshotId);
  assert.equal(reads, before);
  assert.equal((await app.get(`/api/review/market/${chart.snapshotId}?source=mark&offset=-1`)).status, 400);
});

test('missing or malformed candles and a failed mark source never produce complete market evidence', async (t) => {
  const anchor = Math.floor(opened / 900_000) * 900_000 + 1000;
  const historyFills = [{ ...fills[0], time: anchor }, { ...fills[1], time: anchor + 60_000 }];
  const base = fixture({ '/fapi/v1/userTrades': historyFills, '/fapi/v1/allOrders': historyFills.map((fill) => ({ ...orders[0], orderId: fill.orderId, side: fill.side, time: fill.time, updateTime: fill.time })), '/fapi/v1/income': [], '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', updateTime: anchor + 60_000 }] });
  let mode: 'gap' | 'invalid' | 'valid' = 'gap';
  let markFail = true;
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/klines') {
      const body = marketRows(url);
      if (mode === 'gap') body.splice(1, 1);
      if (mode === 'invalid') body[0]![2] = '1';
      return { status: 200, body };
    }
    if (url.pathname === '/fapi/v1/markPriceKlines') {
      if (markFail) throw new Error('offline');
      return { status: 200, body: marketRows(url, 1) };
    }
    return base(url, headers, signal);
  });
  await app.sync();
  const list = await finished(app);
  const path = `/api/review/trades/${list.trades[0].id}/market?interval=15m`;
  const partial = await (await app.get(path)).json();
  assert.equal(partial.series.contract.complete, false);
  assert.equal(partial.series.contract.rawCount, 20);
  assert.equal(partial.series.contract.gaps.length, 1);
  assert.equal(partial.series.mark.rawCount, 0);
  assert.equal(partial.series.mark.complete, false);
  assert.match(partial.series.mark.error, /连接失败/);
  mode = 'invalid';
  const invalid = await (await app.get(path)).json();
  assert.equal(invalid.series.contract.rawCount, 20);
  assert.match(invalid.series.contract.error, /高低价不一致/);
  mode = 'valid'; markFail = false;
  const complete = await (await app.get(path)).json();
  assert.equal(complete.series.contract.complete, true);
  assert.equal(complete.series.mark.complete, true);
  assert.equal(complete.series.contract.rawCount, 21);
});

test('an ordinary historical stop is shown only through its actual linked order and retains contract-price basis', async (t) => {
  const history = [{ ...orders[0] }, { ...orders[1], time: opened + 1000, updateTime: closed, type: 'STOP_MARKET', stopPrice: '99', workingType: 'CONTRACT_PRICE' }];
  const base = fixture({ '/fapi/v1/allOrders': history });
  const app = await start(t, async (url, headers, signal) => url.pathname.includes('Klines') || url.pathname.endsWith('/klines') ? { status: 200, body: marketRows(url) } : base(url, headers, signal));
  await app.sync();
  const list = await finished(app);
  const chart = await (await app.get(`/api/review/trades/${list.trades[0].id}/market?interval=15m`)).json();
  assert.equal(chart.stops.length, 1);
  assert.equal(chart.stops[0].kind, 'historical');
  assert.equal(chart.stops[0].price, '99');
  assert.equal(chart.stops[0].basis, 'CONTRACT_PRICE');
  assert.equal(chart.stops[0].time, closed);
  assert.equal(chart.openedAt, new Date(opened).toISOString());
});

test('a permanent early market gap cannot block later available candles', async (t) => {
  const anchor = Math.floor((Date.now() - 10 * 86_400_000) / 60_000) * 60_000;
  const historyFills = [{ ...fills[0], time: anchor }, { ...fills[1], time: anchor + 3 * 86_400_000 }];
  const base = fixture({ '/fapi/v1/userTrades': historyFills, '/fapi/v1/allOrders': historyFills.map((fill) => ({ ...orders[0], orderId: fill.orderId, side: fill.side, time: fill.time, updateTime: fill.time })), '/fapi/v1/income': [], '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', updateTime: historyFills[1]!.time }] });
  const app = await start(t, async (url, headers, signal) => {
    if (['/fapi/v1/klines', '/fapi/v1/markPriceKlines'].includes(url.pathname)) return { status: 200, body: marketRows(url).filter((row) => row[0] !== anchor - 10 * 60_000) };
    return base(url, headers, signal);
  });
  await app.sync();
  const list = await finished(app);
  const path = `/api/review/trades/${list.trades[0].id}/market?interval=1m`;
  const first = await (await app.get(path)).json();
  const second = await (await app.get(path)).json();
  assert.equal(first.series.contract.rawCount, 1995);
  assert.equal(second.series.contract.rawCount, 3991);
  const third = await (await app.get(path)).json();
  assert.equal(third.series.contract.rawCount, 4340);
  assert.equal(third.series.contract.gaps.length, 1);
  assert.equal(third.series.contract.complete, false);
  assert.equal(third.series.contract.candles.at(-1).openTime, anchor + 3 * 86_400_000 + 10 * 60_000);
});

test('a historical stop without an update timestamp is not backdated to its creation', async (t) => {
  const base = fixture({ '/fapi/v1/allOrders': [{ ...orders[0] }, { ...orders[1], type: 'STOP_MARKET', updateTime: 0, stopPrice: '99', workingType: 'CONTRACT_PRICE' }] });
  const app = await start(t, base);
  await app.sync();
  const list = await finished(app);
  const chart = await (await app.get(`/api/review/trades/${list.trades[0].id}/market?interval=15m`)).json();
  assert.equal(chart.stops[0].price, '99');
  assert.match(chart.stops[0].label, /来源更新时间未知/);
  assert.ok(chart.stops[0].time > closed + 86_400_000);
  assert.ok(chart.stops[0].time <= Date.parse(chart.queriedAt));
});

test('open-trade market pagination survives a changing time boundary and same-millisecond retries', async (t) => {
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const opening = now - 2 * 86_400_000;
  const base = fixture({ '/fapi/v1/userTrades': [{ ...fills[0], time: opening }], '/fapi/v1/allOrders': [{ ...orders[0], time: opening, updateTime: opening }], '/fapi/v1/income': [], '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '1', updateTime: opening }] });
  const app = await start(t, async (url, headers, signal) => ['klines', 'markPriceKlines'].some((suffix) => url.pathname.endsWith(suffix)) ? { status: 200, body: marketRows(url) } : base(url, headers, signal));
  await app.sync();
  const list = await finished(app);
  assert.equal(list.trades[0].status, 'open');
  const path = `/api/review/trades/${list.trades[0].id}/market?interval=1m`;
  const first = await (await app.get(path)).json();
  t.mock.timers.setTime(now + 60_000);
  const second = await (await app.get(path)).json();
  assert.equal(first.series.contract.rawCount, 1996);
  assert.equal(second.series.contract.rawCount, 2892);
  assert.ok(second.endTime > first.endTime);
  assert.equal(second.closedAt, null);
  assert.equal(second.series.contract.candles.at(-1).final, false);
  assert.equal(second.series.contract.complete, false);
  const refreshed = await (await app.get(path)).json();
  assert.equal(refreshed.series.contract.rawCount, second.series.contract.rawCount);
});

test('history refuses an unverifiable account before reading or archiving history', async (t) => {
  const app = await start(t, async (url) => {
    if (url.pathname === '/sapi/v1/account/apiRestrictions') return { status: 200, body: permissions };
    if (url.pathname === '/api/v3/account') return { status: 200, body: {} };
    throw new Error('no history may be read without identity');
  });
  const response = await app.sync();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'unverified_identity');
  assert.deepEqual(await (await app.get('/api/review/trades')).json(), {
    source: 'binance', accountId: null, syncStatus: 'not-synced', trades: [],
    filters: defaultReviewFilters(), total: 0, page: 1, pageSize: 20, nextPage: null, options: { symbols: [], tags: [] },
  });
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
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
    if (Array.isArray(response.body) && url.searchParams.get('symbol') === 'ETHUSDT') response.body = response.body.map((row) => ({ ...row, symbol: 'ETHUSDT', ...(url.pathname === '/fapi/v1/income' ? { tranId: Number(row.tranId) + 1000 } : {}) }));
    return response;
  });
  await app.sync();
  assert.equal((await finished(app)).sync.status, 'failed');
  t.mock.timers.setTime(Date.now() + 65_000);
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


test('staged entry and adding after a reduction stay in one reconciled cycle', async (t) => {
  const staged = [
    { ...fills[0]!, id: 10, orderId: 20, qty: '2', commission: '0.2' },
    { ...fills[0]!, id: 11, orderId: 21, qty: '1', commission: '0.1', time: opened + 1000 },
    { ...fills[1]!, id: 12, orderId: 22, qty: '1', realizedPnl: '5', commission: '0.1', time: opened + 2000 },
    { ...fills[0]!, id: 13, orderId: 23, qty: '1', commission: '0.1', time: opened + 3000 },
    { ...fills[1]!, id: 14, orderId: 24, qty: '3', realizedPnl: '15', commission: '0.3' },
  ];
  const app = await start(t, fixture({ '/fapi/v1/userTrades': staged,
    '/fapi/v1/allOrders': staged.map((fill) => ({ ...orders[0]!, orderId: fill.orderId, side: fill.side, origQty: fill.qty, executedQty: fill.qty, time: fill.time })),
    '/fapi/v1/income': [] }));
  await app.sync();
  const data = await finished(app);
  assert.equal(data.trades.length, 1);
  assert.equal(data.trades[0].status, 'closed');
  assert.equal(data.trades[0].netPnl, '19.2');
  const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
  assert.deepEqual(detail.evidence.fills.map((fill: { quantity: string }) => fill.quantity), ['2', '1', '1', '1', '3']);
});


test('one-way reversal shares original evidence and allocates fee remainder to the new cycle', async (t) => {
  const reversed = [
    { ...fills[0]!, id: 20, orderId: 30, qty: '1', commission: '0.01' },
    { ...fills[1]!, id: 21, orderId: 31, qty: '3', realizedPnl: '10', commission: '0.1' },
    { ...fills[0]!, id: 22, orderId: 32, qty: '2', realizedPnl: '6', commission: '0.02', time: closed + 1000 },
  ];
  const app = await start(t, fixture({ '/fapi/v1/userTrades': reversed,
    '/fapi/v1/allOrders': reversed.map((fill) => ({ ...orders[0]!, orderId: fill.orderId, side: fill.side, origQty: fill.qty, executedQty: fill.qty, time: fill.time })), '/fapi/v1/income': [
      { symbol: 'BTCUSDT', incomeType: 'COMMISSION', tranId: 5, tradeId: '21', time: closed, income: '-0.1', asset: 'USDT' },
    ] }));
  await app.sync();
  let data = await finished(app);
  assert.equal(data.trades.length, 2);
  const long = data.trades.find((trade: { side: string }) => trade.side === 'long');
  const short = data.trades.find((trade: { side: string }) => trade.side === 'short');
  assert.equal(long.status, 'closed');
  assert.equal(short.status, 'closed');
  assert.equal(long.commission, '0.04333333');
  assert.equal(short.commission, '0.08666667');
  assert.equal(long.netPnl, '9.95666667');
  assert.equal(short.netPnl, '5.91333333');
  const left = await (await app.get(`/api/review/trades/${long.id}`)).json();
  const right = await (await app.get(`/api/review/trades/${short.id}`)).json();
  assert.equal(left.evidence.fills[1].id, '21');
  assert.equal(right.evidence.fills[0].id, '21');
  assert.equal(left.evidence.fills[1].quantity, '1');
  assert.equal(right.evidence.fills[0].quantity, '2');
  assert.equal(left.evidence.fills[1].realizedPnl, '10');
  assert.equal(right.evidence.fills[0].realizedPnl, '0');
  const leftChart = await (await app.get(`/api/review/trades/${long.id}/market?interval=15m`)).json();
  const rightChart = await (await app.get(`/api/review/trades/${short.id}/market?interval=15m`)).json();
  assert.equal(leftChart.events[1].event, 'exit');
  assert.equal(leftChart.events[1].allocation, 'close');
  assert.equal(rightChart.events[0].event, 'entry');
  assert.equal(rightChart.events[0].allocation, 'open');
  assert.equal(leftChart.events[1].id, rightChart.events[0].id);
  assert.equal(leftChart.events[1].quantity, '1');
  assert.equal(rightChart.events[0].quantity, '2');
  assert.equal(right.evidence.raw.find((row: { kind: string; id: string }) => row.kind === 'trades' && row.id === '21').payload.qty, '3');
  await app.sync();
  data = await finished(app);
  assert.deepEqual(data.trades.map((trade: { netPnl: string }) => trade.netPnl).sort(), ['5.91333333', '9.95666667']);
});


test('hedge long and short cycles reconcile independently even with simultaneous fills', async (t) => {
  const hedged = [
    { ...fills[0]!, id: 101, orderId: 201, positionSide: 'LONG', qty: '2', commission: '0.02' },
    { ...fills[1]!, id: 102, orderId: 202, positionSide: 'SHORT', qty: '1', commission: '0.01', realizedPnl: '0', time: opened },
    { ...fills[1]!, id: 103, orderId: 203, positionSide: 'LONG', qty: '2', commission: '0.02', realizedPnl: '8' },
    { ...fills[0]!, id: 104, orderId: 204, positionSide: 'SHORT', qty: '1', commission: '0.01', realizedPnl: '3', time: closed + 1000 },
  ];
  const app = await start(t, fixture({ '/fapi/v1/userTrades': [...hedged].reverse(),
    '/fapi/v1/allOrders': hedged.map((fill) => ({ ...orders[0]!, orderId: fill.orderId, side: fill.side, positionSide: fill.positionSide, origQty: fill.qty, executedQty: fill.qty, time: fill.time })),
    '/fapi/v1/income': [], '/fapi/v2/positionRisk': [
      { symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0' },
      { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '0' },
    ] }));
  await app.sync();
  const data = await finished(app);
  assert.equal(data.trades.length, 2);
  const long = data.trades.find((trade: { side: string }) => trade.side === 'long');
  const short = data.trades.find((trade: { side: string }) => trade.side === 'short');
  assert.equal(long.status, 'closed');
  assert.equal(short.status, 'closed');
  assert.equal(long.netPnl, '7.96');
  assert.equal(short.netPnl, '2.98');
  const detail = await (await app.get(`/api/review/trades/${short.id}`)).json();
  assert.deepEqual(detail.evidence.fills.map((fill: { id: string }) => fill.id), ['102', '104']);
});


test('an open cycle carries funding through the query boundary and separates snapshot unrealized PnL', async (t) => {
  const app = await start(t, fixture({ '/fapi/v1/userTrades': [fills[0]], '/fapi/v1/allOrders': [orders[0]],
    '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '1', unRealizedProfit: '7.25', marginType: 'isolated', leverage: '20' }],
    '/fapi/v1/income': [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', tranId: 9, time: closed + 1000, income: '-0.25', asset: 'USDT' }] }));
  await app.sync();
  const data = await finished(app);
  const trade = data.trades[0];
  assert.equal(trade.status, 'open');
  assert.equal(trade.closedAt, null);
  assert.equal(trade.netPnl, null);
  assert.equal(trade.realizedPnl, '0');
  assert.equal(trade.fundingNet, '-0.25');
  assert.equal(trade.unrealizedPnl, '7.25');
  assert.ok(Date.parse(trade.observedAt) >= data.sync.endTime);
  assert.equal(trade.groupingVersion, 2);
});


test('funding without position-side evidence cannot confirm either overlapping hedge cycle', async (t) => {
  const hedged = [
    { ...fills[0]!, id: 301, orderId: 401, positionSide: 'LONG' },
    { ...fills[1]!, id: 302, orderId: 402, positionSide: 'SHORT', realizedPnl: '0', time: opened + 1000 },
    { ...fills[1]!, id: 303, orderId: 403, positionSide: 'LONG' },
    { ...fills[0]!, id: 304, orderId: 404, positionSide: 'SHORT', realizedPnl: '3', time: closed + 1000 },
  ];
  const app = await start(t, fixture({ '/fapi/v1/userTrades': hedged,
    '/fapi/v1/allOrders': hedged.map((fill) => ({ ...orders[0]!, orderId: fill.orderId, side: fill.side, positionSide: fill.positionSide, time: fill.time })),
    '/fapi/v1/income': [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', tranId: 33, time: opened + 2000, income: '-0.5', asset: 'USDT' }],
    '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0' }, { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '0' }] }));
  await app.sync();
  const data = await finished(app);
  assert.equal(data.trades.length, 2);
  for (const trade of data.trades) {
    assert.equal(trade.netPnl, null);
    assert.equal(trade.fundingNet, null);
    assert.ok(trade.missing.includes('资金费无法唯一归属'));
    const detail = await (await app.get(`/api/review/trades/${trade.id}`)).json();
    assert.equal(detail.evidence.funding[0].amount, '-0.5');
  }
});


test('same-millisecond close and reopen use exact trade IDs and share an order without losing quantities', async (t) => {
  const simultaneous = [
    { ...fills[0]!, id: '90071992547409930', orderId: 601 },
    { ...fills[1]!, id: '90071992547409931', orderId: 602 },
    { ...fills[1]!, id: '90071992547409932', orderId: 602, realizedPnl: '0' },
    { ...fills[0]!, id: '90071992547409933', orderId: 603, realizedPnl: '4', time: closed + 1000 },
  ];
  const app = await start(t, fixture({ '/fapi/v1/userTrades': [...simultaneous].reverse(),
    '/fapi/v1/allOrders': [
      { ...orders[0]!, orderId: 601 },
      { ...orders[1]!, orderId: 602, origQty: '2', executedQty: '2' },
      { ...orders[0]!, orderId: 603, time: closed + 1000 },
    ], '/fapi/v1/income': [] }));
  await app.sync();
  const data = await finished(app);
  assert.deepEqual(data.trades.map((trade: { netPnl: string }) => trade.netPnl).sort(), ['3.8', '9.8']);
  const short = data.trades.find((trade: { side: string }) => trade.side === 'short');
  const detail = await (await app.get(`/api/review/trades/${short.id}`)).json();
  assert.equal(detail.evidence.fills[0].id, '90071992547409932');
  assert.equal(detail.evidence.orders[0].quantity, '1');
});

test('funding at a reversal boundary remains attributable evidence rather than double-counted income', async (t) => {
  const reversed = [fills[0]!, { ...fills[1]!, qty: '2' }, { ...fills[0]!, id: 3, orderId: 13, time: closed + 1000, realizedPnl: '5' }];
  const app = await start(t, fixture({ '/fapi/v1/userTrades': reversed,
    '/fapi/v1/allOrders': reversed.map((fill) => ({ ...orders[0]!, orderId: fill.orderId, side: fill.side, origQty: fill.qty, executedQty: fill.qty, time: fill.time })),
    '/fapi/v1/income': [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', tranId: 8, time: closed, income: '-1', asset: 'USDT' }] }));
  await app.sync();
  const data = await finished(app);
  assert.equal(data.trades.length, 2);
  assert.ok(data.trades.every((trade: { fundingNet: string | null; netPnl: string | null }) => trade.fundingNet === null && trade.netPnl === null));
});

test('a failed resync retains the closed reversal allocation and exposes its remaining opening quantity', async (t) => {
  const reversed = [fills[0]!, { ...fills[1]!, qty: '3', commission: '0.1' }];
  let failPosition = false;
  const base = fixture({ '/fapi/v1/userTrades': reversed,
    '/fapi/v1/allOrders': reversed.map((fill) => ({ ...orders[0]!, orderId: fill.orderId, side: fill.side, origQty: fill.qty, executedQty: fill.qty, time: fill.time })),
    '/fapi/v1/income': [], '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-2' }] });
  const app = await start(t, async (url, headers, signal) => failPosition && url.pathname === '/fapi/v2/positionRisk' ? { status: 503, body: {} } : base(url, headers, signal));
  await app.sync();
  let data = await finished(app);
  const closedTrade = data.trades.find((trade: { status: string }) => trade.status === 'closed');
  assert.equal(closedTrade.commission, '0.13333333');
  failPosition = true;
  await app.sync();
  data = await finished(app);
  assert.equal(data.trades.length, 2);
  assert.equal(data.trades.find((trade: { id: string }) => trade.id === closedTrade.id).netPnl, '9.86666667');
  const fragment = data.trades.find((trade: { status: string }) => trade.status === 'incomplete');
  const detail = await (await app.get(`/api/review/trades/${fragment.id}`)).json();
  assert.equal(detail.evidence.fills[0].quantity, '2');
  assert.equal(detail.commission, '0.06666667');
  assert.equal(detail.realizedPnl, '0');
});


test('conditional execution types retain their linked algo order rather than only the child market order', async (t) => {
  const app = await start(t, fixture({ '/fapi/v1/allAlgoOrders': [{ symbol: 'BTCUSDT', algoId: 800, actualOrderId: '12', orderType: 'STOP_MARKET', side: 'SELL', positionSide: 'BOTH', createTime: closed - 1000 }] }));
  await app.sync();
  const data = await finished(app);
  const detail = await (await app.get(`/api/review/trades/${data.trades[0].id}`)).json();
  assert.equal(detail.evidence.orders[1].type, 'STOP_MARKET');
  assert.equal(detail.evidence.orders[1].algoId, '800');
  assert.ok(detail.evidence.raw.some((row: { kind: string; id: string }) => row.kind === 'algoHistory' && row.id === '800'));
});


test('a first visible reversal retains an incomplete old fragment and a distinct reliable new cycle', async (t) => {
  const reversal = { ...fills[1]!, qty: '2', commission: '0.2' };
  const sourceFills = [reversal];
  const sourceOrders = [{ ...orders[1]!, origQty: '2', executedQty: '2' }];
  const app = await start(t, fixture({ '/fapi/v1/userTrades': sourceFills,
    '/fapi/v1/allOrders': sourceOrders,
    '/fapi/v1/income': [], '/fapi/v2/positionRisk': [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-1' }] }));
  await app.sync();
  const data = await finished(app);
  assert.equal(data.sync.status, 'complete');
  assert.equal(data.trades.length, 2);
  assert.equal(new Set(data.trades.map((trade: { id: string }) => trade.id)).size, 2);
  const old = data.trades.find((trade: { status: string }) => trade.status === 'incomplete');
  const next = data.trades.find((trade: { status: string }) => trade.status === 'open');
  assert.equal(old.openedAt, null);
  assert.equal(old.realizedPnl, '10');
  assert.equal(old.commission, '0.1');
  assert.equal(next.side, 'short');
  assert.equal(next.commission, '0.1');
  assert.equal(next.realizedPnl, '0');
  const oldDetail = await (await app.get(`/api/review/trades/${old.id}`)).json();
  const nextDetail = await (await app.get(`/api/review/trades/${next.id}`)).json();
  const oldChart = await (await app.get(`/api/review/trades/${old.id}/market?interval=15m`)).json();
  const nextChart = await (await app.get(`/api/review/trades/${next.id}/market?interval=15m`)).json();
  assert.equal(oldChart.openedAt, null);
  assert.equal(nextChart.closedAt, null);
  assert.equal(oldChart.stops.length, 0);
  assert.equal(nextChart.stops.length, 0);
  assert.equal(nextChart.events[0].event, 'entry');
  const save = (id: string, basis: string, freeNote: string) => fetch(`${app.base}/api/review/trades/${id}/note`, {
    method: 'POST', headers: { Cookie: app.cookie, Origin: app.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteId: null, version: 0, basis, entryReason: '', exitReason: '', executionProblem: '', improvement: '', freeNote, tagIds: [] }),
  });
  assert.equal((await save(old.id, oldDetail.noteBasis, '旧周期片段')).status, 200);
  assert.equal((await save(next.id, nextDetail.noteBasis, '反手新周期')).status, 200);
  sourceFills.push(fills[0]!);
  sourceOrders.push(orders[0]!);
  await app.sync();
  const supplemented = await finished(app);
  assert.equal(supplemented.trades.length, 2);
  assert.equal(supplemented.trades.find((trade: { status: string }) => trade.status === 'closed').netPnl, '9.8');
  assert.equal(supplemented.trades.find((trade: { status: string }) => trade.status === 'open').id, next.id);
  const journal = await (await app.get('/api/review/journal')).json();
  assert.equal(journal.notes.find((note: { freeNote: string }) => note.freeNote === '旧周期片段').binding, 'pending');
  const stable = journal.notes.find((note: { freeNote: string }) => note.freeNote === '反手新周期');
  assert.equal(stable.binding, 'current');
  assert.equal(stable.trade.id, next.id);
});

test('realized PnL on a reconstructed opening fill contradicts a complete starting chain', async (t) => {
  const app = await start(t, fixture({ '/fapi/v1/userTrades': [{ ...fills[0]!, realizedPnl: '5' }, fills[1]!] }));
  await app.sync();
  const data = await finished(app);
  assert.equal(data.trades[0].status, 'incomplete');
  assert.equal(data.trades[0].netPnl, null);
  assert.equal(data.trades[0].openedAt, null);
});
