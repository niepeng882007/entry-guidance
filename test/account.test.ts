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
});

test('workbench navigation has focusable destinations and keeps result states initially hidden', async (t) => {
  const base = await start(t, { mode: 'demo' });
  const signedIn = await login(base);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
  const page = await (await fetch(base, { headers: { Cookie: cookie } })).text();
  const ids = Array.from(page.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique for focus and render targets');
  const destinations = Array.from(page.matchAll(/class="module-nav__link" href="#([^"]+)"/g), (match) => match[1]);
  assert.equal(destinations.length, 6);
  for (const id of destinations) assert.match(page, new RegExp(`<[^>]+id="${id}"[^>]+tabindex="-1"`));
  for (const id of ['draft-result', 'entry-checks', 'entry-card', 'verification']) {
    assert.match(page, new RegExp(`<section[^>]*id="${id}"[^>]*\\bhidden\\b`));
  }
  assert.match(page, /尚未生成开仓卡/);
  assert.match(page, /尚无可核验的方案/);
  assert.ok(page.indexOf('id="plan-module"') < page.indexOf('id="account-module"'));
});

test('select enhancement is served as an authenticated JavaScript module', async (t) => {
  const base = await start(t, { mode: 'demo' });
  const anonymous = await fetch(`${base}/select.js`, { redirect: 'manual' });
  assert.equal(anonymous.status, 401);
  const signedIn = await login(base);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
  const module = await fetch(`${base}/select.js`, { headers: { Cookie: cookie } });
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type')!, /text\/javascript/);
  assert.match(await module.text(), /export function enhanceSelects/);
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
  assert.match(await page.text(), /账户权益/);
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
    const result = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
    assert.equal(result.status, 502);
    const body = await result.json();
    assert.equal(body.code, scenario.expected);
    assert.equal(body.equity, undefined);
    assert.equal(body.queriedAt, undefined);
    assert.equal(body.source, 'binance');
    assert.doesNotMatch(JSON.stringify(body), /controlled-test|signature=|private/);
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
  for (const path of ['/api/account?url=https://example.com', '/api/account?symbol=BTCUSDT', '/api/order', '/.env', '/src/account.ts', '/%2e%2e/.env']) {
    assert.equal((await fetch(base + path, { headers: { Cookie: cookie } })).status, 404);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await fetch(`${base}/api/account`, { method, headers: { Cookie: cookie, Origin: base } })).status, 405);
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
