import type { ReviewList } from '../src/review-ledger.ts';
import { defaultReviewFilters } from '../src/review-filters.ts';
import { seedReviewFilters } from './review-filter-fixtures.ts';
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
    filters: defaultReviewFilters(), total: 0, page: 1, pageSize: 20, nextPage: null, options: { symbols: [], tags: [] },
  });
  assert.equal((await app.get('/api/review/trades/BTCUSDT-demo-fill-1')).status, 404);
  assert.equal((await fetch(`${app.base}/api/review/trades`, { method: 'POST', headers: { Cookie: app.cookie, Origin: app.base } })).status, 405);
});

test('market evidence is protected, source-labelled and persists across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-market-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { mode: 'demo' as const, reviewLedgerPath: join(directory, 'demo.sqlite'), transport: async () => { throw new Error('demo must not query Binance'); } };
  let app = await start(t, config);
  const path = '/api/review/trades/BTCUSDT-demo-fill-1/market?interval=15m';
  assert.equal((await fetch(`${app.base}${path}`)).status, 401);
  const response = await app.get(path);
  assert.equal(response.status, 200);
  const chart = await response.json();
  assert.equal(chart.source, 'demo');
  assert.equal(chart.interval, '15m');
  assert.equal(chart.series.contract.complete, true);
  assert.equal(chart.series.mark.complete, true);
  assert.equal(chart.events[0].price, '60000');
  assert.equal(chart.events[0].event, 'entry');
  assert.equal(chart.events[2].event, 'reduce');
  assert.equal(chart.events[3].event, 'exit');
  assert.equal(chart.series.contract.candles.length, 69);
  assert.notEqual(chart.series.contract.candles[0].close, chart.series.mark.candles[0].close);
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  app = await start(t, config);
  const reopened = await (await app.get(path)).json();
  assert.equal(reopened.snapshotId, chart.snapshotId);
  assert.equal(reopened.queriedAt, chart.queriedAt);
  assert.equal((await app.get(path.replace('15m', '2m'))).status, 400);
  assert.equal((await app.get(`${path}&url=https://other.invalid`)).status, 400);
  assert.equal((await app.get(path.replace('BTCUSDT-demo-fill-1', 'missing'))).status, 404);
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


test('legacy signed recovery remains usable but cannot retroactively claim an account or saved review evidence', async (t) => {
  const app = await start(t, { mode: 'demo' });
  const post = (path: string, value: unknown) => fetch(`${app.base}${path}`, {
    method: 'POST', headers: { Cookie: app.cookie, Origin: app.base, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const plan = await (await post('/api/plan', {
    symbol: 'BTCUSDT', side: 'long', budgetMode: 'amount', budget: '10', stopMode: 'percent', stop: '2', slippage: '0.1', funding: '0', leverage: '5', minimumBuffer: '1', fundingCap: '',
  })).json();
  const record = JSON.parse(Buffer.from(plan.recovery.split('.')[0], 'base64url').toString('utf8'));
  delete record.plan.reviewAccountId;
  delete record.plan.takerRate;
  record.plan.id = 'legacy-plan-without-identity';
  const payload = Buffer.from(JSON.stringify(record)).toString('base64url');
  const key = scryptSync('review-test-only', JSON.stringify(['entry-guidance.recovery.v1', 'demo', '', '']), 32);
  const recovery = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
  const response = await post('/api/plan/recover', { recovery });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reviewAccountId, undefined);
  const check = await (await app.get(`/api/verification?planId=${record.plan.id}&demo=protected`)).json();
  assert.equal(check.status, 'verified');
  assert.equal(check.reviewRetention, 'legacy-unbound');
});

test('personal notes and confirmed tags survive relogin and restart without changing exchange facts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-notes-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { mode: 'demo' as const, reviewLedgerPath: join(directory, 'demo.sqlite') };
  let app = await start(t, config);
  const post = (path: string, input: unknown) => fetch(`${app.base}${path}`, {
    method: 'POST', headers: { Cookie: app.cookie, Origin: app.base, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const list = await (await app.get('/api/review/trades')).json();
  const id = list.trades[0].id;
  const detail = await (await app.get(`/api/review/trades/${id}`)).json();
  const created = await post('/api/review/tags', { name: '顺势', id: null, version: 0, active: true });
  assert.equal(created.status, 200);
  const tag = (await created.json()).tags[0];
  const input = { noteId: null, version: 0, basis: detail.noteBasis, entryReason: '趋势突破', exitReason: '按计划退出', executionProblem: '', improvement: '', freeNote: '<script>alert(1)</script>', tagIds: [tag.id] };
  const saved = await post(`/api/review/trades/${id}/note`, input);
  assert.equal(saved.status, 200);
  const note = (await saved.json()).notes[0];
  assert.equal(note.entryReason, '趋势突破');
  assert.equal(note.binding, 'current');
  assert.equal(note.version, 1);
  assert.ok(Number.isFinite(Date.parse(note.updatedAt)));
  assert.equal(note.trade.evidence.fills.length, 4);
  const updated = await post(`/api/review/trades/${id}/note`, { ...input, noteId: note.id, version: 1, freeNote: '复盘更新' });
  assert.equal(updated.status, 200);
  assert.equal((await post(`/api/review/trades/${id}/note`, { ...input, noteId: note.id, version: 1 })).status, 409);
  assert.equal((await post('/api/review/tags', { id: tag.id, version: 1, name: '顺势交易', active: false })).status, 200);
  assert.equal((await post('/api/review/tags', { id: tag.id, version: 1, name: '旧设备覆盖', active: true })).status, 409);
  await new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); });
  app = await start(t, config);
  const journal = await (await app.get('/api/review/journal')).json();
  assert.equal(journal.notes[0].freeNote, '复盘更新');
  assert.equal(journal.notes[0].version, 2);
  assert.deepEqual(journal.notes[0].tagIds, [tag.id]);
  assert.equal(journal.tags[0].name, '顺势交易');
  assert.equal(journal.tags[0].active, false);
  const facts = await (await app.get(`/api/review/trades/${id}`)).json();
  assert.equal(facts.netPnl, '12.4735');
  assert.equal(facts.exitReason, undefined);
});

test('personal writes reject unauthenticated, foreign-origin, malformed and oversized input', async (t) => {
  const app = await start(t, { mode: 'demo' });
  const list = await (await app.get('/api/review/trades')).json();
  const detail = await (await app.get(`/api/review/trades/${list.trades[0].id}`)).json();
  const path = `/api/review/trades/${detail.id}/note`;
  const input = { noteId: null, version: 0, basis: detail.noteBasis, entryReason: '', exitReason: '', executionProblem: '', improvement: '', freeNote: '', tagIds: [] };
  const post = (value: unknown, headers: Record<string, string> = {}) => fetch(`${app.base}${path}`, { method: 'POST', headers: { Cookie: app.cookie, Origin: app.base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await post(input, { Cookie: '' })).status, 401);
  assert.equal((await post(input, { Origin: 'http://other.invalid' })).status, 403);
  assert.equal((await post(input, { 'Content-Type': 'text/plain' })).status, 415);
  for (const invalid of [null, [], { ...input, freeNote: 12 }, { ...input, freeNote: '\u0000' }, { ...input, entryReason: 'x'.repeat(2001) }, { ...input, freeNote: 'x'.repeat(10001) }, { ...input, version: 0.5 }, { ...input, tagIds: ['missing'] }, { ...input, source: 'binance' }]) assert.equal((await post(invalid)).status, 400);
  assert.equal((await post({ ...input, freeNote: 'x'.repeat(100001) })).status, 413);
  assert.equal((await post({ ...input, basis: '0'.repeat(64) })).status, 409);
  assert.equal((await post(input)).status, 200);
  const journal = await (await app.get('/api/review/journal')).json();
  assert.equal(journal.notes.length, 1);
  assert.equal(journal.notes[0].freeNote, '');
  const directory = mkdtempSync(join(tmpdir(), 'review-write-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const broken = await start(t, { mode: 'demo', reviewLedgerPath: directory });
  const failed = await fetch(`${broken.base}/api/review/tags`, { method: 'POST', headers: { Cookie: broken.cookie, Origin: broken.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: null, version: 0, name: '顺势', active: true }) });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /review-write-failure|sqlite|browser-test/);
});


test('trade filters compose on the HTTP boundary with Shanghai calendar dates', async (t) => {
  const app = await start(t, { mode: 'demo' });
  const response = await app.get('/api/review/trades?from=2026-10-10&to=2026-10-10&symbol=BTCUSDT&side=long&pnl=win&status=closed&entryType=LIMIT&plan=unconfirmed');
  assert.equal(response.status, 200);
  const list = await response.json();
  assert.equal(list.total, 1);
  assert.equal(list.page, 1);
  assert.equal(list.pageSize, 20);
  assert.equal(list.nextPage, null);
  assert.equal(list.filters.timeZone, 'Asia/Shanghai');
  assert.equal(list.filters.dateField, 'openedAt');
  assert.equal(list.trades[0].entryType, 'LIMIT');
  assert.deepEqual(list.trades[0].tagIds, []);
  const empty = await (await app.get('/api/review/trades?side=short&pnl=win')).json();
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.trades, []);
});


test('filtered pagination preserves the whole range, boundaries, unknowns and saved tags', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-filters-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'demo.sqlite');
  const seeded = seedReviewFilters(path);
  const app = await start(t, { mode: 'demo', reviewLedgerPath: path });
  const read = async (query = ''): Promise<ReviewList> => {
    const response = await app.get(`/api/review/trades${query ? `?${query}` : ''}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await read();
  const second = await read('page=2');
  assert.equal(first.total, 29);
  assert.equal(first.trades.length, 20);
  assert.equal(first.nextPage, 2);
  assert.equal(second.total, 29);
  assert.equal(second.trades.length, 9);
  assert.equal(second.nextPage, null);
  assert.equal(new Set([...first.trades, ...second.trades].map((trade) => trade.id)).size, 29);
  assert.equal(second.trades.at(-1)!.id, seeded.unknownStart);
  assert.equal(first.trades[0]!.id, seeded.end);
  const btc = await read('symbol=BTCUSDT');
  assert.equal(btc.total, 22);
  assert.equal(btc.trades[0]!.id, 'BTCUSDT-demo-fill-1');
  assert.equal(btc.trades.at(-1)!.id, 'BTCUSDT-demo-fill-1-page-19');
  assert.deepEqual((await read('symbol=BTCUSDT&page=2')).trades.map((trade) => trade.id), ['BTCUSDT-demo-fill-1-page-20', 'BTCUSDT-demo-fill-1-page-21']);
  assert.deepEqual((await read('symbol=ETHUSDT&from=2026-10-10&to=2026-10-10')).trades.map((trade) => trade.id), [seeded.start]);
  assert.deepEqual((await read('symbol=ETHUSDT&dateField=closedAt&from=2026-10-10&to=2026-10-10')).trades.map((trade) => trade.id), [seeded.start, seeded.before]);
  const tags = seeded.tags.map((id) => `tag=${id}`).join('&');
  const combined = await read(`symbol=ETHUSDT&side=short&pnl=loss&status=closed&entryType=mixed&plan=unconfirmed&${tags}`);
  assert.equal(combined.total, 1);
  assert.equal(combined.trades[0]!.id, seeded.start);
  assert.equal(combined.options.tags.find((tag) => tag.id === seeded.tags[0])!.active, false);
  assert.equal((await read(`tag=${seeded.tags[0]}`)).total, 2); // Pending note is excluded.
  assert.equal((await read('pnl=flat')).trades[0]!.id, seeded.flat);
  assert.equal((await read('pnl=pending')).total, 3);
  assert.equal((await read('status=open')).trades[0]!.id, seeded.open);
  assert.equal((await read('entryType=unknown&status=incomplete')).total, 2);
  assert.equal((await read('status=open&dateField=closedAt&from=2026-10-10')).total, 0);
  const detail = await (await app.get(`/api/review/trades/${seeded.pending}`)).json();
  assert.equal(detail.netPnl, null);
  assert.equal(detail.evidence.fills[0].commissionAsset, 'BNB');
  assert.equal((await fetch(`${app.base}/api/review/trades?${tags}`)).status, 401);
});

test('invalid filter parameters fail before querying an archive', async (t) => {
  const app = await start(t, { mode: 'demo' });
  for (const query of [
    'from=2026-02-30', 'to=2026-13-01', 'from=2026-10-11&to=2026-10-10', 'from=',
    'dateField=time', 'timeZone=UTC', 'symbol=btc', 'side=BUY', 'pnl=positive', 'status=complete',
    'entryType=FAKE', 'plan=ambiguous', 'tag=foreign', 'page=0', 'page=1.5', 'page=1000000',
    'side=long&side=short', 'page=1&page=2', 'tag=00000000-0000-0000-0000-000000000000&tag=00000000-0000-0000-0000-000000000000',
    'source=binance', 'accountId=other-account', 'limit=9999',
  ]) {
    const response = await app.get(`/api/review/trades?${query}`);
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error, /筛选参数无效/);
  }
});
