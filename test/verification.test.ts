import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server.ts';
import type { EntryInput } from '../public/draft.js';

const input = { symbol: 'BTCUSDT', side: 'long', budgetMode: 'amount', budget: '20', stopMode: 'price', stop: '98', slippage: '1', funding: '1', leverage: '10', minimumBuffer: '1', fundingCap: '5' };
const limitInput = { ...input, entryType: 'LIMIT', limitPrice: '100' };
const twoInput = { ...input, stopLevels: 'two', nearStopMode: 'price', nearStop: '99', nearPercent: '70' };

test('demo exposes final-only, both stops, near-filled remainder and attribution failure through the same verifier', async (t) => {
  const app = await start(t, fixture(), 'demo');
  for (const entryType of ['MARKET', 'LIMIT']) {
    const plan = await (await app.create({ ...twoInput, entryType, limitPrice: '100' })).json();
    const read = async (scenario: string) => {
      const response = await app.read(`/api/verification?planId=${plan.id}&demo=${scenario}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await read('final-only')).status, 'needs-action');
    assert.equal((await read('protected')).status, 'verified');
    const filled = await read('near-filled');
    assert.equal(filled.status, 'verified');
    assert.equal(filled.quantity, entryType === 'MARKET' ? '0.2' : '0.195');
    assert.equal(filled.plannedLoss, entryType === 'MARKET' ? '1.875204' : '1.9792189');
    assert.equal((await read('final-canceled')).status, 'needs-action');
    assert.equal((await read('missing-attribution')).status, 'incomplete');
    if (entryType === 'LIMIT') {
      assert.equal((await read('partial')).status, 'needs-action');
      const canceled = await read('canceled-remainder');
      assert.equal(canceled.status, 'verified');
      assert.equal(canceled.nearQuantity, '0.2');
      assert.equal(canceled.nearActualPercent, '53.90835579');
    }
  }
});

test('two-level verification checks near allocation and final whole-position cover independently', async (t) => {
  const app = await start(t);
  const response = await app.create(twoInput);
  assert.equal(response.status, 200);
  const plan = await response.json();
  const final = fill(app);
  const near = { ...final, algoId: 21, closePosition: false, reduceOnly: true, quantity: '0.2', triggerPrice: '99' };
  app.data['/fapi/v1/openAlgoOrders'] = [final];
  app.data['/fapi/v1/allAlgoOrders'] = [final];
  const path = `/api/verification?planId=${plan.id}`;
  const onlyFinal = await (await app.read(path)).json();
  assert.equal(onlyFinal.status, 'needs-action');
  assert.match(onlyFinal.issues.join(' '), /近端.*补齐/);
  app.data['/fapi/v1/openAlgoOrders'] = [final, near];
  app.data['/fapi/v1/allAlgoOrders'] = [final, near];
  const both = await (await app.read(path)).json();
  assert.equal(both.status, 'verified');
  assert.equal(both.nearQuantity, '0.2');
  assert.equal(both.nearActualPercent, '50');
  assert.match(both.coverage, /整仓/);
  app.data['/fapi/v1/allAlgoOrders'] = [final, near, { ...near, algoId: 22, algoStatus: 'TRIGGERED', actualOrderId: '12', triggerTime: app.now + 150 }];
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  app.data['/fapi/v1/allAlgoOrders'] = [{ ...final, algoStatus: 'CANCELED', updateTime: app.now + 150 }, near];
  const conflict = await (await app.read(path)).json();
  assert.equal(conflict.status, 'incomplete');
  assert.match(conflict.issues.join(' '), /条件单.*不一致/);
  app.data['/fapi/v1/allAlgoOrders'] = [final, near];
  near.quantity = '0.3';
  assert.equal((await (await app.read(path)).json()).status, 'needs-action');
  near.quantity = '0.2';
  final.algoStatus = 'CANCELED';
  const canceled = await (await app.read(path)).json();
  assert.equal(canceled.status, 'needs-action');
  assert.match(canceled.issues.join(' '), /最终.*缺失/);
});

test('an attributable near fill includes realized loss and all paid costs before checking the remainder', async (t) => {
  const app = await start(t);
  const plan = await (await app.create({ ...twoInput, entryType: 'LIMIT', limitPrice: '100' })).json();
  const final = fill(app);
  const opening = { ...limitOrder(app), status: 'CANCELED', executedQty: '0.4' };
  app.data['/fapi/v1/allOrders'] = [opening];
  const trades = app.data['/fapi/v1/userTrades'] as Record<string, unknown>[];
  trades.push({ ...trades[0], id: 3, orderId: 11, side: 'SELL', qty: '0.2', price: '99', commission: '0.0198', realizedPnl: '-0.2', time: app.now + 150 });
  (app.data['/fapi/v1/allOrders'] as Record<string, unknown>[]).push({ symbol: 'BTCUSDT', orderId: 11, side: 'SELL', positionSide: 'BOTH', type: 'MARKET', origType: 'STOP_MARKET', status: 'FILLED', origQty: '0.2', executedQty: '0.2', reduceOnly: true, closePosition: false, time: app.now + 150, updateTime: app.now + 150 });
  const near = { ...final, algoId: 21, algoStatus: 'FINISHED', closePosition: false, reduceOnly: true, quantity: '0.2', triggerPrice: '99', actualOrderId: '11', createTime: app.now + 100, triggerTime: app.now + 150, updateTime: app.now + 150 };
  app.data['/fapi/v1/allAlgoOrders'] = [final, near];
  const income = app.data['/fapi/v1/income'] as Record<string, unknown>[];
  income.push({ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '-0.2', asset: 'USDT', tradeId: '3', time: app.now + 150 });
  app.data['/fapi/v1/openAlgoOrders'] = [final];
  app.position.positionAmt = '0.2';
  const path = `/api/verification?planId=${plan.id}`;
  const result = await (await app.read(path)).json();
  assert.equal(result.status, 'verified');
  assert.equal(result.realizedPnl, '-0.2');
  assert.equal(result.paidCommission, '0.0598');
  assert.equal(result.plannedLoss, '1.875204');
  assert.equal(result.exitFee, '0.019404');
  assert.equal(result.liquidationBuffer, '8');
  assert.equal(result.nearStatus, '已执行');
  assert.equal(result.nearQuantity, '0');
  assert.equal(plan.budget, '20');
  assert.equal(plan.stopPrice, '98');
  const historyRead = app.requests.find((url) => url.pathname === '/fapi/v1/allAlgoOrders');
  assert.equal(historyRead?.searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(historyRead?.searchParams.get('limit'), '1000');
  opening.status = 'PARTIALLY_FILLED';
  app.data['/fapi/v1/openOrders'] = [opening];
  const pending = await (await app.read(path)).json();
  assert.equal(pending.status, 'needs-action');
  assert.equal(pending.pendingEntries[0].remainingQuantity, '0.095');
  assert.equal(pending.plannedLoss, '1.875204');
  opening.status = 'CANCELED';
  app.data['/fapi/v1/openOrders'] = [];
  for (const patch of [{ actualOrderId: '999' }, { workingType: 'CONTRACT_PRICE' }, { triggerPrice: '98.9' }, { priceProtect: true }, { reduceOnly: false }, { algoStatus: 'CANCELED' }, { triggerTime: app.now + 180 }]) {
    app.data['/fapi/v1/allAlgoOrders'] = [final, { ...near, ...patch }];
    assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  }
  for (const history of [[], [near, near], Array(1000).fill(near)]) {
    app.data['/fapi/v1/allAlgoOrders'] = history;
    assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  }
  app.data['/fapi/v1/allAlgoOrders'] = [final, near];
  const closingOrder = (app.data['/fapi/v1/allOrders'] as Record<string, unknown>[])[1]!;
  closingOrder.orderId = trades[2]!.orderId = '9007199254740992';
  app.data['/fapi/v1/allAlgoOrders'] = [final, { ...near, actualOrderId: 9_007_199_254_740_992 }];
  assert.equal((await app.read(path)).status, 502);
  closingOrder.orderId = trades[2]!.orderId = 11;
  app.data['/fapi/v1/allAlgoOrders'] = [final, near];
  near.quantity = '0.3';
  closingOrder.origQty = '0.3';
  closingOrder.status = 'PARTIALLY_FILLED';
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  closingOrder.status = 'FILLED';
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  closingOrder.origQty = near.quantity = '0.2';
  app.data['/fapi/v1/openAlgoOrders'] = [final, near];
  assert.equal((await (await app.read(path)).json()).status, 'verified');
  for (const patch of [{ actualOrderId: '999' }, { triggerTime: app.now + 151 }]) {
    app.data['/fapi/v1/openAlgoOrders'] = [final, { ...near, ...patch }];
    assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  }
  const extra = { ...near, algoId: 22, algoStatus: 'NEW', triggerTime: 0, actualOrderId: '' };
  app.data['/fapi/v1/openAlgoOrders'] = [final, extra];
  app.data['/fapi/v1/allAlgoOrders'] = [final, near, extra];
  assert.equal((await (await app.read(path)).json()).status, 'needs-action');
  app.data['/fapi/v1/allAlgoOrders'] = [final, near];
  app.data['/fapi/v1/openAlgoOrders'] = [];
  final.algoStatus = 'CANCELED';
  assert.equal((await (await app.read(path)).json()).status, 'needs-action');
  final.algoStatus = 'NEW';
  app.data['/fapi/v1/openAlgoOrders'] = [final];
  app.position.positionAmt = '0.3';
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  app.position.positionAmt = '0.2';
  income[0]!.income = '-25';
  const exceeded = await (await app.read(path)).json();
  assert.equal(exceeded.status, 'needs-action');
  assert.equal(exceeded.plannedLoss, '25.875204');
  assert.equal(exceeded.excess, '5.875204');
  income[0]!.income = '-0.3';
  income.push({ symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-1', asset: 'USDT', tradeId: '999', time: app.now + 150 });
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  income.pop();
  income.pop();
  const missing = await (await app.read(path)).json();
  assert.equal(missing.status, 'incomplete');
  assert.equal(missing.plannedLoss, undefined);
  assert.match(missing.issues.join(' '), /损益.*缺失/);
});

test('short near exits preserve signed realized loss, remaining funding and liquidation direction', async (t) => {
  const app = await start(t, fixture(), 'demo');
  for (const entryType of ['MARKET', 'LIMIT']) {
    const plan = await (await app.create({ ...twoInput, side: 'short', stop: '102', nearStop: '101', entryType, limitPrice: '100' })).json();
    const result = await (await app.read(`/api/verification?planId=${plan.id}&demo=near-filled`)).json();
    assert.equal(result.status, 'verified');
    assert.equal(result.side, 'short');
    assert.equal(result.quantity, entryType === 'MARKET' ? '0.2' : '0.194');
    assert.equal(result.realizedPnl, entryType === 'MARKET' ? '-0.4' : '-0.3');
    assert.equal(result.plannedLoss, entryType === 'MARKET' ? '2.284404' : '1.98556588');
    assert.ok(Number(result.liquidationBuffer) > 1);
  }
});

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
    '/fapi/v1/userTrades': [], '/fapi/v1/allOrders': [], '/fapi/v1/income': [], '/fapi/v1/allAlgoOrders': [],
    '/fapi/v1/commissionRate': { symbol: 'BTCUSDT', takerCommissionRate: '0.001' },
    '/fapi/v1/leverageBracket': { symbol: 'BTCUSDT', brackets: [{ bracket: 1, initialLeverage: 20, notionalFloor: 0, notionalCap: 1000000, maintMarginRatio: 0.01, cum: 0 }] },
    '/fapi/v2/ticker/price': { symbol: 'BTCUSDT', price: '100', time: now },
    '/fapi/v1/ticker/bookTicker': { symbol: 'BTCUSDT', bidPrice: '99', askPrice: '100', time: now },
    '/fapi/v1/premiumIndex': { symbol: 'BTCUSDT', markPrice: '100', time: now },
    '/fapi/v1/exchangeInfo': { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', orderTypes: ['MARKET', 'LIMIT', 'STOP_MARKET'], timeInForce: ['GTC'], marketTakeBound: '0.30', filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.1', maxQty: '1000', stepSize: '0.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PERCENT_PRICE', multiplierUp: '1.2', multiplierDown: '0.8' },
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
  const create = (value: EntryInput = input) => fetch(`${base}/api/plan`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
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

function limitOrder(f: ReturnType<typeof fixture>) {
  return { symbol: 'BTCUSDT', orderId: 10, side: 'BUY', positionSide: 'BOTH', type: 'LIMIT', origType: 'LIMIT', status: 'NEW', time: f.now + 100, updateTime: f.now + 100, price: '100', origQty: '0.495', executedQty: '0', avgPrice: '0', reduceOnly: false, closePosition: false, stopPrice: '0', workingType: 'CONTRACT_PRICE', priceProtect: false, timeInForce: 'GTC', goodTillDate: 0 };
}

test('an unfilled GTC limit waits with its remaining amount, and a confirmed zero-fill cancellation ends without verification', async (t) => {
  const app = await start(t);
  const response = await app.create(limitInput);
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.limitPrice, '100');
  const order = limitOrder(app);
  app.data['/fapi/v1/time'] = { serverTime: app.now + 200 };
  app.data['/fapi/v1/allOrders'] = [order];
  app.data['/fapi/v1/openOrders'] = [order];
  const path = `/api/verification?planId=${plan.id}`;
  const waiting = await (await app.read(path)).json();
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.orderId, '10');
  assert.equal(waiting.filledQuantity, '0');
  assert.deepEqual(waiting.pendingEntries, [{ orderId: '10', filledQuantity: '0', remainingQuantity: '0.495' }]);
  order.status = 'CANCELED';
  app.data['/fapi/v1/openOrders'] = [];
  const canceled = await (await app.read(path)).json();
  assert.equal(canceled.status, 'ended');
  assert.match(canceled.issues.join(' '), /未成交已撤销/);
  assert.deepEqual(canceled.pendingEntries, []);
  app.data['/fapi/v1/income'] = [{ symbol: 'BTCUSDT', incomeType: 'UNKNOWN_COST', income: '-1', asset: 'USDT', time: app.now + 150 }];
  const unexplained = await (await app.read(path)).json();
  assert.equal(unexplained.status, 'incomplete');
  assert.match(unexplained.issues.join(' '), /收支.*无法完整核验/);
});

test('successive partial fills require manual remainder cancellation and recheck actual costs and stop size', async (t) => {
  const app = await start(t);
  const plan = await (await app.create(limitInput)).json();
  const stop = { ...fill(app), closePosition: false, reduceOnly: true, quantity: '0.495' };
  const trades = app.data['/fapi/v1/userTrades'] as Record<string, unknown>[];
  const second = trades.pop()!;
  const order = { ...limitOrder(app), status: 'PARTIALLY_FILLED', executedQty: '0.1' };
  app.data['/fapi/v1/allOrders'] = [order];
  app.data['/fapi/v1/openOrders'] = [order];
  app.data['/fapi/v1/openAlgoOrders'] = [stop];
  app.position.positionAmt = '0.1';
  const path = `/api/verification?planId=${plan.id}`;
  const first = await (await app.read(path)).json();
  assert.equal(first.status, 'needs-action');
  assert.equal(first.filledQuantity, '0.1');
  assert.equal(first.pendingEntries[0].remainingQuantity, '0.395');
  assert.equal(first.plannedLoss, '1.317702');
  assert.match(first.issues.join(' '), /Binance 撤销/);
  trades.push({ ...second, price: '99.9', quoteQty: '29.97', commission: '0.02997' });
  order.executedQty = '0.4';
  Object.assign(app.position, { positionAmt: '0.4', entryPrice: '99.925' });
  const partial = await (await app.read(path)).json();
  assert.equal(partial.status, 'needs-action');
  assert.equal(partial.filledQuantity, '0.4');
  assert.equal(partial.pendingEntries[0].remainingQuantity, '0.095');
  assert.equal(partial.paidCommission, '0.03997');
  assert.equal(partial.plannedLoss, '2.240778');
  order.status = 'CANCELED';
  app.data['/fapi/v1/openOrders'] = [];
  const oversized = await (await app.read(path)).json();
  assert.equal(oversized.status, 'needs-action');
  assert.match(oversized.issues.join(' '), /0.495.*实际 0.4.*不得超量/);
  stop.quantity = '0.4';
  const verified = await (await app.read(path)).json();
  assert.equal(verified.status, 'verified');
  assert.equal(verified.quantity, '0.4');
  assert.equal(verified.entryPrice, '99.925');
  assert.equal(verified.paidFunding, '0.3');
  assert.equal(verified.remainingFunding, '0.7');
  assert.equal(verified.plannedLoss, '2.240778');
  assert.equal(verified.liquidationBuffer, '8.0060045');
  assert.equal(plan.budget, '20');
  assert.equal(plan.stopPrice, '98');
});

test('a stop can close partial fills while the entry remainder survives; ambiguous costs or reopening never complete', async (t) => {
  const app = await start(t);
  const plan = await (await app.create(limitInput)).json();
  fill(app);
  const order = { ...limitOrder(app), status: 'PARTIALLY_FILLED', executedQty: '0.4' };
  const close = { ...order, orderId: 11, side: 'SELL', type: 'MARKET', origType: 'STOP_MARKET', status: 'FILLED', origQty: '0.4', reduceOnly: true };
  app.data['/fapi/v1/allOrders'] = [order, close];
  app.data['/fapi/v1/openOrders'] = [order];
  const trades = app.data['/fapi/v1/userTrades'] as Record<string, unknown>[];
  trades.push({ ...trades[0], id: 3, orderId: 11, side: 'SELL', qty: '0.4', price: '98', realizedPnl: '-0.8', commission: '0.0392', time: app.now + 150 });
  Object.assign(app.position, { positionAmt: '0', entryPrice: '0', liquidationPrice: '0' });
  const path = `/api/verification?planId=${plan.id}`;
  const stopped = await (await app.read(path)).json();
  assert.equal(stopped.status, 'needs-action');
  assert.equal(stopped.pendingEntries[0].remainingQuantity, '0.095');
  assert.match(stopped.issues.join(' '), /重新形成仓位/);
  const income = app.data['/fapi/v1/income'] as Record<string, unknown>[];
  income.push({ symbol: 'BTCUSDT', incomeType: 'UNKNOWN_COST', income: '-1', asset: 'USDT', time: app.now + 160 });
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  income.pop();
  income.push({ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '-8', asset: 'USDT', tradeId: '3', time: app.now + 150 });
  assert.equal((await (await app.read(path)).json()).status, 'incomplete');
  income[1]!.income = '-0.8';
  order.status = 'CANCELED';
  app.data['/fapi/v1/openOrders'] = [];
  assert.equal((await (await app.read(path)).json()).status, 'ended');
  order.status = 'PARTIALLY_FILLED';
  order.executedQty = '0.45';
  app.data['/fapi/v1/openOrders'] = [order];
  trades.push({ ...trades[0], id: 4, qty: '0.05', commission: '0.005', time: app.now + 175 });
  Object.assign(app.position, { positionAmt: '0.05', entryPrice: '100', liquidationPrice: '90' });
  const reopened = await (await app.read(path)).json();
  assert.equal(reopened.status, 'incomplete');
  assert.equal(reopened.pendingEntries[0].remainingQuantity, '0.045');
  assert.match(reopened.issues.join(' '), /重新开仓/);
});

test('fully filled limits verify both directions and still reject excess costs and insufficient liquidation buffer', async (t) => {
  for (const side of ['long', 'short']) await t.test(side, async (t) => {
    const app = await start(t);
    const plan = await (await app.create({ ...limitInput, side, stop: side === 'long' ? '98' : '102' })).json();
    const stop = fill(app);
    const order = { ...limitOrder(app), side: side === 'long' ? 'BUY' : 'SELL', origQty: '0.4', executedQty: '0.4', status: 'FILLED' };
    app.data['/fapi/v1/allOrders'] = [order];
    app.data['/fapi/v1/openAlgoOrders'] = [{ ...stop, side: side === 'long' ? 'SELL' : 'BUY', triggerPrice: plan.stopPrice }];
    const trades = app.data['/fapi/v1/userTrades'] as Record<string, unknown>[];
    for (const trade of trades) trade.side = order.side;
    Object.assign(app.position, { positionAmt: side === 'long' ? '0.4' : '-0.4', liquidationPrice: side === 'long' ? '90' : '110' });
    const path = `/api/verification?planId=${plan.id}`;
    const verified = await (await app.read(path)).json();
    assert.equal(verified.status, 'verified');
    assert.equal(verified.quantity, '0.4');
    assert.equal(verified.plannedLoss, side === 'long' ? '2.270808' : '2.289208');
    assert.deepEqual(verified.pendingEntries, []);
    trades[0]!.commission = '30';
    app.position.liquidationPrice = side === 'long' ? '99' : '101';
    const exceeded = await (await app.read(path)).json();
    assert.equal(exceeded.status, 'needs-action');
    assert.match(exceeded.issues.join(' '), /超过原预算.*超额/);
    assert.match(exceeded.issues.join(' '), /强平缓冲 -1%/);
  });
});

test('inconsistent limit history, changed prices, extra orders and missing reads cannot pass', async (t) => {
  const cases: [string, (app: Awaited<ReturnType<typeof start>>, order: ReturnType<typeof limitOrder>) => void][] = [
    ['unknown status', (_app, order) => { order.status = 'UNKNOWN'; }],
    ['missing remainder', (app, order) => { order.status = 'PARTIALLY_FILLED'; order.origQty = '0.5'; app.data['/fapi/v1/openOrders'] = []; }],
    ['mismatched remainder', (app, order) => { order.status = 'PARTIALLY_FILLED'; order.origQty = '0.5'; app.data['/fapi/v1/openOrders'] = [{ ...order, executedQty: '0.3' }]; }],
    ['changed limit', (_app, order) => { order.price = '101'; }],
    ['wrong TIF', (_app, order) => { order.timeInForce = 'IOC'; }],
    ['canceled then replaced', (app, order) => { app.data['/fapi/v1/allOrders'] = [{ ...order, orderId: 9, status: 'CANCELED', executedQty: '0' }, order]; }],
    ['partial close', (app, order) => {
      const trades = app.data['/fapi/v1/userTrades'] as Record<string, unknown>[];
      trades.push({ ...trades[0], id: 3, orderId: 11, side: 'SELL', qty: '0.1', time: app.now + 150 });
      app.data['/fapi/v1/allOrders'] = [order, { ...order, orderId: 11, side: 'SELL', executedQty: '0.1' }];
      app.position.positionAmt = '0.3';
    }],
    ['missing trades', (app) => { app.data['/fapi/v1/userTrades'] = []; }],
    ['beyond limit fill', (app) => { (app.data['/fapi/v1/userTrades'] as Record<string, unknown>[])[0]!.price = '100.1'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async (t) => {
    const app = await start(t);
    const plan = await (await app.create(limitInput)).json();
    app.data['/fapi/v1/openAlgoOrders'] = [fill(app)];
    const order = { ...limitOrder(app), origQty: '0.4', executedQty: '0.4', status: 'FILLED' };
    app.data['/fapi/v1/allOrders'] = [order];
    change(app, order);
    const response = await app.read(`/api/verification?planId=${plan.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'incomplete');
  });
});

test('demo runs the same limit waiting, repeated partial-fill, canceled-remainder and stop-first verification flow', async (t) => {
  const app = await start(t, fixture(), 'demo');
  const plan = await (await app.create(limitInput)).json();
  const read = async (scenario: string) => {
    const response = await app.read(`/api/verification?planId=${plan.id}&demo=${scenario}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await read('waiting')).status, 'waiting');
  const partial = await read('partial');
  assert.equal(partial.status, 'needs-action');
  assert.equal(partial.quantity, '0.247');
  assert.equal(partial.pendingEntries[0].remainingQuantity, '0.248');
  const more = await read('partial-more');
  assert.equal(more.quantity, '0.371');
  assert.equal(more.status, 'needs-action');
  assert.equal(more.pendingEntries[0].remainingQuantity, '0.124');
  const canceled = await read('canceled-remainder');
  assert.equal(canceled.status, 'verified');
  assert.equal(canceled.quantity, '0.371');
  assert.equal(canceled.plannedLoss, '2.17867442');
  const stopped = await read('stop-first');
  assert.equal(stopped.status, 'needs-action');
  assert.equal(stopped.quantity, '0');
  assert.match(stopped.issues.join(' '), /重新形成仓位/);
});

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
  app.data['/fapi/v1/openOrders'] = [{ symbol: 'BTCUSDT', orderId: 30, status: 'PARTIALLY_FILLED', type: 'LIMIT', price: '100', side: 'BUY', positionSide: 'BOTH', origQty: '1', executedQty: '0.1', stopPrice: '0', workingType: 'CONTRACT_PRICE', priceProtect: false, closePosition: false, reduceOnly: false, updateTime: app.now + 100, timeInForce: 'GTC', goodTillDate: 0 }];
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
