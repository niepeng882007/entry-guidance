import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { AccountError, readBinance, type Transport } from '../../src/account.ts';
import { createBinanceEgress } from '../../src/binance-egress.ts';
import { startAuthRuntime } from './runtime.ts';
import { assetsTransport } from './assets-fixture.ts';

void test('a later missing or invalid limits response cannot renew old confirmed limits', async (t) => {
  let valid = true;
  let calls = 0;
  const upstream: Transport = async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/exchangeInfo')
      return valid
        ? assetsTransport(url, headers, signal)
        : { status: 200, body: { rateLimits: [] } };
    calls++;
    return { status: 200, body: {} };
  };
  const runtime = await startAuthRuntime({ transport: assetsTransport });
  t.after(() => runtime.close());
  const egress = createBinanceEgress(runtime.database, upstream);
  const transport: Transport = (url, headers, signal, priority = 'foreground') =>
    egress.run(url, signal, priority, (bounded) => upstream(url, headers, bounded));
  const config = { transport };
  await readBinance(config, 'time', AbortSignal.timeout(10000));
  assert.equal(calls, 1);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(61000);
  valid = false;
  await assert.rejects(
    readBinance(config, 'time', AbortSignal.timeout(10000)),
    (error) => error instanceof AccountError && error.code === 'invalid_response',
  );
  assert.equal(calls, 1);
});

void test('weight returned across an interval boundary remains charged to the response window', async (t) => {
  let calls = 0;
  const upstream: Transport = async (url) => {
    if (url.pathname === '/fapi/v1/exchangeInfo')
      return {
        status: 200,
        body: {
          rateLimits: [
            { rateLimitType: 'REQUEST_WEIGHT', interval: 'SECOND', intervalNum: 1, limit: 20 },
          ],
        },
      };
    calls++;
    const next = (Math.floor(Date.now() / 1000) + 1) * 1000 + 250;
    await setTimeout(next - Date.now());
    return { status: 200, body: {}, headers: { 'x-mbx-used-weight-1s': '15' } };
  };
  const runtime = await startAuthRuntime({ transport: assetsTransport });
  t.after(() => runtime.close());
  const egress = createBinanceEgress(runtime.database, upstream);
  const transport: Transport = (url, headers, signal, priority = 'foreground') =>
    egress.run(url, signal, priority, (bounded) => upstream(url, headers, bounded));
  await readBinance({ transport }, 'time', AbortSignal.timeout(10000));
  await assert.rejects(
    readBinance({ transport }, 'time', AbortSignal.timeout(10000), undefined, undefined, 'archive'),
    (error) => error instanceof AccountError && error.code === 'rate_limited',
  );
  assert.equal(calls, 1);
});

void test('two dispatchers share weight reserves and prefer a waiting foreground read over archive', async (t) => {
  let used: string | undefined;
  let hold = false;
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const upstream: Transport = async (url, headers, signal) => {
    if (url.pathname === '/fapi/v1/exchangeInfo') return assetsTransport(url, headers, signal);
    calls.push(url.pathname);
    if (hold && url.pathname === '/fapi/v1/time') {
      entered();
      await gate;
    }
    return { status: 200, body: {}, headers: used ? { 'x-mbx-used-weight-1m': used } : {} };
  };
  const runtime = await startAuthRuntime({ transport: assetsTransport });
  t.after(() => runtime.close());
  const config = () => {
    const egress = createBinanceEgress(runtime.database, upstream);
    const transport: Transport = (url, headers, signal, priority = 'foreground') =>
      egress.run(url, signal, priority, (bounded) => upstream(url, headers, bounded, priority));
    return { transport };
  };
  const first = config(),
    second = config();
  const signal = AbortSignal.timeout(15000);
  await readBinance(first, 'exchange', signal);
  hold = true;
  const blocking = readBinance(first, 'time', signal);
  await seen;
  const archive = readBinance(first, 'last', signal, undefined, undefined, 'archive');
  const foreground = readBinance(second, 'book', signal);
  await setTimeout(150);
  release();
  await Promise.all([blocking, archive, foreground]);
  assert.deepEqual(calls, ['/fapi/v1/time', '/fapi/v1/ticker/bookTicker', '/fapi/v2/ticker/price']);
  hold = false;
  used = '1800';
  await readBinance(first, 'time', signal);
  const count = calls.length;
  await assert.rejects(
    readBinance(second, 'time', signal, undefined, undefined, 'archive'),
    (error) =>
      error instanceof AccountError && error.code === 'rate_limited' && Boolean(error.retryAt),
  );
  assert.equal(calls.length, count);
  await readBinance(second, 'time', signal);
  assert.equal(calls.length, count + 1);
  used = '2400';
  await readBinance(first, 'time', signal);
  await assert.rejects(
    readBinance(config(), 'time', signal),
    (error) => error instanceof AccountError && error.code === 'rate_limited',
  );
  assert.equal(calls.length, count + 2);
});
