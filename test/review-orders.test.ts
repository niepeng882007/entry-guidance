import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewLedger, demoTrade, type RawRecord, type SyncState } from '../src/review-ledger.ts';
import { listOrders, orderRecords } from '../src/review-orders.ts';
import { requestOrderDownload } from '../src/order-download.ts';

void test('order results retain individual exits and link back to the same complete trade', () => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  try {
    ledger.archive(demoTrade());
    const rows = orderRecords(ledger);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.realizedPnl),
      ['9', '4', '0'],
    );
    assert.equal(new Set(rows.flatMap((row) => row.tradeIds)).size, 1);
    assert.deepEqual(rows[0]!.commissions, [{ asset: 'USDT', amount: '0.1845' }]);
    assert.equal(listOrders(ledger, 'demo', new URLSearchParams('from=2026-10-11')).total, 0);
    assert.throws(() => listOrders(ledger, 'demo', new URLSearchParams('side=long')));
  } finally {
    ledger.close();
  }
});

void test('partial cancellations use exact original fills; missing or mismatched quantities never become zero pnl', () => {
  const ledger = new ReviewLedger(':memory:', {
    source: 'binance',
    accountId: 'controlled-account',
  });
  const time = Date.parse('2026-10-13T16:00:00Z');
  const state: SyncState = {
    symbol: 'BTCUSDT',
    startTime: time,
    endTime: time + 1000,
    status: 'complete',
    pages: 1,
    records: 4,
    pending: [],
    completed: [],
    missing: [],
    lastSuccessAt: null,
  };
  const order = (id: string, quantity: string): RawRecord => ({
    kind: 'history',
    id,
    time,
    payload: {
      symbol: 'BTCUSDT',
      orderId: id,
      time,
      side: 'SELL',
      type: 'LIMIT',
      status: 'CANCELED',
      origQty: '2',
      executedQty: quantity,
    },
  });
  const fill: RawRecord = {
    kind: 'trades',
    id: '1',
    time,
    payload: {
      symbol: 'BTCUSDT',
      id: '1',
      orderId: '9007199254740993123',
      time,
      side: 'SELL',
      positionSide: 'BOTH',
      qty: '0.5',
      price: '100',
      realizedPnl: '-0.00000001',
      commission: '0.00000001',
      commissionAsset: 'BNB',
    },
  };
  try {
    ledger.saveSync(state, [
      order('9007199254740993123', '0.5'),
      order('2', '1'),
      order('3', '0'),
      fill,
    ]);
    ledger.saveSync(state, [fill]);
    const rows = orderRecords(ledger);
    const completed = rows.find((row) => row.orderId === '9007199254740993123')!;
    assert.equal(completed.realizedPnl, '-0.00000001');
    assert.deepEqual(completed.commissions, [{ asset: 'BNB', amount: '0.00000001' }]);
    assert.equal(rows.find((row) => row.orderId === '2')!.realizedPnl, null);
    assert.equal(rows.find((row) => row.orderId === '3')!.realizedPnl, '0');
    assert.equal(
      listOrders(ledger, 'binance', new URLSearchParams('from=2026-10-14&to=2026-10-14')).total,
      3,
    );
    assert.equal(listOrders(ledger, 'binance', new URLSearchParams('to=2026-10-13')).total, 0);
  } finally {
    ledger.close();
  }
});

void test('download generation and status use fixed signed GET destinations without leaking upstream details', async () => {
  const seen: URL[] = [];
  const config = {
    apiKey: 'controlled-key',
    apiSecret: 'controlled-secret',
    transport: async (url: URL) => {
      seen.push(url);
      return {
        status: 200,
        body: url.pathname.endsWith('/id')
          ? { status: 'processing', url: '' }
          : { downloadId: '9007199254740993123' },
      };
    },
  };
  const result = await requestOrderDownload(
    config,
    { startTime: 1, endTime: 100 },
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(result, { downloadId: '9007199254740993123' });
  assert.deepEqual(
    await requestOrderDownload(
      config,
      { downloadId: '9007199254740993123' },
      AbortSignal.timeout(1000),
    ),
    { status: 'processing', url: '' },
  );
  assert.deepEqual(
    seen.map((url) => url.pathname),
    ['/fapi/v1/order/asyn', '/fapi/v1/order/asyn/id'],
  );
  assert.ok(
    seen.every((url) => url.hostname === 'fapi.binance.com' && url.searchParams.has('signature')),
  );
  await assert.rejects(
    requestOrderDownload(
      config,
      { downloadId: 'https://example.invalid' },
      AbortSignal.timeout(1000),
    ),
    /身份无效/,
  );
  await assert.rejects(
    requestOrderDownload(
      {
        ...config,
        transport: async () => {
          throw new Error('credential must not escape');
        },
      },
      { startTime: 1, endTime: 2 },
      AbortSignal.timeout(1000),
    ),
    /未得到确认/,
  );
});
