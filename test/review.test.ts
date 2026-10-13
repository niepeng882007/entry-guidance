import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server.ts';

async function start(t: TestContext, config: Partial<Parameters<typeof createServer>[0]> = {}) {
  const server = createServer({ password: 'review-test-only', ...config });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { if (server.listening) { server.closeAllConnections(); server.close(); } });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=review-test-only' });
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  return { server, base, cookie, get };
}

test('review is protected and a demo archive survives logout and a server restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { mode: 'demo' as const, reviewLedgerPath: join(directory, 'demo.sqlite'), transport: async () => { throw new Error('demo must not query Binance'); } };
  let app = await start(t, config);
  assert.equal((await fetch(`${app.base}/review`, { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await fetch(`${app.base}/api/review/trades`)).status, 401);
  const page = await app.get('/review');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-page="review"/);
  assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const list = await (await app.get('/api/review/trades')).json();
  assert.equal(list.source, 'demo');
  assert.equal(list.syncStatus, 'demo');
  assert.equal(list.trades.length, 1);
  const id = list.trades[0].id;
  const detail = await (await app.get(`/api/review/trades/${id}`)).json();
  assert.equal(detail.netPnl, '12.4735');
  assert.equal(detail.evidence.fills.length, 4);
  assert.equal((await fetch(`${app.base}/logout`, { method: 'POST', headers: { Cookie: app.cookie, Origin: 'http://other.invalid' }, redirect: 'manual' })).status, 403);
  await fetch(`${app.base}/logout`, { method: 'POST', headers: { Cookie: app.cookie, Origin: app.base }, redirect: 'manual' });
  assert.equal((await app.get('/api/review/trades')).status, 401);
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  app = await start(t, config);
  const reopened = await (await app.get('/api/review/trades')).json();
  assert.equal(reopened.trades.length, 1);
  assert.equal(reopened.trades[0].id, id);
  assert.equal((await app.get('/api/review/trades/missing')).status, 404);
  assert.equal((await app.get('/.local/review/demo.sqlite')).status, 404);
});

test('real review explicitly remains unsynced and never opens a demo ledger or calls Binance', async (t) => {
  const app = await start(t, {
    mode: 'real', reviewLedgerPath: '/not-a-ledger-directory/real.sqlite',
    transport: async () => { throw new Error('review must not query real history yet'); },
  });
  const page = await app.get('/review');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-mode="binance"/);
  assert.match(html, /真实模式/);
  assert.deepEqual(await (await app.get('/api/review/trades')).json(), {
    source: 'binance', accountId: null, syncStatus: 'not-synced', trades: [],
  });
  assert.equal((await app.get('/api/review/trades/BTCUSDT-demo-fill-1')).status, 404);
  assert.equal((await fetch(`${app.base}/api/review/trades`, { method: 'POST', headers: { Cookie: app.cookie, Origin: app.base } })).status, 405);
});

test('a filesystem write failure gives a bounded error without disclosing paths or credentials', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // An existing directory cannot be opened as a SQLite database file.
  const app = await start(t, { mode: 'demo', reviewLedgerPath: directory });
  const response = await app.get('/api/review/trades');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '复盘账本暂不可用，已有归档保留，请重试。' });
  assert.equal((await app.get('/review')).status, 200);
});


test('review addition preserves existing demo recovery.v1 signatures with configured credentials', async (t) => {
  const app = await start(t, { mode: 'demo', apiKey: 'legacy-demo-test-key', apiSecret: 'legacy-demo-test-secret' });
  const post = (path: string, value: unknown) => fetch(`${app.base}${path}`, {
    method: 'POST', headers: { Cookie: app.cookie, Origin: app.base, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const response = await post('/api/plan', {
    symbol: 'BTCUSDT', side: 'long', budgetMode: 'amount', budget: '10',
    stopMode: 'percent', stop: '2', slippage: '0.1', funding: '0', leverage: '5', minimumBuffer: '1', fundingCap: '',
  });
  assert.equal(response.status, 200);
  const plan = await response.json();
  const payload = plan.recovery.split('.')[0];
  // This is the published v1 contract before the review ledger was introduced.
  const key = scryptSync('review-test-only', JSON.stringify(['entry-guidance.recovery.v1', 'demo', 'legacy-demo-test-key', 'legacy-demo-test-secret']), 32);
  const recovery = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
  assert.equal((await post('/api/plan/recover', { recovery })).status, 200);
});
