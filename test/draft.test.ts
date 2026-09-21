import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server.ts';
import { generateDraft } from '../public/draft.js';

const input = { symbol: 'BTCUSDT', side: 'long', budgetMode: 'amount', budget: '20', stopMode: 'price', stop: '98', slippage: '1', funding: '1' };

function responses(): Record<string, unknown> {
  return {
    '/sapi/v1/account/apiRestrictions': { enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, enableMargin: false, enableFutures: false, permitsUniversalTransfer: false, enableVanillaOptions: false, enableFixApiTrade: false, enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false },
    '/sapi/v1/portfolio/account': { code: -21001 },
    '/fapi/v2/account': { multiAssetsMargin: false, assets: [{ asset: 'USDT', walletBalance: '1025', unrealizedProfit: '-25', marginBalance: '1000', availableBalance: '5' }], positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', isolated: true }] },
    '/fapi/v1/positionSide/dual': { dualSidePosition: false },
    '/fapi/v1/openOrders': [],
    '/fapi/v1/openAlgoOrders': [],
    '/fapi/v1/commissionRate': { symbol: 'BTCUSDT', takerCommissionRate: '0.001' },
    '/fapi/v1/ticker/bookTicker': { symbol: 'BTCUSDT', bidPrice: '99', askPrice: '100', time: Date.now() },
    '/fapi/v1/premiumIndex': { symbol: 'BTCUSDT', markPrice: '100', time: Date.now() },
    '/fapi/v1/exchangeInfo': { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', orderTypes: ['MARKET', 'STOP_MARKET'], pricePrecision: 5, quantityPrecision: 7, filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.1', maxQty: '1000', stepSize: '0.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ] }] },
  };
}

async function start(t: TestContext, data = responses(), mode: 'real' | 'demo' = 'real') {
  const requests: URL[] = [];
  const server = createServer({ password: 'test-password-only', mode, apiKey: 'test-key', apiSecret: 'test-secret', transport: async (url, headers) => {
    requests.push(url);
    assert.ok(url.pathname in data, `Unexpected endpoint: ${url.pathname}`);
    const isPublic = ['/fapi/v1/exchangeInfo', '/fapi/v1/ticker/bookTicker', '/fapi/v1/premiumIndex'].includes(url.pathname);
    assert.equal(headers['X-MBX-APIKEY'], isPublic ? undefined : 'test-key');
    assert.equal(url.searchParams.has('signature'), !isPublic);
    return { status: url.pathname.includes('/portfolio/') ? 400 : 200, body: data[url.pathname] };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=test-password-only' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const read = (path = '/api/market?symbol=BTCUSDT') => fetch(base + path, { headers: { Cookie: cookie } });
  return { base, cookie, read, requests };
}

test('long draft includes both taker fees, adverse slippage and fixed funding reserve', async (t) => {
  const app = await start(t);
  const response = await app.read();
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  const plan = generateDraft(input, snapshot);
  // Hand calculation: entry 101, exit 97.02; per BTC 3.98 + .101 + .09702.
  // 4.5 BTC costs 18.80109, plus 1 USDT funding = 19.80109.
  assert.equal(plan.quantity, '4.5');
  assert.equal(plan.notional, '450');
  assert.equal(plan.stopPrice, '98');
  assert.equal(plan.entryEstimate, '101');
  assert.equal(plan.exitEstimate, '97.02');
  assert.equal(plan.plannedLoss, '19.80109');
  assert.equal(plan.status, 'draft');
  assert.equal(plan.budget, '20');
  assert.match(plan.notice, /资金与强平检查尚未完成/);
  assert.doesNotMatch(JSON.stringify(snapshot), /test-key|test-secret|signature|positionAmt/);
});

test('short percentage budget uses equity and bid, with adverse entry and exit costs', async (t) => {
  const data = responses();
  data['/fapi/v1/ticker/bookTicker'] = { symbol: 'BTCUSDT', bidPrice: '100', askPrice: '101', time: Date.now() };
  const app = await start(t, data);
  const snapshot = await (await app.read()).json();
  const plan = generateDraft({ ...input, side: 'short', budgetMode: 'percent', budget: '2', stopMode: 'percent', stop: '2' }, snapshot);
  // 2% of 1000 equity = 20 (available balance is only 5).
  // Entry 99, exit 103.02; 4.5 × (4.02 + .099 + .10302) + 1 = 19.99909.
  assert.equal(plan.budget, '20');
  assert.equal(plan.quantity, '4.5');
  assert.equal(plan.notional, '450');
  assert.equal(plan.stopPrice, '102');
  assert.equal(plan.entryEstimate, '99');
  assert.equal(plan.exitEstimate, '103.02');
  assert.equal(plan.plannedLoss, '19.99909');
});

test('stop rounds away from entry and quantity rounds down using actual market steps', async (t) => {
  const data = responses();
  data['/fapi/v1/commissionRate'] = { symbol: 'BTCUSDT', takerCommissionRate: '0' };
  const app = await start(t, data);
  const snapshot = await (await app.read()).json();
  const plan = generateDraft({ ...input, stop: '98.09', slippage: '0', funding: '' }, snapshot);
  assert.equal(plan.stopPrice, '98');
  assert.equal(plan.stopDistance, '2');
  assert.equal(plan.quantity, '10');
  assert.equal(plan.plannedLoss, '20');
  assert.equal(plan.fundingReserved, false);
  // Bid 99, stop 100.01 -> 100.1; 18.1 BTC × 1.1 = 19.91.
  const short = generateDraft({ ...input, side: 'short', stop: '100.01', slippage: '0', funding: '' }, snapshot);
  assert.equal(short.stopPrice, '100.1');
  assert.equal(short.quantity, '18.1');
  assert.equal(short.plannedLoss, '19.91');
  const percent = generateDraft({ ...input, side: 'short', stopMode: 'percent', stop: '1.02', slippage: '0', funding: '' }, snapshot);
  assert.equal(percent.stopPrice, '100.1');
  assert.equal(percent.plannedLoss, '19.91');
});

test('invalid inputs and already triggered stops never produce a quantity', async (t) => {
  const app = await start(t);
  const snapshot = await (await app.read()).json();
  const cases: [Partial<typeof input>, RegExp][] = [
    [{ budget: '' }, /亏损预算/], [{ budget: '0' }, /亏损预算/],
    [{ budget: '-1' }, /亏损预算/], [{ budget: '1e2' }, /亏损预算/],
    [{ budgetMode: 'percent', budget: '101' }, /100/],
    [{ funding: '20' }, /资金费/], [{ funding: '-1' }, /资金费/],
    [{ slippage: '' }, /滑点/], [{ slippage: '100' }, /滑点/],
    [{ side: 'wrong' }, /方向/], [{ budgetMode: 'wrong' }, /预算方式/], [{ stopMode: 'wrong' }, /止损方式/],
    [{ symbol: 'ETHUSDT' }, /币种/], [{ stop: '100' }, /止损/], [{ stop: '101' }, /止损/],
    [{ side: 'short', stop: '98' }, /止损/], [{ side: 'short', stop: '99.9' }, /标记价/],
    [{ stop: '0' }, /止损/], [{ stopMode: 'percent', stop: '100' }, /止损/],
    [{ stop: '98.000000001' }, /8 位/], [{ budget: '0.01', funding: '' }, /最小/],
  ];
  for (const [change, error] of cases) await t.test(JSON.stringify(change), () => {
    assert.throws(() => generateDraft({ ...input, ...change }, snapshot), error);
  });
});

test('market quantity ceiling shrinks risk size and minimum notional uses mark price', async (t) => {
  const data = responses();
  const exchange = data['/fapi/v1/exchangeInfo'] as { symbols: { filters: Record<string, string>[] }[] };
  exchange.symbols[0]!.filters.find((filter) => filter.filterType === 'MARKET_LOT_SIZE')!.maxQty = '1.05';
  const app = await start(t, data);
  const plan = generateDraft(input, await (await app.read()).json());
  assert.equal(plan.quantity, '1');
  assert.equal(plan.plannedLoss, '5.17802');
  // Entry reference 100 would value .1 BTC at 10; mark 90 values it at 9.
  data['/fapi/v1/premiumIndex'] = { symbol: 'BTCUSDT', markPrice: '90', time: Date.now() };
  exchange.symbols[0]!.filters.find((filter) => filter.filterType === 'MIN_NOTIONAL')!.notional = '9.5';
  const snapshot = await (await app.read()).json();
  assert.throws(() => generateDraft({ ...input, budget: '2', stop: '89', funding: '', slippage: '0' }, snapshot), /最小名义价值/);
});

test('ineligible accounts, old orders and incomplete data revoke the entire snapshot', async (t) => {
  const normal = responses();
  const account = normal['/fapi/v2/account'] as Record<string, unknown>;
  const cases: [string, unknown, string][] = [
    ['/fapi/v2/account', { ...account, positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.01', isolated: true }] }, 'existing_position'],
    ['/fapi/v2/account', { ...account, positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', isolated: false }] }, 'unsupported_margin'],
    ['/fapi/v2/account', { ...account, positions: [] }, 'unsupported_position'],
    ['/fapi/v1/positionSide/dual', { dualSidePosition: true }, 'unsupported_position'],
    ['/fapi/v1/positionSide/dual', {}, 'unsupported_position'],
    ['/fapi/v1/openOrders', [{ symbol: 'BTCUSDT', reduceOnly: true }], 'existing_orders'],
    ['/fapi/v1/openAlgoOrders', [{ symbol: 'BTCUSDT', closePosition: true }], 'existing_orders'],
    ['/fapi/v1/openAlgoOrders', null, 'invalid_response'],
    ['/fapi/v1/commissionRate', { symbol: 'BTCUSDT' }, 'invalid_response'],
    ['/fapi/v1/commissionRate', { symbol: 'BTCUSDT', takerCommissionRate: '-0.001' }, 'invalid_response'],
    ['/fapi/v1/commissionRate', { symbol: 'BTCUSDT', takerCommissionRate: '1' }, 'invalid_response'],
    ['/fapi/v1/premiumIndex', { symbol: 'ETHUSDT', markPrice: '100', time: Date.now() }, 'invalid_response'],
    ['/fapi/v1/ticker/bookTicker', { symbol: 'BTCUSDT', bidPrice: '101', askPrice: '100', time: Date.now() }, 'invalid_response'],
    ['/fapi/v1/premiumIndex', { symbol: 'BTCUSDT', markPrice: '0', time: Date.now() }, 'invalid_response'],
    ['/fapi/v1/premiumIndex', { symbol: 'BTCUSDT', markPrice: '100' }, 'invalid_response'],
    ['/fapi/v1/exchangeInfo', { symbols: [] }, 'unsupported_symbol'],
  ];
  for (const [path, body, code] of cases) await t.test(`${path}: ${JSON.stringify(body)}`, async (t) => {
    const data = responses();
    data[path] = body;
    const app = await start(t, data);
    const result = await app.read();
    assert.equal(result.status, 502);
    const failure = await result.json();
    assert.equal(failure.code, code);
    assert.equal(failure.rules, undefined);
    assert.equal(failure.account, undefined);
  });
});

test('symbol discovery and market reads stay protected and demo never contacts Binance', async (t) => {
  const app = await start(t);
  for (const path of ['/api/symbols', '/api/market?symbol=BTCUSDT', '/draft.js']) {
    assert.equal((await fetch(app.base + path)).status, 401);
  }
  const symbols = await app.read('/api/symbols');
  assert.equal(symbols.status, 200);
  assert.deepEqual((await symbols.json()).symbols, ['BTCUSDT']);
  const count = app.requests.length;
  for (const path of ['/api/market?symbol=BTCUSDT&url=https://example.com', '/api/market?symbol=BTCUSDT&symbol=ETHUSDT', '/api/market?symbol=https://example.com']) {
    assert.equal((await app.read(path)).status, 400);
  }
  assert.equal(app.requests.length, count);
  const demo = await start(t, {}, 'demo');
  assert.equal((await demo.read('/api/symbols')).status, 200);
  const result = await demo.read();
  assert.equal(result.status, 200);
  const snapshot = await result.json();
  assert.equal(snapshot.source, 'demo');
  assert.equal(generateDraft(input, snapshot).source, 'demo');
  assert.equal(demo.requests.length, 0);
});
