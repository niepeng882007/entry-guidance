import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from '../src/server.ts';
import type { AnalysisTask } from '../src/trade-analysis.ts';
import { simulatedModel, modelResponse } from './analysis-fixtures.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { ReviewLedger } from '../src/review-ledger.ts';
import { seedReviewFilters } from './review-filter-fixtures.ts';

async function app(t: TestContext, llm = simulatedModel(), reviewLedgerPath?: string, tradeId = 'BTCUSDT-demo-fill-1') {
  const server = createServer({ password: 'analysis-test-only', mode: 'demo', llm, reviewLedgerPath });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { if (server.listening) { server.closeAllConnections(); server.close(); } });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=analysis-test-only' });
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const path = `/api/review/trades/${tradeId}/analysis`;
  return { server, base, cookie, get: () => fetch(`${base}${path}`, { headers: { Cookie: cookie } }), post: (data: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) };
}
async function finished(application: Awaited<ReturnType<typeof app>>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = (await (await application.get()).json()).tasks[0] as AnalysisTask;
    if (task && task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('task did not settle');
}
const startInput = { includeNotes: false, regenerate: false, query: '' };

test('simultaneous reuse requests create one task instead of duplicate paid requests', async (t) => {
  let metadata = 0, paid = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const llm = simulatedModel(); const original = llm.transport!;
  llm.transport = async (url, init) => {
    if (String(url).endsWith('/models')) { metadata++; if (metadata === 2) release(); await gate; }
    else paid++;
    return original(url, init);
  };
  const application = await app(t, llm);
  const [a, b] = await Promise.all([application.post(startInput), application.post(startInput)]);
  assert.equal((await a.json()).id, (await b.json()).id);
  await finished(application); assert.equal(paid, 1);
});

test('ledger protects report structure, complete coverage and source/account isolation', async (t) => {
  const application = await app(t); await application.post(startInput); const task = await finished(application);
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' }); t.after(() => ledger.close());
  ledger.saveAnalysis(task); assert.equal(ledger.analysis(task.id)?.status, 'complete');
  const wrong = new ReviewLedger(':memory:', { source: 'demo', accountId: 'other' }); t.after(() => wrong.close());
  assert.equal(wrong.analysis(task.id), null); assert.throws(() => wrong.saveAnalysis(task));
  const invalid = structuredClone(task); invalid.requests[0]!.report!.observations[0]!.refs = ['fabricated'];
  assert.throws(() => ledger.saveAnalysis(invalid), /引用/);
  const omitted = structuredClone(task); omitted.requests[0]!.records.pop();
  assert.throws(() => ledger.saveAnalysis(omitted), /完整|覆盖/);
});

test('open and incomplete trades freeze filtered statistics, raw order metadata and permitted notes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'analysis-evidence-')); const path = join(directory, 'demo.sqlite');
  const ids = seedReviewFilters(path);
  const ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  const trade = ledger.get(ids.open)!;
  trade.evidence.raw = [{ kind: 'history', id: trade.evidence.orders[0]!.id, time: Date.parse(trade.evidence.orders[0]!.time), payload: { symbol: trade.symbol, orderId: trade.evidence.orders[0]!.id, status: 'FILLED', clientOrderId: 'raw-order-marker', apiKey: 'never-forward-key', accountId: 'unrelated-account' } }];
  ledger.project('SOLUSDT', [trade, ledger.get(ids.pending)!]); ledger.close();
  let captured = '';
  const application = await app(t, simulatedModel(1000000, async (body) => { captured += String(body.input); return modelResponse(body); }), path, ids.open);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await application.post({ ...startInput, query: 'symbol=SOLUSDT' }); const task = await finished(application);
  assert.equal(task.status, 'complete'); assert.equal(task.snapshot.statistics.total, 2);
  assert.ok(task.snapshot.missing.some((item) => item.includes('最终表现')));
  assert.ok(captured.includes('raw-order-marker'), 'related raw order metadata is covered');
  assert.ok(!/never-forward-key|unrelated-account|simulation-only-key|demo-account/.test(captured), 'credentials and internal account identifiers are excluded');
});

test('completed segments survive a paid-request failure and are not sent again on explicit continue', async (t) => {
  let calls = 0, fail = true; const sent: string[][] = [];
  const application = await app(t, simulatedModel(12000, async (body) => {
    calls++; const input = JSON.parse(String(body.input)); sent.push(input.records.map((row: { id: string }) => row.id));
    if (calls === 2 && fail) throw new Error('temporary network failure with private details');
    return modelResponse(body);
  }));
  const original = await (await application.post(startInput)).json(); const failed = await finished(application);
  assert.equal(failed.status, 'failed'); assert.equal(calls, 2); assert.equal(failed.requests[0]!.status, 'complete');
  fail = false; await application.post({ action: 'continue', taskId: original.id }); const complete = await finished(application);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(sent[2], sent[1]); assert.equal(complete.requests[0]!.attempts.length, 1);
});

test('all archived periods include full raw candle coverage despite screen sampling', async (t) => {
  const seen = new Set<string>();
  const application = await app(t, simulatedModel(1000000, async (body) => {
    const input = JSON.parse(String(body.input));
    for (const row of input.records) seen.add(row.path);
    return modelResponse(body);
  }));
  const read = (interval: string) => fetch(`${application.base}/api/review/trades/BTCUSDT-demo-fill-1/market?interval=${interval}`, { headers: { Cookie: application.cookie } });
  const small = await (await read('1m')).json(); assert.ok(small.series.contract.sampled);
  await read('1h');
  await application.post(startInput); const task = await finished(application);
  assert.equal(task.status, 'complete'); assert.equal(task.snapshot.markets.length, 2);
  const minute = task.snapshot.markets.find((row) => row.interval === '1m')!;
  assert.ok(minute.series.contract.candles.length > 301);
  const index = task.snapshot.markets.indexOf(minute);
  assert.ok(seen.has(`/markets/${index}/series/contract/candles/${minute.series.contract.candles.length - 1}/close`));
  assert.ok(task.snapshot.missing.includes('5m 行情未读取'));
});

test('saved-note changes during a request do not rewrite its evidence and regeneration preserves the older report', async (t) => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  const application = await app(t, simulatedModel(1000000, async (body) => {
    if (first) { first = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); }
    return modelResponse(body);
  }));
  const detail = await (await fetch(`${application.base}/api/review/trades/BTCUSDT-demo-fill-1`, { headers: { Cookie: application.cookie } })).json();
  const saveNote = (value: unknown) => fetch(`${application.base}/api/review/trades/${detail.id}/note`, { method: 'POST', headers: { Cookie: application.cookie, Origin: application.base, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const fields = { noteId: null, version: 0, basis: detail.noteBasis, entryReason: '', exitReason: '', executionProblem: '', improvement: '', freeNote: '旧内容', tagIds: [] };
  const journal = await (await saveNote(fields)).json(); const saved = journal.notes[0];
  const started = await (await application.post({ ...startInput, includeNotes: true })).json(); await gate;
  await saveNote({ ...fields, noteId: saved.id, version: saved.version, freeNote: '新内容' });
  release(); const old = await finished(application); assert.equal(old.snapshot.notes[0]!.freeNote, '旧内容'); assert.deepEqual(old.snapshot, started.snapshot);
  await application.post({ ...startInput, includeNotes: true, regenerate: true }); const next = await finished(application);
  assert.equal(next.snapshot.notes[0]!.freeNote, '新内容');
  const tasks = (await (await application.get()).json()).tasks as AnalysisTask[];
  assert.equal(tasks.length, 2); assert.ok(tasks.every((row) => row.report !== null));
});

for (const failure of [
  { name: 'invalid JSON', text: '{broken' },
  { name: 'truncated output', status: 'incomplete', usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } },
  { name: 'unsupported evidence', text: JSON.stringify({ observations: [{ text: '虚构事实', kind: 'fact', timing: 'unknown', refs: ['invented'] }], evidence: [], improvements: [], nextChecks: [] }) },
]) test(`${failure.name} remains incomplete and exposes only returned usage`, async (t) => {
  const application = await app(t, simulatedModel(1000000, async (body) => modelResponse(body, failure)));
  await application.post(startInput);
  const task = await finished(application);
  assert.equal(task.status, 'failed'); assert.equal(task.report, null);
  assert.deepEqual(task.requests[0]!.usage, failure.usage ? { inputTokens: 7, outputTokens: 3, totalTokens: 10 } : null);
});

test('saved notes are optional, user evidence cannot masquerade as facts, and original raw data is allowlisted', async (t) => {
  const application = await app(t, simulatedModel(1000000, async (body) => {
    const input = JSON.parse(String(body.input));
    const note = input.records.find((row: { path: string }) => row.path.endsWith('/freeNote'));
    if (note) return modelResponse(body, { text: JSON.stringify({ observations: [{ text: '把用户笔记当事实', kind: 'fact', timing: 'unknown', refs: [note.id] }], evidence: [], improvements: [], nextChecks: [] }) });
    return modelResponse(body);
  }));
  const trade = await (await fetch(`${application.base}/api/review/trades/BTCUSDT-demo-fill-1`, { headers: { Cookie: application.cookie } })).json();
  const note = await fetch(`${application.base}/api/review/trades/${trade.id}/note`, { method: 'POST', headers: { Cookie: application.cookie, Origin: application.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId: null, version: 0, basis: trade.noteBasis, entryReason: '', exitReason: '', executionProblem: '', improvement: '', freeNote: '用户允许的已保存内容', tagIds: [] }) });
  assert.equal(note.status, 200);
  await application.post(startInput); const first = await finished(application);
  assert.equal(first.status, 'complete'); assert.equal(first.snapshot.notes.length, 0);
  await application.post({ ...startInput, includeNotes: true }); const second = await finished(application);
  assert.equal(second.status, 'failed'); assert.equal(second.snapshot.notes[0]!.freeNote, '用户允许的已保存内容');
});

test('server interruption is durable and never automatically restarts a paid request', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'analysis-stop-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const llm = simulatedModel(1000000, async (_body, signal) => { calls++; return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); });
  const path = join(directory, 'demo.sqlite');
  const application = await app(t, llm, path);
  const task = await (await application.post(startInput)).json(); assert.equal(task.status, 'running');
  await new Promise<void>((resolve) => { application.server.closeAllConnections(); application.server.close(() => resolve()); });
  const restarted = await app(t, llm, path);
  const tasks = (await (await restarted.get()).json()).tasks;
  assert.equal(tasks[0].status, 'interrupted'); assert.equal(calls, 1);
});

test('oversized context covers every evidence record and synthesizes only completed segments', async (t) => {
  const seen = new Set<string>(); let calls = 0;
  const application = await app(t, simulatedModel(12000, async (body) => {
    assert.deepEqual(body.reasoning, { effort: 'high' });
    const input = JSON.parse(String(body.input));
    for (const row of input.records) seen.add(row.id);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) + Number(body.max_output_tokens) < 12000);
    calls++; return modelResponse(body, { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
  }));
  assert.equal((await application.post(startInput)).status, 202);
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.ok(calls > 1);
  assert.ok(task.requests.some((request) => request.stage === 'synthesis'));
  for (const row of task.records) assert.ok(seen.has(row.id), row.path);
  assert.ok(task.requests.every((request) => request.status === 'complete' && request.usage?.totalTokens === 10));
});

test('cancelled tasks keep frozen evidence, continue explicitly and reuse a persisted report', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'analysis-http-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let waiting = true, calls = 0;
  const llm = simulatedModel(1000000, async (body, signal) => {
    calls++;
    if (waiting) await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return modelResponse(body);
  });
  const application = await app(t, llm, join(directory, 'demo.sqlite'));
  const first = await (await application.post(startInput)).json() as AnalysisTask;
  assert.equal((await application.post({ action: 'cancel', taskId: first.id })).status, 200);
  const cancelled = await finished(application); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.report, null);
  waiting = false;
  assert.equal((await application.post({ action: 'continue', taskId: first.id })).status, 202);
  const complete = await finished(application); assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.snapshot, first.snapshot);
  assert.equal(complete.requests[0]!.attempts[0]!.usage, null);
  const reused = await (await application.post(startInput)).json(); assert.equal(reused.id, first.id); assert.equal(calls, 2);
  await new Promise<void>((resolve) => { application.server.closeAllConnections(); application.server.close(() => resolve()); });
  const restarted = await app(t, llm, join(directory, 'demo.sqlite'));
  assert.equal((await (await restarted.get()).json()).tasks[0].status, 'complete');
  assert.equal(calls, 2);
});

test('single trade analysis starts only explicitly and retains its report', async (t) => {
  const server = createServer({ password: 'analysis-test-only', mode: 'demo', llm: {
    provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', apiKey: 'test-only',
    transport: async (url, init) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro', context_window: 1000000, max_output_tokens: 393216 }] }));
      const body = JSON.parse(String(init?.body));
      const input = JSON.parse(body.input);
      const ref = input.records[0].id;
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ observations: [{ text: '已有交易证据，动机无法判断。', kind: 'inference', timing: 'unknown', refs: [ref] }], evidence: [], improvements: [], nextChecks: [] }) }] }] }));
    },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=analysis-test-only' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const path = '/api/review/trades/BTCUSDT-demo-fill-1/analysis';
  assert.equal((await fetch(`${base}${path}`)).status, 401);
  const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tasks, []);
  const started = await fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ includeNotes: false, regenerate: false, query: '' }) });
  assert.equal(started.status, 202);
  const task = await started.json() as AnalysisTask;
  assert.equal(task.snapshot.trade.id, 'BTCUSDT-demo-fill-1');
  assert.equal(task.snapshot.notes.length, 0);
  assert.ok(task.snapshot.missing.some((item) => item.includes('行情')));
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).json();
    if (state.tasks[0]?.status === 'complete') {
      assert.ok(state.tasks[0].report.observations.length);
      assert.equal(state.tasks[0].requests[0].usage, null);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('analysis did not complete');
});
