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
    updateTime: now,
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
        rateLimits: [
          { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 2400 },
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
