import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server.ts';

const input = { symbol: 'BTCUSDT', side: 'long', budgetMode: 'amount', budget: '20', stopMode: 'price', stop: '98', slippage: '1', funding: '1', leverage: '10', minimumBuffer: '1', fundingCap: '5' };

function fixture() {
  const now = Date.now() - 1000;
  const position = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', entryPrice: '0', liquidationPrice: '0', leverage: '10', marginType: 'isolated', isolatedWallet: '0', updateTime: now };
  const data: Record<string, unknown> = {
    '/fapi/v1/time': { serverTime: now },
    '/sapi/v1/account/apiRestrictions': { enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, enableMargin: false, enableFutures: false, permitsUniversalTransfer: false, enableVanillaOptions: false, enableFixApiTrade: false, enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false },
    '/sapi/v1/portfolio/account': { code: -21001 },
    '/fapi/v2/account': { canTrade: true, multiAssetsMargin: false, assets: [{ asset: 'USDT', walletBalance: '1000', unrealizedProfit: '0', marginBalance: '1000', availableBalance: '1000' }], positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', isolated: true }] },
    '/fapi/v1/positionSide/dual': { dualSidePosition: false },
    '/fapi/v2/positionRisk': [position],
    '/fapi/v1/openOrders': [], '/fapi/v1/openAlgoOrders': [],
    '/fapi/v1/userTrades': [], '/fapi/v1/allOrders': [], '/fapi/v1/income': [],
    '/fapi/v1/commissionRate': { symbol: 'BTCUSDT', takerCommissionRate: '0.001' },
    '/fapi/v1/leverageBracket': { symbol: 'BTCUSDT', brackets: [{ bracket: 1, initialLeverage: 20, notionalFloor: 0, notionalCap: 1000000, maintMarginRatio: 0.01, cum: 0 }] },
    '/fapi/v2/ticker/price': { symbol: 'BTCUSDT', price: '100', time: now },
    '/fapi/v1/ticker/bookTicker': { symbol: 'BTCUSDT', bidPrice: '99', askPrice: '100', time: now },
    '/fapi/v1/premiumIndex': { symbol: 'BTCUSDT', markPrice: '100', time: now },
    '/fapi/v1/exchangeInfo': { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', orderTypes: ['MARKET', 'STOP_MARKET'], marketTakeBound: '0.30', filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.1', maxQty: '1000', stepSize: '0.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ] }] },
  };
  return { data, position, now };
}

async function start(t: TestContext, f = fixture(), mode: 'real' | 'demo' = 'real') {
  const requests: URL[] = [];
  const server = createServer({ password: 'test-password-only', mode, apiKey: 'test-key', apiSecret: 'test-secret', transport: async (url, headers, signal) => {
    requests.push(url);
    assert.ok(url.pathname in f.data, `Unexpected endpoint ${url.pathname}`);
    const isPublic = ['/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/ticker/bookTicker', '/fapi/v1/premiumIndex', '/fapi/v2/ticker/price'].includes(url.pathname);
    assert.equal(headers['X-MBX-APIKEY'], isPublic ? undefined : 'test-key');
    const source = f.data[url.pathname];
    const body: unknown = typeof source === 'function' ? await source(signal) : source;
    if (body instanceof Error) throw body;
    return { status: url.pathname.includes('/portfolio/') ? 400 : 200, body: structuredClone(body) };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-password-only' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const read = (path: string) => fetch(base + path, { headers: { Cookie: cookie } });
  const create = (value = input) => fetch(`${base}/api/plan`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { ...f, base, cookie, read, create, requests };
}

function fill(f: ReturnType<typeof fixture>) {
  const time = f.now + 100;
  f.data['/fapi/v1/time'] = { serverTime: time + 100 };
  Object.assign(f.position, { positionAmt: '0.4', entryPrice: '100', liquidationPrice: '90', isolatedWallet: '4', updateTime: time });
  f.data['/fapi/v1/userTrades'] = [
    { symbol: 'BTCUSDT', id: 1, orderId: 10, side: 'BUY', positionSide: 'BOTH', time, price: '100', qty: '0.1', quoteQty: '10', commission: '0.01', commissionAsset: 'USDT', realizedPnl: '0' },
    { symbol: 'BTCUSDT', id: 2, orderId: 10, side: 'BUY', positionSide: 'BOTH', time, price: '100', qty: '0.3', quoteQty: '30', commission: '0.03', commissionAsset: 'USDT', realizedPnl: '0' },
  ];
  f.data['/fapi/v1/allOrders'] = [{ symbol: 'BTCUSDT', orderId: 10, side: 'BUY', positionSide: 'BOTH', type: 'MARKET', origType: 'MARKET', status: 'FILLED', time, updateTime: time, origQty: '0.4', executedQty: '0.4', avgPrice: '100', reduceOnly: false, closePosition: false }];
  f.data['/fapi/v1/income'] = [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: '-0.3', asset: 'USDT', time: time + 1, tranId: 123 }];
  return { symbol: 'BTCUSDT', algoId: 20, algoType: 'CONDITIONAL', algoStatus: 'NEW', orderType: 'STOP_MARKET', side: 'SELL', positionSide: 'BOTH', quantity: '0', triggerPrice: '98', workingType: 'MARK_PRICE', priceProtect: false, closePosition: true, reduceOnly: false, actualOrderId: '', triggerTime: 0, createTime: time, updateTime: time, timeInForce: 'GTC', goodTillDate: 0 };
}

test('a frozen entry plan has a confirmed flat starting point; an empty position waits, never passes', async (t) => {
  const app = await start(t);
  const response = await app.create();
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.budget, '20');
  assert.equal(plan.stopPrice, '98');
  assert.ok(plan.id);
  assert.equal(plan.startedAt, new Date(app.now).toISOString());
  const result = await app.read(`/api/verification?planId=${plan.id}`);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, 'waiting');
});

test('refresh finds missing protection, then verifies a single stop with actual costs after manual correction', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  const stop = fill(app);
  const path = `/api/verification?planId=${plan.id}`;
  const missing = await (await app.read(path)).json();
  assert.equal(missing.status, 'needs-action');
  assert.match(missing.issues.join(' '), /止损/);
  app.data['/fapi/v1/openAlgoOrders'] = [stop];
  const verified = await (await app.read(path)).json();
  assert.equal(verified.status, 'verified');
  assert.equal(verified.orderId, '10');
  assert.equal(verified.quantity, '0.4');
  assert.equal(verified.entryPrice, '100');
  assert.equal(verified.paidCommission, '0.04');
  assert.equal(verified.paidFunding, '0.3');
  assert.equal(verified.remainingFunding, '0.7');
  assert.equal(verified.plannedLoss, '2.270808');
  assert.equal(verified.liquidationBuffer, '8');
  assert.ok(Date.parse(verified.queriedAt));
});

test('fixed reduce-only exits cover exactly the position and obey quantity rules without an opening notional minimum', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  const stop = { ...fill(app), closePosition: false, reduceOnly: true, quantity: '0.4' };
  app.data['/fapi/v1/openAlgoOrders'] = [stop];
  const exchange = app.data['/fapi/v1/exchangeInfo'] as { symbols: { filters: Record<string, string>[] }[] };
  exchange.symbols[0]!.filters.find((filter) => filter.filterType === 'MIN_NOTIONAL')!.notional = '1000';
  const path = `/api/verification?planId=${plan.id}`;
  const valid = await (await app.read(path)).json();
  assert.equal(valid.status, 'verified');
  assert.match(valid.coverage, /固定数量.*0.4/);
  stop.quantity = '0.3';
  const short = await (await app.read(path)).json();
  assert.equal(short.status, 'needs-action');
  assert.match(short.issues.join(' '), /缺口 0.1/);
  stop.quantity = '0.4';
  exchange.symbols[0]!.filters.find((filter) => filter.filterType === 'MARKET_LOT_SIZE')!.stepSize = '0.2';
  const badStep = await (await app.read(path)).json();
  assert.equal(badStep.status, 'needs-action');
  assert.match(badStep.issues.join(' '), /数量规则/);
  Object.assign(stop, { closePosition: true, reduceOnly: false, quantity: '0' });
  assert.equal((await (await app.read(path)).json()).status, 'verified');
});

test('a reconciled full close is ended, while partial closes and reopened positions remain incomplete', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  fill(app);
  const trades = app.data['/fapi/v1/userTrades'] as Record<string, unknown>[];
  const history = app.data['/fapi/v1/allOrders'] as Record<string, unknown>[];
  const closing = { ...trades[0], id: 3, orderId: 11, side: 'SELL', qty: '0.4', quoteQty: '40', realizedPnl: '0', commission: '0.04', time: app.now + 150 };
  trades.push(closing);
  history.push({ ...history[0], orderId: 11, side: 'SELL', reduceOnly: true, time: app.now + 150 });
  Object.assign(app.position, { positionAmt: '0', entryPrice: '0', liquidationPrice: '0' });
  const path = `/api/verification?planId=${plan.id}`;
  assert.equal((await (await app.read(path)).json()).status, 'ended');
  closing.qty = '0.2';
  history[1]!.executedQty = '0.2';
  app.position.positionAmt = '0.2';
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  closing.qty = '0.4';
  history[1]!.executedQty = '0.4';
  trades.push({ ...trades[0], id: 4, orderId: 12, qty: '0.2', time: app.now + 175 });
  history.push({ ...history[0], orderId: 12, executedQty: '0.2', time: app.now + 175 });
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
});

test('incorrect stop parameters and terminal states never count as protection', async (t) => {
  const cases: [string, Record<string, unknown>][] = [
    ['direction', { side: 'BUY' }], ['position side', { positionSide: 'LONG' }], ['type', { orderType: 'STOP' }],
    ['trigger', { triggerPrice: '97' }], ['basis', { workingType: 'CONTRACT_PRICE' }], ['price protection', { priceProtect: true }],
    ['canceled', { algoStatus: 'CANCELED' }], ['expired', { algoStatus: 'EXPIRED' }], ['filled', { algoStatus: 'FINISHED' }],
    ['triggered', { triggerTime: 1, actualOrderId: '99' }], ['unrecognized status', { algoStatus: 'UNKNOWN' }],
    ['non-reducing', { closePosition: false, reduceOnly: false, quantity: '0.4' }], ['expired GTD', { timeInForce: 'GTD', goodTillDate: 1 }],
  ];
  for (const [name, patch] of cases) await t.test(name, async (t) => {
    const app = await start(t);
    const plan = await (await app.create()).json();
    app.data['/fapi/v1/openAlgoOrders'] = [{ ...fill(app), ...patch }];
    const result = await (await app.read(`/api/verification?planId=${plan.id}`)).json();
    assert.equal(result.status, 'needs-action');
    assert.ok(result.issues.length);
  });
});

test('actual risk and liquidation use the original budget, stop and buffer; lower leverage is acceptable', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
  const path = `/api/verification?planId=${plan.id}`;
  app.position.leverage = '5';
  assert.equal((await (await app.read(path)).json()).status, 'verified');
  app.position.leverage = '11';
  assert.match((await (await app.read(path)).json()).issues.join(' '), /实际杠杆 11.*10/);
  app.position.leverage = '10';
  app.position.liquidationPrice = '99';
  const insufficient = await (await app.read(path)).json();
  assert.equal(insufficient.status, 'needs-action');
  assert.equal(insufficient.liquidationBuffer, '-1');
  assert.match(insufficient.issues.join(' '), /差 2 个百分点/);
  app.position.liquidationPrice = '90';
  app.data['/fapi/v1/income'] = [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: '-25', asset: 'USDT', time: app.now + 150, tranId: 123 }];
  const exceeded = await (await app.read(path)).json();
  assert.equal(exceeded.status, 'needs-action');
  assert.equal(exceeded.plannedLoss, '26.270808');
  assert.equal(exceeded.excess, '6.270808');
  assert.equal(exceeded.remainingFunding, '0');
  assert.match(exceeded.issues.join(' '), /原止损 98.*原预算 20/);
});

test('rounded exchange averages cannot hide a budget overrun or enlarge the liquidation buffer', async (t) => {
  const app = await start(t);
  const plan = await (await app.create({ ...input, budget: '2.270808' })).json();
  app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
  (app.data['/fapi/v1/userTrades'] as Record<string, unknown>[])[1]!.price = '100.00000001';
  const result = await (await app.read(`/api/verification?planId=${plan.id}`)).json();
  assert.equal(result.status, 'needs-action');
  assert.equal(result.plannedLoss, '2.27080801');
  assert.equal(result.excess, '0.00000001');
  assert.equal(result.liquidationBuffer, '7.99999999');
});

test('missing, conflicting or unsupported attribution data cannot produce a passing result', async (t) => {
  const cases: [string, (app: Awaited<ReturnType<typeof start>>) => void][] = [
    ['missing trades', (app) => { app.data['/fapi/v1/userTrades'] = []; }],
    ['missing history', (app) => { app.data['/fapi/v1/allOrders'] = []; }],
    ['quantity mismatch', (app) => { app.position.positionAmt = '0.5'; }],
    ['direction mismatch', (app) => { app.position.positionAmt = '-0.4'; }],
    ['entry mismatch', (app) => { app.position.entryPrice = '101'; }],
    ['no liquidation', (app) => { app.position.liquidationPrice = '0'; }],
    ['multiple entries', (app) => { (app.data['/fapi/v1/userTrades'] as Record<string, unknown>[])[1]!.orderId = 11; }],
    ['non USDT fee', (app) => { (app.data['/fapi/v1/userTrades'] as Record<string, unknown>[])[0]!.commissionAsset = 'BNB'; }],
    ['duplicate fill', (app) => { const trades = app.data['/fapi/v1/userTrades'] as unknown[]; trades.push(trades[0]); }],
    ['incomplete page', (app) => { app.data['/fapi/v1/income'] = Array(1000).fill((app.data['/fapi/v1/income'] as unknown[])[0]); }],
  ];
  for (const [name, change] of cases) await t.test(name, async (t) => {
    const app = await start(t);
    const plan = await (await app.create()).json();
    app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
    change(app);
    const result = await (await app.read(`/api/verification?planId=${plan.id}`)).json();
    assert.equal(result.status, 'incomplete');
    assert.ok(result.issues.length);
  });
});

test('short positions and ordinary stop orders use the buy-to-close direction and current liquidation value', async (t) => {
  const app = await start(t);
  const plan = await (await app.create({ ...input, side: 'short', stop: '102' })).json();
  fill(app);
  Object.assign(app.position, { positionAmt: '-0.4', liquidationPrice: '110' });
  for (const item of [...app.data['/fapi/v1/userTrades'] as Record<string, unknown>[], ...app.data['/fapi/v1/allOrders'] as Record<string, unknown>[]]) item.side = 'SELL';
  app.data['/fapi/v1/openOrders'] = [{ symbol: 'BTCUSDT', orderId: 20, status: 'NEW', type: 'STOP_MARKET', side: 'BUY', positionSide: 'BOTH', origQty: '0', executedQty: '0', stopPrice: '102', workingType: 'MARK_PRICE', priceProtect: false, closePosition: true, reduceOnly: true, updateTime: app.now + 100, timeInForce: 'GTC', goodTillDate: 0 }];
  const result = await (await app.read(`/api/verification?planId=${plan.id}`)).json();
  assert.equal(result.status, 'verified');
  assert.equal(result.plannedLoss, '2.289208');
  assert.equal(result.liquidationBuffer, '8');
});

test('remaining entry orders prevent completion even beside a valid stop', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
  app.data['/fapi/v1/openOrders'] = [{ symbol: 'BTCUSDT', orderId: 30, status: 'PARTIALLY_FILLED', type: 'LIMIT', side: 'BUY', positionSide: 'BOTH', origQty: '1', executedQty: '0.1', stopPrice: '0', workingType: 'CONTRACT_PRICE', priceProtect: false, closePosition: false, reduceOnly: false, updateTime: app.now + 100, timeInForce: 'GTC', goodTillDate: 0 }];
  const result = await (await app.read(`/api/verification?planId=${plan.id}`)).json();
  assert.equal(result.status, 'needs-action');
  assert.match(result.issues.join(' '), /未成交入场余单/);
});

test('partial query failures, missing permission and changing snapshots revoke a previous successful check', async (t) => {
  for (const scenario of ['failure', 'permission', 'snapshot']) await t.test(scenario, async (t) => {
    const app = await start(t);
    const plan = await (await app.create()).json();
    app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
    const path = `/api/verification?planId=${plan.id}`;
    assert.equal((await (await app.read(path)).json()).status, 'verified');
    if (scenario === 'failure') app.data['/fapi/v1/openAlgoOrders'] = new Error('private-test-key?signature=secret');
    if (scenario === 'permission') app.data['/sapi/v1/account/apiRestrictions'] = { enableReading: false };
    if (scenario === 'snapshot') {
      let first = true;
      app.data['/fapi/v2/positionRisk'] = () => {
        const position = { ...app.position, positionAmt: first ? '0.4' : '0.3' };
        first = false;
        return [position];
      };
    }
    const response = await app.read(path);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.status, undefined);
    assert.ok(result.attemptedAt);
    assert.doesNotMatch(JSON.stringify(result), /private-test|signature=secret/);
  });
});

test('verification is session-bound and cannot override the frozen budget or signed query parameters', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  assert.equal((await fetch(`${app.base}/api/verification?planId=${plan.id}`)).status, 401);
  assert.equal((await app.read('/api/verification?planId=unknown')).status, 409);
  assert.equal((await app.read(`/api/verification?planId=${plan.id}&budget=999`)).status, 400);
  assert.equal((await app.read(`/api/verification?planId=${plan.id}&url=https://example.com`)).status, 400);
  assert.equal((await app.create({ ...input, symbol: 'https://example.com' })).status, 400);
  fill(app);
  for (const operation of ['/fapi/v1/userTrades', '/fapi/v1/allOrders', '/fapi/v1/income']) {
    await app.read(`/api/verification?planId=${plan.id}`);
    const request = app.requests.findLast((url) => url.pathname === operation)!;
    assert.equal(request.searchParams.get('symbol'), 'BTCUSDT');
    assert.equal(request.searchParams.get('startTime'), String(app.now));
    assert.equal(request.searchParams.get('limit'), '1000');
  }
});

test('demo offers an explicit missing-stop to corrected flow without contacting Binance', async (t) => {
  const app = await start(t, fixture(), 'demo');
  const plan = await (await app.create()).json();
  const path = `/api/verification?planId=${plan.id}`;
  assert.equal((await (await app.read(path + '&demo=missing-stop')).json()).status, 'needs-action');
  const result = await (await app.read(path + '&demo=protected')).json();
  assert.equal(result.status, 'verified');
  assert.equal(result.source, 'demo');
  assert.equal((await app.read(path + '&demo=failure')).status, 503);
  assert.equal((await (await app.read(path + '&demo=waiting')).json()).status, 'waiting');
  assert.equal(app.requests.length, 0);
});

test('plan creation refuses trading during the flat-baseline query and keeps the old plan available', async (t) => {
  const app = await start(t);
  const oldPlan = await (await app.create()).json();
  fill(app);
  const refused = await app.create();
  assert.equal(refused.status, 502);
  assert.equal((await refused.json()).code, 'unconfirmed_start');
  app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
  assert.equal((await (await app.read(`/api/verification?planId=${oldPlan.id}`)).json()).status, 'verified');
});

test('an original plan remains verifiable when a later generation response is discarded by the page', async (t) => {
  const app = await start(t);
  const original = await (await app.create()).json();
  const discarded = await (await app.create({ ...input, budget: '25' })).json();
  assert.notEqual(discarded.id, original.id);
  app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
  const response = await app.read(`/api/verification?planId=${original.id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'verified');
});

test('inconsistent position times and unexplained realized PnL cannot pass', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
  const path = `/api/verification?planId=${plan.id}`;
  app.position.updateTime = app.now + 10_000;
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  app.position.updateTime = app.now + 100;
  app.data['/fapi/v1/income'] = [{ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '-1', asset: 'USDT', time: app.now + 150 }];
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
});

test('a verification timeout returns no passing status and retains the server-side original plan for retry', async (t) => {
  const app = await start(t);
  const plan = await (await app.create()).json();
  const stop = fill(app);
  app.data['/fapi/v1/openAlgoOrders'] = [stop];
  const path = `/api/verification?planId=${plan.id}`;
  assert.equal((await (await app.read(path)).json()).status, 'verified');
  app.data['/fapi/v1/openAlgoOrders'] = (signal: AbortSignal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const response = await app.read(path);
  assert.equal(response.status, 504);
  const failed = await response.json();
  assert.equal(failed.code, 'timeout');
  assert.equal(failed.status, undefined);
  app.data['/fapi/v1/time'] = () => ({ serverTime: Date.now() });
  app.data['/fapi/v1/openAlgoOrders'] = [stop];
  assert.equal((await (await app.read(path)).json()).status, 'verified');
});
