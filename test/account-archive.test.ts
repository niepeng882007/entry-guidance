import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.ts';
import { readBinance, AccountError, type Transport } from '../src/account.ts';
import { coordinateAccountReads } from '../src/account-refresh.ts';
import { calendarStart } from '../src/history-sync.ts';
import { orderDownloadHost } from '../src/account.ts';
import { zipOrderCsv } from './order-file-fixture.ts';

const permissions = { enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, enableMargin: false, enableFutures: false, permitsUniversalTransfer: false, enableVanillaOptions: false, enableFixApiTrade: false, enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false };
const at = Date.now() - 86_400_000;
function fixture(): Transport {
  return async (url) => {
    const symbol = url.searchParams.get('symbol');
    const start = Number(url.searchParams.get('startTime')), end = Number(url.searchParams.get('endTime'));
    let body: unknown;
    switch (url.pathname) {
      case '/sapi/v1/account/apiRestrictions': body = permissions; break;
      case '/api/v3/account': body = { uid: 12345 }; break;
      case '/fapi/v1/time': body = { serverTime: Date.now() }; break;
      case '/fapi/v1/exchangeInfo': body = { symbols: [{ symbol: 'BTCUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT' }] }; break;
      case '/fapi/v1/income': body = at >= start && at <= end ? ['BTCUSDT', 'OLDUSDT'].filter((value) => !symbol || value === symbol).map((value) => ({ symbol: value, incomeType: 'COMMISSION', tranId: value === 'BTCUSDT' ? 1 : 2, time: at, income: '-0.1', asset: 'USDT', tradeId: '1' })) : []; break;
      case '/fapi/v1/userTrades': body = at >= start && at <= end ? [{ symbol, id: 1, orderId: 11, time: at, side: 'BUY', positionSide: 'BOTH', qty: '1', price: '100', realizedPnl: '0', commission: '0.1', commissionAsset: 'USDT' }] : []; break;
      case '/fapi/v1/allOrders': body = at >= start && at <= end ? [{ symbol, orderId: 11, time: at, side: 'BUY', positionSide: 'BOTH', type: 'MARKET', executedQty: '1' }] : []; break;
      case '/fapi/v2/positionRisk': body = symbol === 'OLDUSDT' ? [] : [{ symbol, positionSide: 'BOTH', positionAmt: '1' }]; break;
      case '/fapi/v1/allAlgoOrders': case '/fapi/v1/forceOrders': body = []; break;
      default: throw new Error(`unexpected GET ${url.pathname}`);
    }
    return { status: 200, body };
  };
}
async function start(t: TestContext, transport: Transport, reviewLedgerPath?: string) {
  const server = createServer({ password: 'archive-test-only', mode: 'real', apiKey: 'test-key', apiSecret: 'test-secret', transport, reviewLedgerPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=archive-test-only' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const get = () => fetch(`${base}/api/review/trades`, { headers: { Cookie: cookie } });
  const sync = () => fetch(`${base}/api/review/archive`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  return { server, base, cookie, get, sync };
}
async function finished(app: Awaited<ReturnType<typeof start>>) {
  for (let index = 0; index < 500; index++) {
    const response = await app.get();
    assert.equal(response.status, 200);
    const data = await response.json();
    if (data.archive && data.archive.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('archive did not finish');
}

test('account archive discovers historical delisted contracts and exposes conservative trade results', async (t) => {
  const app = await start(t, fixture());
  assert.equal((await app.sync()).status, 202);
  const data = await finished(app);
  assert.deepEqual(data.archive.symbols, ['BTCUSDT', 'OLDUSDT']);
  assert.equal(data.archive.status, 'complete');
  assert.equal(data.archive.contracts.length, 2);
  assert.ok(data.archive.scopeMissing.some((value: string) => value.includes('无法证明')));
  assert.deepEqual(data.trades.map((trade: { symbol: string }) => trade.symbol).sort(), ['BTCUSDT', 'OLDUSDT']);
  assert.equal(data.trades.find((trade: { symbol: string }) => trade.symbol === 'OLDUSDT').status, 'incomplete');
});

test('one manual archive downloads orders first, skips covered ordinary order pages and supplements realized pnl', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T17:00:00Z') });
  const base = fixture();
  let generations = 0, ordinaryOrders = 0;
  const fillTime = Date.parse('2026-10-13T16:00:00Z');
  const app = await start(t, async (url, headers, signal) => {
    if (url.hostname === orderDownloadHost) { assert.deepEqual(headers, {}); return { status: 200, body: zipOrderCsv() }; }
    if (url.pathname === '/fapi/v1/order/asyn') { generations++; return { status: 200, body: { downloadId: '123' } }; }
    if (url.pathname === '/fapi/v1/order/asyn/id') return { status: 200, body: { status: 'completed', url: `https://${orderDownloadHost}/controlled.zip` } };
    if (url.pathname === '/fapi/v1/allOrders') ordinaryOrders++;
    if (url.pathname === '/fapi/v1/userTrades' && url.searchParams.get('symbol') === 'BTCUSDT') return { status: 200, body: Number(url.searchParams.get('startTime')) <= fillTime && Number(url.searchParams.get('endTime')) >= fillTime ? [{ symbol: 'BTCUSDT', id: '44', orderId: '9007199254740993123', time: fillTime, side: 'SELL', positionSide: 'BOTH', qty: '0.5', price: '123', realizedPnl: '1.23456789', commission: '0.01', commissionAsset: 'USDT' }] : [] };
    return base(url, headers, signal);
  });
  assert.equal(generations, 0);
  await app.sync();
  const result = await finished(app);
  assert.equal(result.archive.orderDownload.status, 'complete');
  assert.equal(generations, 1); assert.equal(ordinaryOrders, 0);
  const response = await fetch(`${app.base}/api/review/orders`, { headers: { Cookie: app.cookie } });
  const rows = await response.json();
  assert.equal(rows.orders.find((row: { orderId: string }) => row.orderId === '9007199254740993123').realizedPnl, '1.23456789');
  await app.get();
  assert.equal(generations, 1);
});

test('a restarted bound ledger serves orders, reports, notes and exports without external identity reads', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'manual-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'real.sqlite');
  let app = await start(t, fixture(), path);
  await app.sync();
  const first = await finished(app);
  const id = first.trades[0].id as string;
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  await new Promise((resolve) => setImmediate(resolve));
  let externalReads = 0;
  app = await start(t, async () => { externalReads++; throw new Error('browsing must remain local'); }, path);
  for (const route of ['/api/review/orders', '/api/review/trades', `/api/review/trades/${id}`, '/api/review/journal', '/api/review/analysis', `/api/review/trades/${id}/analysis`, '/api/review/evidence?symbol=BTCUSDT']) {
    const response = await fetch(app.base + route, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 200, route);
  }
  assert.equal((await fetch(`${app.base}/api/review/trades/${id}/market?interval=1h`, { headers: { Cookie: app.cookie } })).status, 404);
  const backup = await fetch(`${app.base}/api/review/backup`, { method: 'POST', headers: { Cookie: app.cookie, Origin: app.base, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(backup.status, 200);
  assert.equal(externalReads, 0);
});

test('startup and five-minute ticks never read Binance; manual updates advance incrementally', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), 'account-archive-timer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = fixture();
  const queried: number[] = [];
  const app = await start(t, async (url, headers, signal) => {
    if (url.searchParams.has('startTime')) queried.push(Number(url.searchParams.get('startTime')));
    return base(url, headers, signal);
  }, join(directory, 'real.sqlite'));
  assert.equal(queried.length, 0);
  assert.equal((await (await app.get()).json()).accountId, null);
  await app.sync();
  const first = await finished(app);
  assert.equal(first.archive.status, 'complete');
  queried.length = 0;
  t.mock.timers.tick(300_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queried.length, 0);
  assert.equal((await (await app.get()).json()).archive.endTime, first.archive.endTime);
  await app.sync();
  const second = await finished(app);
  assert.equal(second.archive.endTime, first.archive.endTime + 300_000);
  assert.ok(queried.length > 0);
  assert.ok(queried.every((start) => start >= first.archive.endTime - 7 * 86_400_000));
  assert.equal(second.trades.length, 2);
});

test('full discovery preserves a failed page until the next manual retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), 'account-archive-pages-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let limited = true;
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/income' && !url.searchParams.has('symbol') && Number(url.searchParams.get('startTime')) <= at && Number(url.searchParams.get('endTime')) >= at) {
      if (url.searchParams.get('page') === '2') return limited ? { status: 429, body: { code: -1003 } } : { status: 200, body: [{ symbol: 'OLDUSDT', incomeType: 'COMMISSION', tranId: 1001, time: at, income: '-0.1', asset: 'USDT' }] };
      return { status: 200, body: Array.from({ length: 1000 }, (_, index) => ({ symbol: '', incomeType: 'TRANSFER', tranId: index + 1, time: at, income: '1', asset: 'USDT' })) };
    }
    return base(url, headers, signal);
  }, join(directory, 'real.sqlite'));
  await app.sync();
  const failed = await finished(app);
  assert.equal(failed.archive.status, 'failed');
  assert.equal(failed.archive.errorCode, 'rate_limited');
  assert.equal(failed.archive.discovery.pending[0].page, 2);
  assert.ok(!failed.archive.discovery.completed.some((range: { startTime: number; endTime: number }) => range.startTime <= at && range.endTime >= at));
  limited = false;
  t.mock.timers.tick(300_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await (await app.get()).json()).archive.status, 'failed');
  await app.sync();
  const recovered = await finished(app);
  assert.equal(recovered.archive.status, 'complete', JSON.stringify(recovered.archive.missing));
  assert.ok(recovered.archive.symbols.includes('OLDUSDT'));
  assert.ok(recovered.archive.discovery.records >= 1001);
});

test('overlapping full triggers coalesce while account reads share the same external request queue', async (t) => {
  const base = fixture();
  let notify!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { notify = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let blocked = false, active = 0, maximum = 0;
  const app = await start(t, async (url, headers, signal) => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (url.pathname === '/fapi/v1/income' && !blocked) { blocked = true; notify(); await gate; }
      if (url.pathname === '/sapi/v1/portfolio/account') return { status: 400, body: { code: -21001 } };
      if (url.pathname === '/fapi/v2/account') return { status: 200, body: { multiAssetsMargin: false, assets: [{ asset: 'USDT', walletBalance: '1000', unrealizedProfit: '0', marginBalance: '1000', availableBalance: '900' }] } };
      return await base(url, headers, signal);
    } finally { active--; }
  });
  await app.sync();
  await waiting;
  const concurrent = Promise.all([app.sync(), app.sync(), fetch(`${app.base}/api/account`, { headers: { Cookie: app.cookie } })]);
  release();
  const responses = await concurrent;
  assert.deepEqual(responses.map((response) => response.status), [202, 202, 200]);
  assert.equal(maximum, 1);
  const data = await finished(app);
  assert.equal(data.trades.length, 2);
});

test('a manual update with an unverified identity cannot advance the previous archive', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), 'account-archive-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let verified = true, reads = 0;
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/api/v3/account' && !verified) return { status: 200, body: {} };
    if (url.searchParams.has('startTime')) reads++;
    return base(url, headers, signal);
  }, join(directory, 'real.sqlite'));
  await app.sync();
  const first = await finished(app);
  verified = false;
  const before = reads;
  t.mock.timers.tick(300_000);
  await new Promise((resolve) => setImmediate(resolve));
  const refusal = await app.sync();
  assert.equal((await refusal.json()).code, 'unverified_identity');
  const data = await (await app.get()).json();
  assert.equal(data.archive.lastSuccessAt, first.archive.lastSuccessAt);
  assert.equal(reads, before);
  assert.equal(data.trades.length, 2);
});

test('after restart only a manual action resumes pages and preserves expired gaps', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), 'account-archive-expiry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'real.sqlite');
  const base = fixture();
  let limited = true;
  const transport: Transport = async (url, headers, signal) => limited && url.pathname === '/fapi/v1/allOrders' ? { status: 429, body: { code: -1003 } } : base(url, headers, signal);
  let app = await start(t, transport, path);
  await app.sync();
  const failed = await finished(app);
  assert.equal(failed.archive.status, 'failed');
  const originalEnd = failed.archive.discovery.endTime;
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  await new Promise((resolve) => setImmediate(resolve));
  limited = false;
  t.mock.timers.tick(120 * 86_400_000);
  app = await start(t, transport, path);
  assert.equal((await (await app.get()).json()).archive.status, 'failed');
  await app.sync();
  const resumed = await finished(app);
  assert.equal(resumed.archive.status, 'complete');
  assert.ok(resumed.archive.discovery.unavailable.length > 0);
  assert.ok(resumed.archive.discovery.unavailable.every((range: { startTime: number }) => range.startTime > originalEnd));
  assert.ok(resumed.archive.contracts.some((contract: { unavailable: unknown[] }) => contract.unavailable.length > 0));
  assert.ok(resumed.archive.discovery.missing.some((value: string) => value.includes('可查期限')));
  const raw = await fetch(`${app.base}/api/review/evidence?symbol=BTCUSDT`, { headers: { Cookie: app.cookie } });
  assert.ok((await raw.json()).records.some((row: { kind: string }) => row.kind === 'trades'));
});

test('a service stopped mid-discovery remains interrupted until a manual resume', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'account-archive-interrupt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'real.sqlite');
  const base = fixture();
  let notify!: () => void;
  const waiting = new Promise<void>((resolve) => { notify = resolve; });
  let app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/income' && !url.searchParams.has('symbol')) {
      notify();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
    return base(url, headers, signal);
  }, path);
  await app.sync();
  await waiting;
  const progress = await (await app.get()).json();
  assert.equal(progress.syncStatus, 'synced');
  assert.equal(progress.archive.discovery.completed.length, 0);
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  await new Promise((resolve) => setImmediate(resolve));
  app = await start(t, base, path);
  assert.equal((await (await app.get()).json()).archive.status, 'interrupted');
  await app.sync();
  const resumed = await finished(app);
  assert.equal(resumed.archive.status, 'complete');
  assert.equal(resumed.trades.length, 2);
});

test('conflicting discovery evidence cannot mark a failed page as complete or overwrite archived facts', async (t) => {
  let changed = false;
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    const response = await base(url, headers, signal);
    if (changed && url.pathname === '/fapi/v1/income' && !url.searchParams.has('symbol') && Array.isArray(response.body)) response.body = response.body.map((row) => ({ ...row, income: '-0.2' }));
    return response;
  });
  await app.sync();
  const first = await finished(app);
  changed = true;
  await app.sync();
  const failed = await finished(app);
  assert.equal(failed.archive.status, 'failed');
  assert.equal(failed.archive.lastSuccessAt, first.archive.lastSuccessAt);
  assert.ok(failed.archive.discovery.pending.some((range: { startTime: number; endTime: number }) => range.startTime <= at && range.endTime >= at));
  const evidence = await fetch(`${app.base}/api/review/evidence?symbol=BTCUSDT`, { headers: { Cookie: app.cookie } });
  assert.equal((await evidence.json()).records.find((row: { kind: string }) => row.kind === 'income').payload.income, '-0.1');
});

test('full archive refuses unsafe permissions and identifies network failures without advancing coverage', async (t) => {
  const base = fixture();
  const unsafe = await start(t, async (url, headers, signal) => url.pathname === '/sapi/v1/account/apiRestrictions' ? { status: 200, body: { ...permissions, enableFutures: true } } : base(url, headers, signal));
  const refused = await unsafe.sync();
  assert.equal(refused.status, 502);
  assert.equal((await refused.json()).code, 'unsafe_permissions');
  const offline = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/income') throw new Error('private transport failure must not escape');
    return base(url, headers, signal);
  });
  await offline.sync();
  const failed = await finished(offline);
  assert.equal(failed.archive.errorCode, 'connection_failed');
  assert.equal(failed.archive.discovery.completed.length, 0);
  assert.equal(failed.archive.lastSuccessAt, null);
  assert.doesNotMatch(JSON.stringify(failed), /private transport failure|test-secret|test-key/);
  const invalid = await fetch(`${offline.base}/api/review/archive`, { method: 'POST', headers: { Cookie: offline.cookie, Origin: offline.base, 'Content-Type': 'application/json' }, body: '{"url":"https://example.com"}' });
  assert.equal(invalid.status, 400);
  const wrongOrigin = await fetch(`${offline.base}/api/review/archive`, { method: 'POST', headers: { Cookie: offline.cookie, Origin: 'http://other.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(wrongOrigin.status, 403);
});

test('minute weight pressure pauses archive reads, lets foreground reads proceed and signs at dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let backgroundRead = false, signedAt = 0;
  let holdForeground = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = coordinateAccountReads({ apiKey: 'test-key', apiSecret: 'test-secret', transport: async (url: URL) => {
    if (url.pathname === '/fapi/v1/exchangeInfo') return { status: 200, body: { rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 2400 }] } };
    if (url.pathname === '/fapi/v1/time') return { status: 200, body: { serverTime: Date.now() }, headers: { 'x-mbx-used-weight-1m': '1800' } };
    if (url.pathname === '/api/v3/account' && holdForeground) await gate;
    if (url.pathname === '/fapi/v1/userTrades') { backgroundRead = true; signedAt = Number(url.searchParams.get('timestamp')); }
    return { status: 200, body: [] };
  } });
  const config = coordinator.strictConfig;
  const signal = new AbortController().signal;
  await readBinance(config, 'exchange', signal, undefined, undefined, 'archive');
  await readBinance(config, 'time', signal, undefined, undefined, 'archive');
  await assert.rejects(readBinance(config, 'trades', signal, 'BTCUSDT', { startTime: at, endTime: at + 1000 }, 'archive'), (error: unknown) => error instanceof AccountError && error.code === 'rate_limited' && error.retryAt !== undefined);
  await readBinance(config, 'identity', signal);
  assert.equal(backgroundRead, false);
  t.mock.timers.tick(60_000);
  holdForeground = true;
  const foreground = readBinance(config, 'identity', signal);
  const pending = readBinance(config, 'trades', signal, 'BTCUSDT', { startTime: at, endTime: at + 1000 }, 'archive');
  t.mock.timers.tick(6000);
  release();
  await foreground;
  await pending;
  assert.equal(signedAt, Date.now());
});

test('Retry-After prevents more external reads until the controlled cooldown ends', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let reads = 0;
  const config = coordinateAccountReads({ transport: async () => ++reads === 1 ? { status: 429, body: { code: -1003 }, headers: { 'retry-after': '60' } } : { status: 200, body: { serverTime: Date.now() } } }).strictConfig;
  const signal = new AbortController().signal;
  await assert.rejects(readBinance(config, 'time', signal), (error: unknown) => error instanceof AccountError && error.code === 'rate_limited');
  await assert.rejects(readBinance(config, 'time', signal), (error: unknown) => error instanceof AccountError && error.retryAt !== undefined);
  assert.equal(reads, 1);
  t.mock.timers.tick(59_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await readBinance(config, 'time', signal);
  assert.equal(reads, 2);
});

test('a clock advancing during every checkpoint still reads a partially expired first page', async (t) => {
  const clockStart = Date.now();
  let ticks = 0, incomeReads = 0;
  t.mock.method(Date, 'now', () => {
    if (++ticks === 4000) throw new Error('expiry loop did not make progress');
    return clockStart + ticks;
  });
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/income') incomeReads++;
    return base(url, headers, signal);
  });
  await app.sync();
  const result = await finished(app);
  assert.equal(result.archive.status, 'complete', JSON.stringify(result.archive.missing));
  assert.ok(incomeReads > 0);
  assert.ok(ticks < 4000);
  assert.ok(result.archive.contracts.every((contract: { status: string }) => contract.status === 'complete'));
});

test('discovery and contract responses cannot disagree about the same funding identity', async (t) => {
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    const response = await base(url, headers, signal);
    if (url.pathname === '/fapi/v1/income' && Array.isArray(response.body)) response.body = response.body.map((row) => ({ ...row, incomeType: 'FUNDING_FEE', tradeId: '', income: url.searchParams.has('symbol') ? '-0.2' : '-0.1' }));
    return response;
  });
  await app.sync();
  const data = await finished(app);
  assert.equal(data.archive.status, 'failed');
  assert.equal(data.archive.contracts.find((contract: { symbol: string }) => contract.symbol === 'BTCUSDT').status, 'failed');
  assert.ok(data.archive.contracts.find((contract: { symbol: string }) => contract.symbol === 'BTCUSDT').pending.some((page: { source: string; startTime: number; endTime: number }) => page.source === 'income' && page.startTime <= at && page.endTime >= at));
  const evidence = await fetch(`${app.base}/api/review/evidence?symbol=BTCUSDT`, { headers: { Cookie: app.cookie } });
  assert.equal((await evidence.json()).records.find((row: { kind: string }) => row.kind === 'income').payload.income, '-0.1');
});

test('a failed manual identity check can be retried without a background bootstrap', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'account-archive-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let unavailable = true;
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (url.pathname === '/api/v3/account' && unavailable) throw new Error('temporary identity failure');
    return base(url, headers, signal);
  }, join(directory, 'real.sqlite'));
  assert.equal((await (await app.get()).json()).accountId, null);
  const failed = await app.sync();
  assert.equal((await failed.json()).code, 'connection_failed');
  unavailable = false;
  assert.equal((await app.sync()).status, 202);
  const recovered = await finished(app);
  assert.equal(recovered.archive.status, 'complete');
  assert.equal(recovered.archiveIssue, undefined);
});

test('full income pages continue under an advancing retention boundary for both discovery and contracts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const denseAt = calendarStart(Date.now()) + 86_400_000;
  const secondPages = new Set<string>();
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    t.mock.timers.setTime(Date.now() + 1000);
    if (url.pathname === '/fapi/v1/income' && Number(url.searchParams.get('startTime')) <= denseAt && Number(url.searchParams.get('endTime')) >= denseAt) {
      const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT';
      if (url.searchParams.get('page') === '2') { secondPages.add(url.searchParams.get('symbol') ?? '*'); return { status: 200, body: [] }; }
      return { status: 200, body: Array.from({ length: 1000 }, (_, index) => ({ symbol, incomeType: 'FUNDING_FEE', tranId: (symbol === 'BTCUSDT' ? 10_000 : 20_000) + index, time: denseAt, income: '0', asset: 'USDT', tradeId: '' })) };
    }
    return base(url, headers, signal);
  });
  await app.sync();
  const data = await finished(app);
  assert.equal(data.archive.status, 'complete', JSON.stringify(data.archive.missing));
  assert.deepEqual([...secondPages].sort(), ['*', 'BTCUSDT', 'OLDUSDT']);
  assert.ok(data.archive.discovery.unavailable.length > 0);
  assert.ok(data.archive.contracts.every((contract: { status: string }) => contract.status === 'complete'));
});

test('retry prioritizes unfinished contracts so repeated limits cannot starve their initial history', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let limited = true;
  const queried: string[] = [];
  const base = fixture();
  const app = await start(t, async (url, headers, signal) => {
    if (limited && url.pathname === '/fapi/v1/allOrders' && url.searchParams.get('symbol') === 'OLDUSDT') return { status: 429, body: { code: -1003 } };
    if (url.pathname === '/fapi/v1/userTrades') queried.push(url.searchParams.get('symbol')!);
    return base(url, headers, signal);
  });
  await app.sync();
  const failed = await finished(app);
  assert.deepEqual(failed.archive.pendingSymbols, ['OLDUSDT']);
  limited = false; queried.length = 0;
  t.mock.timers.setTime(Date.now() + 300_000);
  await app.sync();
  const recovered = await finished(app);
  // OLDUSDT has already read its fills; its anchor/tail query must still precede BTC's incremental reads.
  assert.equal(queried[0], 'OLDUSDT');
  assert.equal(recovered.archive.status, 'complete');
});
