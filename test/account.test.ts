import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { get } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server.ts';

const permissions = {
  enableReading: true, enableWithdrawals: false, enableInternalTransfer: false,
  enableMargin: false, enableFutures: false, permitsUniversalTransfer: false,
  enableVanillaOptions: false, enableFixApiTrade: false,
  enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false,
};
const accountResponse = {
  multiAssetsMargin: false,
  // These deliberately differ from the USDT asset and must not be used.
  totalWalletBalance: '9000.00000000', availableBalance: '8000.00000000',
  assets: [{ asset: 'USDT', walletBalance: '1000.10000001', unrealizedProfit: '-25.00000002',
    marginBalance: '975.09999999', availableBalance: '700.03000000', initialMargin: '275.06999999',
    crossUnPnl: '99.00000000', updateTime: 0 }],
};

async function start(t: TestContext, config: Partial<Parameters<typeof createServer>[0]> = {}) {
  const server = createServer({ password: 'test-password-only', ...config });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function login(base: string, password = 'test-password-only') {
  return fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
    body: new URLSearchParams({ password }),
  });
}

test('anonymous visitors cannot open the account page or read account data', async (t) => {
  const base = await start(t);

  const page = await fetch(base, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login');
  const account = await fetch(`${base}/api/account`);
  assert.equal(account.status, 401);
  assert.equal(account.headers.get('cache-control'), 'no-store');
  const assetsPage = await fetch(`${base}/account`, { redirect: 'manual' });
  assert.equal(assetsPage.status, 303);
  assert.equal(assetsPage.headers.get('location'), '/login');
  assert.equal((await fetch(`${base}/api/account/assets`)).status, 401);
});

test('built frontend assets require login and only explicit build filenames are served', async (t) => {
  const base = await start(t, { mode: 'demo' });
  const signedIn = await login(base);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
  const page = await (await fetch(base, { headers: { Cookie: cookie } })).text();
  assert.match(page, /id="app"/);
  assert.match(page, /模拟数据/);
  const assets = Array.from(page.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g), (match) => match[1]!);
  assert.ok(assets.some((path) => path.endsWith('.js')));
  assert.ok(assets.some((path) => path.endsWith('.css')));
  const detailsPage = await fetch(`${base}/account`, { headers: { Cookie: cookie } });
  assert.equal(detailsPage.status, 200);
  const detailsHtml = await detailsPage.text();
  assert.match(detailsHtml, /账户快照 · USDT/);
  assert.match(detailsHtml, /data-page="account"/);
  assert.match(detailsHtml, /data-mode="demo"/);
  for (const path of assets) assert.ok(detailsHtml.includes(path));
  for (const path of assets) {
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    const asset = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'no-store');
    assert.match(asset.headers.get('content-type')!, path.endsWith('.js') ? /text\/javascript/ : /text\/css/);
    assert.equal(asset.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  }
  for (const path of ['/assets/missing.js', '/assets/index.js.map', '/assets/%2e%2e%2fsrc%2fserver.ts', '/.env', '/src/server.ts', '/@vite/client', '/app.js', '/draft.js', '/select.js']) {
    assert.equal((await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).status, 404);
  }
});

test('personal login rejects wrong passwords and allows access until logout', async (t) => {
  const base = await start(t);
  const loginPage = await fetch(`${base}/login`);
  // Native form POSTs need a non-null same-origin Origin for CSRF validation.
  assert.equal(loginPage.headers.get('referrer-policy'), 'same-origin');
  assert.equal((await login(base, 'wrong')).status, 401);
  const signedIn = await login(base);
  assert.equal(signedIn.status, 303);
  const cookieHeader = signedIn.headers.get('set-cookie');
  assert.ok(cookieHeader);
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  const cookie = cookieHeader.split(';')[0]!;
  const page = await fetch(base, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="app"/);
  const account = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
  assert.equal(account.status, 503);
  assert.equal((await account.json()).code, 'missing_credentials');
  const logout = await fetch(`${base}/logout`, {
    method: 'POST', headers: { Cookie: cookie, Origin: base }, redirect: 'manual',
  });
  assert.equal(logout.status, 303);
  assert.equal((await fetch(`${base}/api/account`, { headers: { Cookie: cookie } })).status, 401);
});

test('authenticated account reads use USDT equity and available balance with exact decimals', async (t) => {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async (url, headers) => {
      requests.push({ url, headers });
      if (url.pathname === '/sapi/v1/account/apiRestrictions') return { status: 200, body: permissions };
      if (url.pathname === '/sapi/v1/portfolio/account') return { status: 400, body: { code: -21001 } };
      return { status: 200, body: accountResponse };
    },
  });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const before = Date.now();
  const response = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'binance');
  assert.equal(body.equity, '975.09999999');
  assert.equal(body.availableBalance, '700.03000000');
  assert.equal(body.walletBalance, '1000.10000001');
  assert.equal(body.unrealizedProfit, '-25.00000002');
  assert.ok(Date.parse(body.queriedAt) >= before);
  assert.ok(Date.parse(body.queriedAt) <= Date.now());
  assert.deepEqual(requests.map(({ url }) => `${url.origin}${url.pathname}`), [
    'https://api.binance.com/sapi/v1/account/apiRestrictions',
    'https://api.binance.com/sapi/v1/portfolio/account',
    'https://fapi.binance.com/fapi/v2/account',
  ]);
  for (const { url, headers } of requests) {
    assert.equal(headers['X-MBX-APIKEY'], 'controlled-test-key');
    assert.match(url.searchParams.get('signature')!, /^[a-f0-9]{64}$/);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['recvWindow', 'signature', 'timestamp']);
    const signed = new URLSearchParams(url.search);
    const signature = signed.get('signature');
    signed.delete('signature');
    assert.equal(signature, createHmac('sha256', 'controlled-test-secret').update(signed.toString()).digest('hex'));
  }
  assert.doesNotMatch(JSON.stringify(body), /controlled-test|signature|crossUnPnl|initialMargin/);
});

test('independent assets read uses exact USDT amounts even with cross and hedge positions', async (t) => {
  const paths: string[] = [];
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async (url) => {
      paths.push(url.pathname);
      if (url.pathname.endsWith('apiRestrictions')) return { status: 200, body: permissions };
      if (url.pathname === '/sapi/v1/portfolio/account') return { status: 400, body: { code: -21001 } };
      return { status: 200, body: { ...accountResponse, canTrade: false,
        positions: [{ symbol: 'BTCUSDT', positionSide: 'LONG', isolated: false, positionAmt: '1' },
          { symbol: 'BTCUSDT', positionSide: 'SHORT', isolated: false, positionAmt: '-2' }],
        assets: [{ ...accountResponse.assets[0], positionInitialMargin: '200.00000001',
          openOrderInitialMargin: '75.06999998', maintMargin: '3.12345678', maxWithdrawAmount: '690.00000001' }],
      } };
    },
  });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(`${base}/api/account/assets`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.equity, '975.09999999');
  assert.equal(body.availableBalance, '700.03000000');
  assert.equal(body.unrealizedProfit, '-25.00000002');
  assert.equal(body.positionInitialMargin, '200.00000001');
  assert.equal(body.openOrderInitialMargin, '75.06999998');
  assert.equal(body.maintMargin, '3.12345678');
  assert.equal(body.maxWithdrawAmount, '690.00000001');
  assert.equal(body.source, 'binance');
  assert.ok(Number.isFinite(Date.parse(body.queriedAt)));
  assert.deepEqual(paths, ['/sapi/v1/account/apiRestrictions', '/sapi/v1/portfolio/account', '/fapi/v2/account']);
  assert.doesNotMatch(JSON.stringify(body), /controlled-test|signature|positions|totalWalletBalance/);
});

test('asset details distinguish absent amounts from malformed amounts without changing the summary', async (t) => {
  let fields: Record<string, unknown> = {};
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async (url) => {
      if (url.pathname.endsWith('apiRestrictions')) return { status: 200, body: permissions };
      if (url.pathname === '/sapi/v1/portfolio/account') return { status: 400, body: { code: -21001 } };
      return { status: 200, body: { ...accountResponse, assets: [{ ...accountResponse.assets[0], ...fields }] } };
    },
  });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const read = (path: string) => fetch(base + path, { headers: { Cookie: cookie } });
  const missing = await (await read('/api/account/assets')).json();
  for (const field of ['positionInitialMargin', 'openOrderInitialMargin', 'maintMargin', 'maxWithdrawAmount']) {
    assert.equal(missing[field], null);
    for (const invalid of ['NaN', '0.000000001', 1, null]) {
      fields = { [field]: invalid };
      const response = await read('/api/account/assets');
      assert.equal(response.status, 502);
      const error = await response.json();
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.equity, undefined);
    }
  }
  fields = { maintMargin: 'NaN' };
  const summary = await read('/api/account');
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).maintMargin, undefined);
  fields = { positionInitialMargin: '0' };
  assert.equal((await (await read('/api/account/assets')).json()).positionInitialMargin, '0.00000000');
});

test('logout during a pending asset read prevents the response from exposing account data', async (t) => {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async (url) => {
      if (url.pathname.endsWith('apiRestrictions')) {
        started();
        await entered;
        return { status: 200, body: permissions };
      }
      if (url.pathname === '/sapi/v1/portfolio/account') return { status: 400, body: { code: -21001 } };
      return { status: 200, body: accountResponse };
    },
  });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const pending = fetch(`${base}/api/account/assets`, { headers: { Cookie: cookie } });
  await reading;
  const logout = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base } });
  assert.equal(logout.status, 303);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal((await response.json()).equity, undefined);
});

test('read-only failures are explicit and never expose a balance or upstream secrets', async (t) => {
  const cases: { name: string; permission?: unknown; account?: unknown; status?: number; error?: string; expected: string }[] = [
    ...Object.keys(permissions).filter((field) => field !== 'enableReading').map((field) => ({
      name: `reject writable permission ${field}`, permission: { ...permissions, [field]: true }, expected: 'unsafe_permissions',
    })),
    { name: 'reading disabled', permission: { ...permissions, enableReading: false }, expected: 'reading_disabled' },
    { name: 'incomplete permission report', permission: { enableReading: true }, expected: 'unverified_permissions' },
    { name: 'multi-asset', account: { ...accountResponse, multiAssetsMargin: true }, expected: 'unsupported_account' },
    { name: 'unknown mode', account: { ...accountResponse, multiAssetsMargin: undefined }, expected: 'unsupported_account' },
    { name: 'no USDT asset', account: { ...accountResponse, assets: [] }, expected: 'unsupported_account' },
    { name: 'duplicate USDT asset', account: { ...accountResponse, assets: [accountResponse.assets[0], accountResponse.assets[0]] }, expected: 'unsupported_account' },
    { name: 'invalid amount', account: { ...accountResponse, assets: [{ ...accountResponse.assets[0], walletBalance: 'NaN' }] }, expected: 'invalid_response' },
    { name: 'unexpected precision', account: { ...accountResponse, assets: [{ ...accountResponse.assets[0], walletBalance: '0.000000001' }] }, expected: 'invalid_response' },
    { name: 'inconsistent equity', account: { ...accountResponse, assets: [{ ...accountResponse.assets[0], marginBalance: '999' }] }, expected: 'invalid_response' },
    { name: 'malformed response', account: null, expected: 'invalid_response' },
    { name: 'exchange limit', status: 429, expected: 'rate_limited' },
    { name: 'exchange failure', status: 500, expected: 'upstream_error' },
    { name: 'redirect is not followed', status: 302, expected: 'upstream_error' },
    { name: 'network failure with a secret in the exception', error: 'controlled-test-key?signature=private', expected: 'connection_failed' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const base = await start(t, {
      apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
      transport: async (url) => {
        if (scenario.error) throw new Error(scenario.error);
        if (scenario.status) return { status: scenario.status, body: { msg: 'controlled-test-secret signature=private' } };
        if (url.pathname.endsWith('apiRestrictions')) return { status: 200, body: scenario.permission ?? permissions };
        if (url.pathname === '/sapi/v1/portfolio/account') return { status: 400, body: { code: -21001 } };
        return { status: 200, body: 'account' in scenario ? scenario.account : accountResponse };
      },
    });
    const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
    for (const path of ['/api/account', '/api/account/assets', '/api/account/positions']) {
      const result = await fetch(base + path, { headers: { Cookie: cookie } });
      assert.equal(result.status, 502);
      const body = await result.json();
      assert.equal(body.code, scenario.expected);
      assert.equal(body.equity, undefined);
      assert.equal(body.queriedAt, undefined);
      assert.equal(body.source, 'binance');
      assert.doesNotMatch(JSON.stringify(body), /controlled-test|signature=|private/);
    }
  });
});

test('unknown routes, methods and URLs never become signed requests', async (t) => {
  let requests = 0;
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async () => { requests++; throw new Error('must not reach Binance'); },
  });
  assert.equal((await fetch(`${base}/api/account`)).status, 401);
  assert.equal((await fetch(`${base}/app.js`)).status, 401);
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  for (const path of ['/api/account?url=https://example.com', '/api/account?symbol=BTCUSDT', '/api/account/assets?symbol=BTCUSDT', '/api/account/assets?url=https://example.com', '/api/order', '/.env', '/src/account.ts', '/%2e%2e/.env']) {
    assert.equal((await fetch(base + path, { headers: { Cookie: cookie } })).status, 404);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    for (const path of ['/api/account', '/api/account/assets', '/api/account/positions', '/account']) {
      assert.equal((await fetch(base + path, { method, headers: { Cookie: cookie, Origin: base } })).status, 405);
    }
  }
  assert.equal(requests, 0);
});

test('login blocks cross-origin requests, oversized input, forged sessions and brute force', async (t) => {
  const base = await start(t);
  assert.equal((await fetch(`${base}/login`, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    get(base, { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await login(base, 'x'.repeat(3000))).status, 413);
  assert.equal((await fetch(`${base}/api/account`, { headers: { Cookie: 'session=forged' } })).status, 401);
  for (let i = 0; i < 9; i++) assert.equal((await login(base, 'wrong')).status, 401);
  const limited = await login(base);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('whole account query has a bounded timeout and no fallback', async (t) => {
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async (_url, _headers, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const result = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
  assert.equal(result.status, 504);
  const body = await result.json();
  assert.equal(body.code, 'timeout');
  assert.equal(body.source, 'binance');
  assert.equal(body.equity, undefined);
});

test('upstream refusal is sanitized and does not turn into demo data', async (t) => {
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async () => ({ status: 401, body: { code: -2015, msg: 'controlled-test-key signature=private' } }),
  });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const result = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
  const body = await result.json();
  assert.equal(result.status, 502);
  assert.equal(body.source, 'binance');
  assert.equal(body.code, 'access_denied');
  assert.equal(body.equity, undefined);
  assert.equal(body.queriedAt, undefined);
  assert.ok(Date.parse(body.attemptedAt));
  assert.doesNotMatch(JSON.stringify(body), /controlled-test|signature=|private/);
});

test('demo is explicit, authenticated and never sends Binance requests', async (t) => {
  const base = await start(t, { mode: 'demo', transport: async () => { throw new Error('must not request Binance'); } });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const result = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).source, 'demo');
  const page = await fetch(base, { headers: { Cookie: cookie } });
  assert.match(await page.text(), /模拟数据/);
});

test('Portfolio Margin Pro must not be reported as an ordinary USDT account', async (t) => {
  const base = await start(t, {
    apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret',
    transport: async (url) => ({ status: 200, body:
      url.pathname.endsWith('apiRestrictions') ? permissions :
      url.pathname === '/sapi/v1/account/info' ? { isPortfolioMarginRetailEnabled: false } :
      url.pathname === '/sapi/v1/portfolio/account' ? { accountType: 'PM_1' } : accountResponse,
    }),
  });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const result = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
  assert.equal(result.status, 502);
  assert.equal((await result.json()).code, 'unsupported_account');
});

test('all current positions remain separate across symbols, hedge sides and margin modes', async (t) => {
  const base = await start(t, { apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret', transport: async (url) => {
    const body = url.pathname.endsWith('apiRestrictions') ? permissions
      : url.pathname.endsWith('portfolio/account') ? { code: -21001 }
      : url.pathname.endsWith('/account') ? accountResponse
      : url.pathname.endsWith('exchangeInfo') ? { symbols: ['BTCUSDT', 'ETHUSDT'].map((symbol) => ({ symbol, contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'BREAK' })) }
      : url.pathname.endsWith('positionRisk') ? [
        { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '-0.12345678', marginType: 'cross', leverage: '10', entryPrice: '2000', markPrice: '1990', unRealizedProfit: '1.23456789' },
        { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '-0.01', marginType: 'isolated', leverage: '5', entryPrice: '60000', markPrice: '60100', unRealizedProfit: '-1', liquidationPrice: '70000', breakEvenPrice: '59990', isolatedWallet: '120', notional: '-601', updateTime: 1234567890000 },
        { symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.02', marginType: 'cross', leverage: '3', entryPrice: '60000', markPrice: '60100', unRealizedProfit: '2' },
        { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0' },
      ] : url.pathname.endsWith('premiumIndex') ? [{ symbol: 'BTCUSDT', lastFundingRate: '0.0001', nextFundingTime: 1900000000000, time: 1234567890001 }]
      : [{ symbol: 'BTCUSDT', price: '60101', time: 1234567890002 }];
    return { status: url.pathname.endsWith('portfolio/account') ? 400 : 200, body };
  } });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(`${base}/api/account/positions`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.positions.map((p: { symbol: string; direction: string }) => [p.symbol, p.direction]), [['BTCUSDT', 'LONG'], ['BTCUSDT', 'SHORT'], ['ETHUSDT', 'SHORT']]);
  assert.equal(data.positions[2].quantity, '0.12345678');
  assert.equal(data.positions[2].unrealizedProfit, '1.23456789');
  assert.equal(data.positions[2].liquidationPrice, null);
  assert.equal(data.positions[1].isolatedWallet, '120.00000000');
  assert.equal(data.last.data[0].price, '60101.00000000');
  assert.equal(data.funding.data[0].rate, '0.00010000');
  assert.doesNotMatch(JSON.stringify(data), /controlled-test|signature/);
});

test('position observation excludes delivery contracts and keeps facts when auxiliary reads fail', async (t) => {
  let phase = 'mixed';
  const row = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.12345678', marginType: 'cross', leverage: '10', entryPrice: '60000', markPrice: '60100', unRealizedProfit: '-9.12345678' };
  const base = await start(t, { apiKey: 'controlled-test-key', apiSecret: 'controlled-test-secret', transport: async (url) => {
    if (url.pathname.endsWith('apiRestrictions')) return { status: 200, body: permissions };
    if (url.pathname.endsWith('portfolio/account')) return { status: 400, body: { code: -21001 } };
    if (url.pathname.endsWith('/account')) return { status: 200, body: accountResponse };
    if (url.pathname.endsWith('exchangeInfo')) return { status: 200, body: { symbols: [
      { symbol: 'BTCUSDT', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL' },
      { symbol: 'ETHUSDT_261225', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'CURRENT_QUARTER' },
    ] } };
    if (url.pathname.endsWith('positionRisk')) return { status: 200, body: phase === 'empty' ? [] : phase === 'invalid' ? [{ ...row, markPrice: 'NaN' }] : phase === 'missing' ? {} : [row, ...(phase === 'mixed' ? [{ ...row, symbol: 'ETHUSDT_261225' }, { ...row, symbol: 'BTCUSD_PERP' }] : [])] };
    return { status: 429, body: { code: -1003, msg: 'controlled-test-secret' } };
  } });
  const cookie = (await login(base)).headers.get('set-cookie')!.split(';')[0]!;
  const read = () => fetch(`${base}/api/account/positions`, { headers: { Cookie: cookie } });
  const response = await read();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.positions.length, 1);
  assert.equal(data.positions[0].unrealizedProfit, '-9.12345678');
  assert.equal(data.last.status, 'error');
  assert.equal(data.funding.status, 'error');
  assert.doesNotMatch(JSON.stringify(data), /controlled-test-secret/);
  for (const fail of ['invalid', 'missing']) {
    phase = fail;
    const failed = await read();
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).positions, undefined);
  }
  phase = 'empty';
  assert.deepEqual((await (await read()).json()).positions, []);
  assert.equal((await fetch(`${base}/api/account/positions`)).status, 401);
  assert.equal((await fetch(`${base}/api/account/positions?symbol=BTCUSDT`, { headers: { Cookie: cookie } })).status, 404);
});
