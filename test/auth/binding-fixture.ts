import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Transport } from '../../src/account.ts';
export const permissions = {
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
};
export const bindingTransport: Transport = async (url, headers) => {
  const apiKey = headers['X-MBX-APIKEY'];
  const uid = apiKey?.includes('bob') ? '10002' : '10001';
  let secret = 'synthetic-secret-alice';
  if (apiKey?.includes('bob')) secret = 'synthetic-secret-bob';
  if (apiKey?.includes('rotated')) secret = 'synthetic-secret-alice-rotated';
  const unsigned = new URL(url);
  unsigned.searchParams.delete('signature');
  assert.equal(
    url.searchParams.get('signature'),
    createHmac('sha256', secret).update(unsigned.searchParams.toString()).digest('hex'),
  );
  assert.equal(url.origin, 'https://api.binance.com');
  if (url.pathname === '/sapi/v1/account/apiRestrictions')
    return { status: 200, body: permissions };
  assert.equal(url.pathname, '/api/v3/account');
  return { status: 200, body: { uid } };
};
