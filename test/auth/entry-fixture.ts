import type { Transport } from '../../src/account.ts';
import { assetsTransport } from './assets-fixture.ts';
export function entryFixture() {
  const now = Date.now() - 1000;
  const position = {
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    positionAmt: '0',
    entryPrice: '0',
    liquidationPrice: '0',
    leverage: '10',
    marginType: 'isolated',
    isolatedWallet: '0',
    updateTime: 0,
  };
  const data: Record<string, unknown> = {
    '/api/v3/account': { uid: 10001 },
    '/fapi/v1/time': { serverTime: now },
    '/sapi/v1/account/apiRestrictions': {
      enableReading: true,
      enableWithdrawals: false,
      enableInternalTransfer: false,
      enableMargin: false,
      enableFutures: false,
      permitsUniversalTransfer: false,
      enableVanillaOptions: false,
      enableFixApiTrade: false,
      enableSpotAndMarginTrading: false,
      enablePortfolioMarginTrading: false,
    },
    '/sapi/v1/portfolio/account': { code: -21001 },
    '/fapi/v2/account': {
      canTrade: true,
      multiAssetsMargin: false,
      assets: [
        {
          asset: 'USDT',
          walletBalance: '1000',
          unrealizedProfit: '0',
          marginBalance: '1000',
          availableBalance: '1000',
        },
      ],
      positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', isolated: true }],
    },
    '/fapi/v1/positionSide/dual': { dualSidePosition: false },
    '/fapi/v2/positionRisk': [position],
    '/fapi/v1/forceOrders': [],
    '/fapi/v1/openOrders': [],
    '/fapi/v1/openAlgoOrders': [],
    '/fapi/v1/userTrades': [],
    '/fapi/v1/allOrders': [],
    '/fapi/v1/income': [],
    '/fapi/v1/allAlgoOrders': [],
    '/fapi/v1/commissionRate': { symbol: 'BTCUSDT', takerCommissionRate: '0.001' },
    '/fapi/v1/leverageBracket': {
      symbol: 'BTCUSDT',
      brackets: [
        {
          bracket: 1,
          initialLeverage: 20,
          notionalFloor: 0,
          notionalCap: 1000000,
          maintMarginRatio: 0.01,
          cum: 0,
        },
      ],
    },
    '/fapi/v2/ticker/price': { symbol: 'BTCUSDT', price: '100', time: now },
    '/fapi/v1/ticker/bookTicker': { symbol: 'BTCUSDT', bidPrice: '99', askPrice: '100', time: now },
    '/fapi/v1/premiumIndex': { symbol: 'BTCUSDT', markPrice: '100', time: now },
    '/fapi/v1/exchangeInfo': {
      symbols: [
        {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          marginAsset: 'USDT',
          status: 'TRADING',
          contractType: 'PERPETUAL',
          orderTypes: ['MARKET', 'LIMIT', 'STOP_MARKET'],
          timeInForce: ['GTC'],
          marketTakeBound: '0.30',
          filters: [
            { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
            { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
            { filterType: 'MARKET_LOT_SIZE', minQty: '0.1', maxQty: '1000', stepSize: '0.1' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
            { filterType: 'PERCENT_PRICE', multiplierUp: '1.2', multiplierDown: '0.8' },
          ],
        },
      ],
    },
  };
  return { data, position, now };
}

export const entryTransport: Transport = async (url, headers, signal) => {
  const data = entryFixture().data;
  if (url.pathname === '/fapi/v2/account') {
    const result = await assetsTransport(url, headers, signal);
    return {
      ...result,
      body: {
        ...(result.body as object),
        canTrade: true,
        positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0', isolated: true }],
      },
    };
  }
  if (url.pathname === '/fapi/v1/exchangeInfo') {
    const body = data[url.pathname] as { symbols: unknown[] };
    return {
      status: 200,
      body: {
        ...body,
        // Browser cases share this synthetic budget; egress.test.ts exercises real-sized limits.
        rateLimits: [
          { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 24000 },
        ],
      },
    };
  }
  if (
    url.pathname === '/sapi/v1/account/apiRestrictions' ||
    url.pathname === '/api/v3/account' ||
    url.pathname === '/sapi/v1/portfolio/account'
  )
    return assetsTransport(url, headers, signal);
  if (!(url.pathname in data)) throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  return { status: 200, body: data[url.pathname] };
};

export function entryScenarios() {
  const scenarios = new Map<string, { scenario: string; time: number }>();
  function select(value: unknown) {
    if (
      !value ||
      typeof value !== 'object' ||
      !('user' in value) ||
      !('scenario' in value) ||
      !['alice', 'bob'].includes(String(value.user)) ||
      ![
        'flat',
        'protected',
        'missing-stop',
        'wrong-stop',
        'missing-cost',
        'failed',
        'limit-waiting',
        'limit-partial',
        'limit-partial-more',
        'limit-canceled',
        'limit-unfilled-canceled',
        'limit-inconsistent',
        'limit-missing-stop',
        'limit-missing-cost',
      ].includes(String(value.scenario))
    )
      throw new Error('Invalid synthetic entry scenario');
    scenarios.set(String(value.user), { scenario: String(value.scenario), time: Date.now() - 100 });
  }
  const transport: Transport = async (url, headers, signal) => {
    const result = await entryTransport(url, headers, signal);
    const selected = scenarios.get(headers['X-MBX-APIKEY']?.includes('bob') ? 'bob' : 'alice');
    if (!selected || selected.scenario === 'flat') return result;
    const { scenario, time } = selected;
    const limit = scenario.startsWith('limit-');
    const unfilled = ['limit-waiting', 'limit-unfilled-canceled'].includes(scenario);
    const quantity = unfilled ? '0' : scenario === 'limit-partial' ? '0.1' : '0.4';
    const active = [
      'limit-waiting',
      'limit-partial',
      'limit-partial-more',
      'limit-inconsistent',
    ].includes(scenario);
    let status = 'FILLED';
    if (limit) status = active ? 'PARTIALLY_FILLED' : 'CANCELED';
    if (limit && active && unfilled) status = 'NEW';
    const order = {
      symbol: 'BTCUSDT',
      orderId: 10,
      side: 'BUY',
      positionSide: 'BOTH',
      type: limit ? 'LIMIT' : 'MARKET',
      origType: limit ? 'LIMIT' : 'MARKET',
      status,
      time,
      updateTime: time,
      origQty: limit ? '0.495' : '0.4',
      executedQty: quantity,
      avgPrice: unfilled ? '0' : '100',
      price: limit ? '100' : '0',
      stopPrice: '0',
      workingType: 'CONTRACT_PRICE',
      priceProtect: false,
      goodTillDate: 0,
      timeInForce: 'GTC',
      reduceOnly: false,
      closePosition: false,
    };
    if (limit && url.pathname === '/fapi/v1/openOrders')
      return { status: 200, body: active && scenario !== 'limit-inconsistent' ? [order] : [] };
    if (scenario === 'failed' && url.pathname === '/fapi/v1/premiumIndex')
      return { status: 503, body: { msg: 'Synthetic market unavailable' } };
    if (url.pathname === '/fapi/v1/time') return { status: 200, body: { serverTime: Date.now() } };
    if (url.pathname === '/fapi/v2/account')
      return {
        ...result,
        body: {
          ...(result.body as object),
          positions: [
            { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: quantity, isolated: true },
          ],
        },
      };
    if (url.pathname === '/fapi/v2/positionRisk')
      return {
        status: 200,
        body: [
          {
            ...entryFixture().position,
            positionAmt: quantity,
            entryPrice: unfilled ? '0' : '100',
            liquidationPrice: '90',
            isolatedWallet: '4',
            updateTime: time,
          },
        ],
      };
    if (url.pathname === '/fapi/v1/userTrades')
      return {
        status: 200,
        body: unfilled
          ? []
          : [
              {
                symbol: 'BTCUSDT',
                id: 1,
                orderId: 10,
                side: 'BUY',
                positionSide: 'BOTH',
                time,
                price: '100',
                qty: quantity,
                quoteQty: quantity === '0.1' ? '10' : '40',
                commission: scenario.endsWith('missing-cost')
                  ? undefined
                  : quantity === '0.1'
                    ? '0.01'
                    : '0.04',
                commissionAsset: 'USDT',
                realizedPnl: '0',
              },
            ],
      };
    if (url.pathname === '/fapi/v1/allOrders') return { status: 200, body: [order] };
    if (url.pathname === '/fapi/v1/income')
      return {
        status: 200,
        body: unfilled
          ? []
          : [
              {
                symbol: 'BTCUSDT',
                incomeType: 'FUNDING_FEE',
                income: '-0.3',
                asset: 'USDT',
                time,
                tranId: 123,
              },
            ],
      };
    if (url.pathname === '/fapi/v1/openAlgoOrders')
      return {
        status: 200,
        body:
          unfilled || scenario.endsWith('missing-stop')
            ? []
            : [
                {
                  symbol: 'BTCUSDT',
                  algoId: 20,
                  algoType: 'CONDITIONAL',
                  algoStatus: 'NEW',
                  orderType: 'STOP_MARKET',
                  side: 'SELL',
                  positionSide: 'BOTH',
                  quantity: '0',
                  triggerPrice: scenario === 'wrong-stop' ? '97' : '98',
                  workingType: 'MARK_PRICE',
                  priceProtect: false,
                  closePosition: true,
                  reduceOnly: false,
                  actualOrderId: '',
                  triggerTime: 0,
                  createTime: time,
                  updateTime: time,
                  timeInForce: 'GTC',
                  goodTillDate: 0,
                },
              ],
      };
    return result;
  };
  return { select, transport };
}
