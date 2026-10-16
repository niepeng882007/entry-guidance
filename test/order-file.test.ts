import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderCsvFiles, parseOrderCsv } from '../src/order-file.ts';
import { orderCsv, zipOrderCsv } from './order-file-fixture.ts';
import { ReviewLedger, type ArchiveState } from '../src/review-ledger.ts';
import { readOrderFile, updateOrderHistory } from '../src/order-download.ts';
import { orderDownloadHost, type AccountConfig } from '../src/account.ts';
import { coordinateAccountReads } from '../src/account-refresh.ts';

const startTime = Date.parse('2026-10-13T00:00:00Z'),
  endTime = Date.parse('2026-10-14T00:00:00Z') - 1;
const parse = (text: string) => parseOrderCsv(text, '12345', startTime, endTime);
void test('the shared queue never re-signs a CDN file or sends account headers to it', async () => {
  const coordinator = coordinateAccountReads({
    apiKey: 'controlled-key',
    apiSecret: 'controlled-secret',
    transport: async (url, headers) => {
      assert.deepEqual(headers, {});
      assert.equal(url.searchParams.get('signature'), 'download-signature');
      assert.equal(url.searchParams.has('timestamp'), false);
      return { status: 200, body: zipOrderCsv() };
    },
  });
  try {
    await readOrderFile(
      coordinator.strictConfig,
      `https://${orderDownloadHost}/file.zip?signature=download-signature`,
      AbortSignal.timeout(1000),
    );
  } finally {
    coordinator.stop();
  }
});
void test('verified ZIP schema keeps int64 identities, UTC times and exact scientific notation', () => {
  const files = orderCsvFiles(zipOrderCsv());
  const [row] = parse(files[0]!);
  assert.equal(row!.id, '9007199254740993123');
  assert.equal(row!.time, Date.parse('2026-10-14T00:00:00+08:00'));
  assert.equal(row!.payload.price, '123');
  assert.equal(row!.payload.stopPrice, '0');
  assert.equal(parse(orderCsv({ 'Average Price': '' }))[0]!.payload.avgPrice, null);
  assert.throws(() => parse(orderCsv({ Uid: 'another-account' })), /账户/);
  assert.deepEqual(parse(orderCsv({ Symbol: 'BTCUSDC' })), []);
  assert.throws(() => parse(orderCsv({ Price: '1E-9' })), /数值/);
  assert.throws(() => parse(orderCsv({ 'Time(UTC)': '2026-02-30 00:00:00' })), /时间/);
  assert.throws(() => parse(orderCsv().replace('Time(UTC)', 'Time')), /格式/);
  const broken = zipOrderCsv();
  broken[40] = broken[40]! ^ 0xff;
  assert.throws(() => orderCsvFiles(broken), /格式/);
  assert.throws(() => orderCsvFiles(Buffer.from('not a zip')), /格式/);
});

const permissions = {
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
function state(): ArchiveState {
  return {
    status: 'running',
    startTime,
    endTime,
    discovery: {
      symbol: '*',
      startTime,
      endTime,
      status: 'running',
      pages: 0,
      records: 0,
      pending: [],
      completed: [],
      missing: [],
      lastSuccessAt: null,
    },
    symbols: [],
    pendingSymbols: [],
    completedSymbols: [],
    missing: [],
    scopeMissing: [],
    lastSuccessAt: null,
  };
}
void test('a saved download task is reused and files are written atomically under the verified UID', async () => {
  const ledger = new ReviewLedger(':memory:', { source: 'binance', accountId: '12345' });
  let generations = 0,
    headersSent = 0;
  const config: AccountConfig = {
    apiKey: 'controlled-key',
    apiSecret: 'controlled-secret',
    transport: async (url, headers) => {
      if (url.hostname === orderDownloadHost) {
        headersSent = Object.keys(headers).length;
        return { status: 200, body: zipOrderCsv() };
      }
      if (url.pathname.endsWith('/apiRestrictions')) return { status: 200, body: permissions };
      if (url.pathname === '/api/v3/account') return { status: 200, body: { uid: '12345' } };
      if (url.pathname.endsWith('/id'))
        return {
          status: 200,
          body: {
            status: 'completed',
            url: `https://${orderDownloadHost}/controlled.zip?token=private`,
          },
        };
      generations++;
      return { status: 200, body: { downloadId: '123' } };
    },
  };
  try {
    const progress = state();
    progress.orderDownload = {
      status: 'processing',
      downloadId: '123',
      startTime,
      endTime,
      records: 0,
      message: 'pending',
    };
    await updateOrderHistory(config, ledger, progress, AbortSignal.timeout(1000));
    assert.equal(generations, 0);
    assert.equal(headersSent, 0);
    assert.equal(progress.orderDownload.status, 'complete');
    assert.equal(ledger.raw('BTCUSDT').length, 1);
    assert.equal(ledger.raw('BTCUSDT')[0]!.payload.orderId, '9007199254740993123');
    const fresh = state();
    await updateOrderHistory(config, ledger, fresh, AbortSignal.timeout(1000));
    assert.equal(generations, 1);
    assert.equal(ledger.raw('BTCUSDT').length, 1);
    await assert.rejects(
      readOrderFile(config, 'https://attacker.invalid/file.zip', AbortSignal.timeout(1000)),
      /白名单/,
    );
  } finally {
    ledger.close();
  }
});

void test('unknown generation outcomes are retained without another quota request and invalid account files do not write', async () => {
  const ledger = new ReviewLedger(':memory:', { source: 'binance', accountId: '12345' });
  let calls = 0;
  const config: AccountConfig = {
    apiKey: 'controlled-key',
    apiSecret: 'controlled-secret',
    transport: async () => {
      calls++;
      throw new Error('private signed url');
    },
  };
  try {
    const progress = state();
    await updateOrderHistory(config, ledger, progress, AbortSignal.timeout(1000));
    assert.equal(progress.orderDownload?.status, 'unknown');
    await updateOrderHistory(config, ledger, progress, AbortSignal.timeout(1000));
    assert.equal(calls, 1);
    assert.equal(ledger.allRaw().length, 0);
    assert.doesNotMatch(JSON.stringify(progress), /private signed url/);
    progress.orderDownload = {
      status: 'processing',
      downloadId: '123',
      startTime,
      endTime,
      records: 0,
      message: '',
    };
    await updateOrderHistory(
      {
        ...config,
        transport: async (url) => ({
          status: 200,
          body:
            url.hostname === orderDownloadHost
              ? zipOrderCsv(orderCsv({ Uid: '67890' }))
              : { status: 'completed', url: `https://${orderDownloadHost}/test.zip` },
        }),
      },
      ledger,
      progress,
      AbortSignal.timeout(1000),
    );
    assert.equal(progress.orderDownload.status, 'failed');
    assert.equal(ledger.allRaw().length, 0);
  } finally {
    ledger.close();
  }
});
