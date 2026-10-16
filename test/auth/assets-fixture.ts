import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Transport } from '../../src/account.ts';
import { bindingTransport } from './binding-fixture.ts';

export const assetsTransport: Transport = async (url, headers, signal) => {
  if (url.pathname === '/sapi/v1/account/apiRestrictions' || url.pathname === '/api/v3/account')
    return bindingTransport(url, headers, signal);
  if (url.pathname === '/fapi/v1/exchangeInfo')
    return {
      status: 200,
      body: {
        symbols: [],
        rateLimits: [
          { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 2400 },
        ],
      },
    };
  const bob = headers['X-MBX-APIKEY']?.includes('bob');
  const secret = bob
    ? 'synthetic-secret-bob'
    : headers['X-MBX-APIKEY']?.includes('rotated')
      ? 'synthetic-secret-alice-rotated'
      : 'synthetic-secret-alice';
  const unsigned = new URL(url);
  unsigned.searchParams.delete('signature');
  assert.equal(
    url.searchParams.get('signature'),
    createHmac('sha256', secret).update(unsigned.searchParams.toString()).digest('hex'),
  );
  if (url.pathname === '/sapi/v1/portfolio/account') return { status: 400, body: { code: -21001 } };
  assert.equal(url.origin, 'https://fapi.binance.com');
  if (url.pathname === '/fapi/v2/account')
    return {
      status: 200,
      body: {
        multiAssetsMargin: false,
        assets: [
          {
            asset: 'USDT',
            walletBalance: bob ? '2000' : '1000.10000001',
            unrealizedProfit: bob ? '50' : '-25.00000002',
            marginBalance: bob ? '2050' : '975.09999999',
            availableBalance: bob ? '1800' : '700.03',
            positionInitialMargin: '200',
            openOrderInitialMargin: '75',
            maintMargin: '10',
            maxWithdrawAmount: '600',
          },
        ],
      },
    };
  if (
    ['/fapi/v2/positionRisk', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders'].includes(
      url.pathname,
    )
  )
    return { status: 200, body: [] };
  throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
};
