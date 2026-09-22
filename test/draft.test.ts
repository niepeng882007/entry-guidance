import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server.ts';
import { generateDraft, generateEntryPlan } from '../public/draft.js';

const input = { symbol: 'BTCUSDT', side: 'long', budgetMode: 'amount', budget: '20', stopMode: 'price', stop: '98', slippage: '1', funding: '1' };
const entryInput = { ...input, leverage: '10', minimumBuffer: '1', fundingCap: '' };

test('two stops size every unit to the final stop before allocating the requested ratio', async (t) => {
  const app = await start(t);
  const snapshot = await (await app.read()).json();
  snapshot.takerRate = '0';
  snapshot.account.availableBalance = '1000';
  const parameters = { ...entryInput, stopMode: 'percent', stop: '1.6', slippage: '0', funding: '0', stopLevels: 'two', nearStopMode: 'percent', nearStop: '0.8', nearPercent: '70' };
  const plan = generateEntryPlan(parameters, snapshot);
  assert.equal(plan.notional, '1250');
  assert.equal(plan.quantity, '12.5');
  assert.equal(plan.plannedLoss, '20');
  assert.equal(plan.stopPrice, '98.4');
  assert.equal(plan.nearStop?.price, '99.2');
  assert.equal(plan.nearStop?.quantity, '8.7');
  assert.equal(plan.nearStop?.actualPercent, '69.6');
  assert.equal(plan.finalQuantity, '3.8');
  assert.equal(plan.finalPercent, '30.4');
  assert.equal(generateEntryPlan({ ...parameters, nearPercent: '20' }, snapshot).quantity, '12.5');
  assert.equal(generateEntryPlan({ ...parameters, stopLevels: 'single' }, snapshot).quantity, '12.5');
});

test('two-stop rounding respects direction, exit lots and rejects invalid allocation without resizing', async (t) => {
  const app = await start(t);
  const snapshot = await (await app.read()).json();
  const parameters = { ...entryInput, stopLevels: 'two', nearStopMode: 'price', nearStop: '99.09', nearPercent: '70' };
  const long = generateEntryPlan(parameters, snapshot);
  assert.equal(long.nearStop?.price, '99');
  assert.equal(long.nearStop?.distance, '1');
  assert.equal(long.quantity, '0.4');
  assert.equal(long.nearStop?.quantity, '0.2');
  const short = generateEntryPlan({ ...parameters, side: 'short', stop: '102.01', nearStop: '100.01' }, snapshot);
  assert.equal(short.stopPrice, '102.1');
  assert.equal(short.nearStop?.price, '100.1');
  const limit = generateEntryPlan({ ...parameters, entryType: 'LIMIT', limitPrice: '100' }, snapshot);
  assert.equal(limit.quantity, '0.495');
  assert.equal(limit.nearStop?.quantity, '0.3');
  assert.equal(limit.finalQuantity, '0.195');
  for (const patch of [
    { nearStop: '' }, { nearStop: '98.09' }, { nearStop: '97' }, { nearStop: '100' },
    { nearPercent: '0' }, { nearPercent: '100' }, { nearPercent: '-1' }, { nearPercent: '0.1' },
    { nearStopMode: 'invalid' }, { stopLevels: 'invalid' },
  ]) assert.throws(() => generateEntryPlan({ ...parameters, ...patch }, snapshot));
  const restrictedExit = { ...snapshot, rules: { ...snapshot.rules, minQty: '0.4' } };
  assert.throws(() => generateEntryPlan({ ...parameters, entryType: 'LIMIT', limitPrice: '100' }, restrictedExit), /近端数量.*退出数量规则/);
  // Opening notional is 40, while the valid near exit is only 20; no opening minimum on exits.
  const highMinimum = { ...snapshot, rules: { ...snapshot.rules, minNotional: '30' } };
  assert.equal(generateEntryPlan(parameters, highMinimum).nearStop?.quantity, '0.2');
});

test('limit entry keeps the specified price, uses ordinary lots and reserves taker costs', async (t) => {
  const data = responses();
  const app = await start(t, data);
  const snapshot = await (await app.read()).json();
  const parameters = { ...entryInput, entryType: 'LIMIT', limitPrice: '100' };
  const draft = generateDraft(parameters, snapshot);
  assert.equal(draft.referencePrice, '100');
  assert.equal(draft.entryEstimate, '100');
  assert.equal(draft.exitEstimate, '97.02');
  const plan = generateEntryPlan(parameters, snapshot);
  // Each BTC needs 10 margin + 0 open loss + .1 taker reserve; 5 USDT admits .495 BTC.
  assert.equal(plan.quantity, '0.495');
  assert.equal(plan.initialMargin, '4.95');
  assert.equal(plan.openLoss, '0');
  assert.equal(plan.openFeeReserve, '0.0495');
  assert.equal(plan.fundingRequired, '4.9995');
  assert.equal(plan.plannedLoss, '2.5726249');
  assert.equal(plan.execution.entryType, 'LIMIT');
  assert.equal(plan.execution.timeInForce, 'GTC');
  assert.equal(plan.isolatedWalletAssumption, '4.9005');
  assert.equal(plan.liquidationPrice, '91.01010102');
});

test('short limit funding uses the official maximum valuation but open loss uses the limit price', async (t) => {
  const app = await start(t);
  const snapshot = await (await app.read()).json();
  const parameters = { ...entryInput, entryType: 'LIMIT', limitPrice: '99', side: 'short', stop: '102' };
  const plan = generateEntryPlan(parameters, snapshot);
  // A=100.15, open loss=1/BTC, fee reserve=.10015/BTC; 5/11.11515 rounds down to .449.
  assert.equal(plan.quantity, '0.449');
  assert.equal(plan.assumingPrice, '100.15');
  assert.equal(plan.initialMargin, '4.496735');
  assert.equal(plan.openLoss, '0.449');
  assert.equal(plan.openFeeReserve, '0.04496735');
  assert.equal(plan.fundingRequired, '4.99070235');
  assert.equal(plan.entryEstimate, '99');
  assert.equal(plan.plannedLoss, '2.89568698');
  // Mark may exceed the padded last trade; it then determines initial margin, not the limit.
  const moved = generateEntryPlan({ ...parameters, stop: '106' }, { ...snapshot, mark: '105' });
  assert.equal(moved.assumingPrice, '105');
  assert.equal(moved.openLoss, '1.806');
});

test('limit prices require explicit valid rules and exact ticks, with side-specific price and notional filters', async (t) => {
  const app = await start(t);
  const snapshot = await (await app.read()).json();
  const parameters = { ...entryInput, entryType: 'LIMIT', limitPrice: '100' };
  for (const limitPrice of ['', '0', '100.01']) assert.throws(() => generateDraft({ ...parameters, limitPrice }, snapshot), /限价|价格/);
  assert.throws(() => generateDraft({ ...parameters, entryType: 'STOP' }, snapshot), /入场/);
  assert.throws(() => generateEntryPlan(parameters, { ...snapshot, rules: { ...snapshot.rules, limitSupported: false } }), /GTC/);
  assert.throws(() => generateDraft(parameters, { ...snapshot, rules: { ...snapshot.rules, percentPrice: undefined } }), /价格范围/);
  assert.throws(() => generateDraft({ ...parameters, limitPrice: '120.1' }, snapshot), /价格范围/);
  assert.throws(() => generateDraft({ ...parameters, side: 'short', limitPrice: '79.9', stop: '102' }, snapshot), /价格范围/);
  assert.equal(generateDraft({ ...parameters, limitPrice: '70', stop: '68' }, snapshot).referencePrice, '70');
  assert.equal(generateDraft({ ...parameters, side: 'short', limitPrice: '130', stop: '132' }, snapshot).referencePrice, '130');
  const small = { ...snapshot, rules: { ...snapshot.rules, lotSize: { minQty: '0.05', maxQty: '0.05', stepSize: '0.001' } } };
  assert.throws(() => generateDraft({ ...parameters, limitPrice: '99' }, small), /最小名义价值/);
  assert.equal(generateDraft(parameters, small).quantity, '0.05');
});

function responses(): Record<string, unknown> {
  return {
    '/sapi/v1/account/apiRestrictions': { enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, enableMargin: false, enableFutures: false, permitsUniversalTransfer: false, enableVanillaOptions: false, enableFixApiTrade: false, enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false },
    '/sapi/v1/portfolio/account': { code: -21001 },
    '/fapi/v2/account': { canTrade: true, multiAssetsMargin: false, assets: [{ asset: 'USDT', walletBalance: '1025', unrealizedProfit: '-25', marginBalance: '1000', availableBalance: '5' }], positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', isolated: true }] },
    '/fapi/v1/positionSide/dual': { dualSidePosition: false },
    '/fapi/v1/openOrders': [],
    '/fapi/v1/openAlgoOrders': [],
    '/fapi/v1/commissionRate': { symbol: 'BTCUSDT', takerCommissionRate: '0.001' },
    '/fapi/v1/leverageBracket': { symbol: 'BTCUSDT', brackets: [
      { bracket: 1, initialLeverage: 50, notionalFloor: 0, notionalCap: 500, maintMarginRatio: 0.01, cum: 0 },
      { bracket: 2, initialLeverage: 10, notionalFloor: 500, notionalCap: 10000, maintMarginRatio: 0.02, cum: 5 },
    ] },
    '/fapi/v2/ticker/price': { symbol: 'BTCUSDT', price: '100', time: Date.now() },
    '/fapi/v1/ticker/bookTicker': { symbol: 'BTCUSDT', bidPrice: '99', askPrice: '100', time: Date.now() },
    '/fapi/v1/premiumIndex': { symbol: 'BTCUSDT', markPrice: '100', time: Date.now() },
    '/fapi/v1/exchangeInfo': { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', orderTypes: ['MARKET', 'LIMIT', 'STOP_MARKET'], timeInForce: ['GTC'], marketTakeBound: '0.30', pricePrecision: 5, quantityPrecision: 7, filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.1', maxQty: '1000', stepSize: '0.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PERCENT_PRICE', multiplierUp: '1.2', multiplierDown: '0.8' },
    ] }] },
  };
}

async function start(t: TestContext, data = responses(), mode: 'real' | 'demo' = 'real') {
  const requests: URL[] = [];
  const server = createServer({ password: 'test-password-only', mode, apiKey: 'test-key', apiSecret: 'test-secret', transport: async (url, headers) => {
    requests.push(url);
    assert.ok(url.pathname in data, `Unexpected endpoint: ${url.pathname}`);
    const isPublic = ['/fapi/v1/exchangeInfo', '/fapi/v1/ticker/bookTicker', '/fapi/v1/premiumIndex', '/fapi/v2/ticker/price'].includes(url.pathname);
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

test('market snapshot reads the account brackets and last trade needed for entry checks', async (t) => {
  const app = await start(t);
  const response = await app.read();
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.last, '100');
  assert.equal(snapshot.brackets[1].cap, '10000');
  assert.equal(snapshot.brackets[1].maintenanceRate, '0.02');
  assert.equal(snapshot.brackets[1].cum, '5');
  assert.equal(snapshot.brackets[0].maxLeverage, 50);
  assert.equal(snapshot.rules.lotSize.stepSize, '0.001');
  assert.equal(snapshot.rules.marketTakeBound, '0.30');
  assert.ok(app.requests.some((url) => url.pathname === '/fapi/v1/leverageBracket' && url.searchParams.get('symbol') === 'BTCUSDT'));
});

test('entry plan sizes to available balance including open loss and fees, keeping the stop and leverage', async (t) => {
  const app = await start(t);
  const plan = generateEntryPlan(entryInput, await (await app.read()).json());
  // A=100.15; each BTC needs 10.015 margin + .15 open loss + .101 fee.
  // Balance 5 admits .4 BTC. WB=4.04-.0404; LP=36.4004/.396.
  assert.equal(plan.quantity, '0.4');
  assert.equal(plan.initialMargin, '4.006');
  assert.equal(plan.openLoss, '0.06');
  assert.equal(plan.openFeeReserve, '0.0404');
  assert.equal(plan.fundingRequired, '4.1064');
  assert.equal(plan.isolatedWalletAssumption, '3.9996');
  assert.equal(plan.liquidationPrice, '91.92020203');
  assert.equal(plan.liquidationBuffer, '6.07979797');
  assert.equal(plan.plannedLoss, '2.671208');
  assert.equal(plan.stopPrice, '98');
  assert.equal(plan.leverage, '10');
  assert.equal(plan.budget, '20');
  assert.equal(plan.symbol, 'BTCUSDT');
  assert.equal(plan.baseAsset, 'BTC');
  assert.equal(plan.exitMode, '整仓退出');
  assert.deepEqual(plan.execution, { entrySide: 'BUY', stopSide: 'SELL', marginMode: 'ISOLATED', positionMode: 'BOTH', entryType: 'MARKET', stopType: 'STOP_MARKET', workingType: 'MARK_PRICE', priceProtect: 'FALSE', closePosition: 'true' });
  assert.equal(plan.status, 'ready');
});

test('funding cap can shrink further and an untradeable funded size gives a funding-aware refusal', async (t) => {
  const app = await start(t);
  const snapshot = await (await app.read()).json();
  const plan = generateEntryPlan({ ...entryInput, fundingCap: '2.06' }, snapshot);
  assert.equal(plan.quantity, '0.2');
  assert.equal(plan.fundingRequired, '2.0532');
  assert.equal(plan.stopPrice, '98');
  assert.throws(() => generateEntryPlan({ ...entryInput, fundingCap: '1' }, snapshot), /资金.*最小/);
});

test('short liquidation uses a signed buffer and both sides reject missing or insufficient preferences', async (t) => {
  const data = responses();
  data['/fapi/v1/ticker/bookTicker'] = { symbol: 'BTCUSDT', bidPrice: '100', askPrice: '101', time: Date.now() };
  const app = await start(t, data);
  const snapshot = await (await app.read()).json();
  const short = { ...entryInput, side: 'short', stop: '102' };
  const plan = generateEntryPlan(short, snapshot);
  assert.equal(plan.quantity, '0.4');
  assert.equal(plan.openLoss, '0');
  assert.equal(plan.openFeeReserve, '0.04006');
  assert.equal(plan.fundingRequired, '4.04606');
  assert.equal(plan.liquidationPrice, '107.72376237');
  assert.equal(plan.liquidationBuffer, '5.72376237');
  assert.equal(plan.plannedLoss, '2.688808');
  assert.throws(() => generateEntryPlan({ ...short, leverage: '50' }, snapshot), /先强平、后止损.*缓冲 -/);
  assert.throws(() => generateEntryPlan({ ...entryInput, leverage: '50' }, snapshot), /先强平、后止损/);
  assert.throws(() => generateEntryPlan({ ...short, minimumBuffer: '6' }, snapshot), /低于要求.*差/);
  for (const minimumBuffer of ['', '0', '-1']) assert.throws(() => generateEntryPlan({ ...short, minimumBuffer }, snapshot), /最低强平缓冲/);
  for (const leverage of ['', '0', '10.5', '51']) assert.throws(() => generateEntryPlan({ ...short, leverage }, snapshot), /杠杆/);
  assert.throws(() => generateEntryPlan({ ...short, fundingCap: '0' }, snapshot), /资金上限/);
  assert.throws(() => generateEntryPlan(short, { ...snapshot, brackets: [] }), /档位/);
});

test('liquidation recalculates across tiers and changing leverage alone preserves price risk', async (t) => {
  const data = responses();
  data['/fapi/v1/commissionRate'] = { symbol: 'BTCUSDT', takerCommissionRate: '0' };
  data['/fapi/v1/ticker/bookTicker'] = { symbol: 'BTCUSDT', bidPrice: '100', askPrice: '100', time: Date.now() };
  data['/fapi/v2/ticker/price'] = { symbol: 'BTCUSDT', price: '99', time: Date.now() };
  const app = await start(t, data);
  const snapshot = await (await app.read()).json();
  snapshot.account.availableBalance = '1000';
  const parameters = { ...entryInput, budget: '10.2', slippage: '0', funding: '' };
  const long = generateEntryPlan(parameters, snapshot);
  assert.equal(long.quantity, '5.1'); // Entry notional 510, liquidation notional below 500.
  assert.equal(long.liquidationTier, 1);
  assert.equal(long.liquidationPrice, '90.90909091');
  const short = generateEntryPlan({ ...parameters, side: 'short', stop: '102', budget: '9.8' }, snapshot);
  assert.equal(short.quantity, '4.9'); // (490 + 49 + 5) / (4.9 × 1.02).
  assert.equal(short.liquidationTier, 2);
  assert.equal(short.liquidationPrice, '108.84353741');
  const capped = generateEntryPlan({ ...parameters, leverage: '20' }, snapshot);
  assert.equal(capped.quantity, '5');
  assert.equal(capped.notionalLimit, '500');
  const lower = generateEntryPlan({ ...parameters, budget: '10' }, snapshot);
  assert.equal(lower.quantity, capped.quantity);
  assert.equal(lower.plannedLoss, capped.plannedLoss);
  assert.notEqual(lower.liquidationPrice, capped.liquidationPrice);
  assert.notEqual(lower.initialMargin, capped.initialMargin);
  assert.throws(() => generateEntryPlan(parameters, { ...snapshot, rules: { ...snapshot.rules, minNotional: '600' } }), /最小名义价值/);
});

test('incomplete entry rules and disabled account trading prevent a new snapshot', async (t) => {
  const data = responses();
  const normalBrackets = data['/fapi/v1/leverageBracket'] as { symbol: string; brackets: Record<string, number>[] };
  const cases: [string, unknown][] = [
    ['/fapi/v1/leverageBracket', { ...normalBrackets, notionalCoef: 1.5 }],
    ['/fapi/v1/leverageBracket', { symbol: 'BTCUSDT', brackets: [] }],
    ['/fapi/v1/leverageBracket', { ...normalBrackets, symbol: 'ETHUSDT' }],
    ['/fapi/v1/leverageBracket', { ...normalBrackets, brackets: [{ ...normalBrackets.brackets[0], cum: 1 }] }],
    ['/fapi/v1/leverageBracket', { ...normalBrackets, brackets: [normalBrackets.brackets[0], { ...normalBrackets.brackets[1], notionalFloor: 501 }] }],
    ['/fapi/v2/ticker/price', { symbol: 'BTCUSDT', price: '0', time: Date.now() }],
    ['/fapi/v2/account', { ...(data['/fapi/v2/account'] as object), canTrade: false }],
  ];
  for (const [path, body] of cases) await t.test(path + JSON.stringify(body), async (t) => {
    const app = await start(t, { ...responses(), [path]: body });
    const response = await app.read();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).brackets, undefined);
  });
});

test('entry rules intersect quantity grids and account for a short opening loss', async (t) => {
  const data = responses();
  data['/fapi/v1/ticker/bookTicker'] = { symbol: 'BTCUSDT', bidPrice: '100', askPrice: '101', time: Date.now() };
  data['/fapi/v1/premiumIndex'] = { symbol: 'BTCUSDT', markPrice: '101', time: Date.now() };
  const app = await start(t, data);
  const snapshot = await (await app.read()).json();
  const short = { ...entryInput, side: 'short', stop: '102' };
  const plan = generateEntryPlan(short, snapshot);
  assert.equal(plan.quantity, '0.4');
  assert.equal(plan.openLoss, '0.34');
  assert.equal(plan.fundingRequired, '4.38606');
  const normalLot = { minQty: '0.03', maxQty: '0.38', stepSize: '0.03' };
  const limited = generateEntryPlan(short, { ...snapshot, rules: { ...snapshot.rules, lotSize: normalLot } });
  assert.equal(limited.quantity, '0.3'); // Both .1 and .03 grids, also below .38.
  assert.throws(() => generateEntryPlan({ ...short, slippage: '40' }, snapshot), /市价成交边界/);
  const demo = await start(t, {}, 'demo');
  const simulated = generateEntryPlan(entryInput, await (await demo.read()).json());
  assert.equal(simulated.status, 'simulation');
  assert.match(simulated.notice, /不可用于真实交易/);
});

test('stale mark or order-book data cannot produce a fresh entry snapshot', async (t) => {
  const data = responses();
  data['/fapi/v1/premiumIndex'] = { symbol: 'BTCUSDT', markPrice: '100', time: Date.now() - 60_000 };
  const app = await start(t, data);
  const response = await app.read();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /过期|不一致/);
});

test('generated plans freeze USDT budget and absolute stop across later account and quote refreshes', async (t) => {
  const data = responses();
  const app = await start(t, data);
  const percentages = { ...entryInput, budgetMode: 'percent', budget: '2', stopMode: 'percent', stop: '2' };
  const original = generateEntryPlan(percentages, await (await app.read()).json());
  data['/fapi/v2/account'] = { ...(data['/fapi/v2/account'] as object), assets: [{ asset: 'USDT', walletBalance: '2025', unrealizedProfit: '-25', marginBalance: '2000', availableBalance: '5' }] };
  data['/fapi/v1/ticker/bookTicker'] = { symbol: 'BTCUSDT', bidPrice: '199', askPrice: '200', time: Date.now() };
  data['/fapi/v1/premiumIndex'] = { symbol: 'BTCUSDT', markPrice: '200', time: Date.now() };
  data['/fapi/v2/ticker/price'] = { symbol: 'BTCUSDT', price: '200', time: Date.now() };
  const fresh = generateEntryPlan(percentages, await (await app.read()).json());
  assert.equal(fresh.budget, '40');
  assert.equal(fresh.stopPrice, '196');
  assert.equal(original.budget, '20');
  assert.equal(original.stopPrice, '98');
});

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
