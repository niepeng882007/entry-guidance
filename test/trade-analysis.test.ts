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
import { request as httpRequest } from 'node:http';

async function app(
  t: TestContext,
  llm = simulatedModel(),
  reviewLedgerPath?: string,
  tradeId = 'BTCUSDT-demo-fill-1',
) {
  const server = createServer({
    password: 'analysis-test-only',
    mode: 'demo',
    llm,
    reviewLedgerPath,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=analysis-test-only',
  });
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const path =
    tradeId === '$batch' ? '/api/review/analysis' : `/api/review/trades/${tradeId}/analysis`;
  return {
    server,
    base,
    cookie,
    get: () => fetch(`${base}${path}`, { headers: { Cookie: cookie } }),
    post: (data: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
  };
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

for (const target of ['BTCUSDT-demo-fill-1', '$batch'])
  void test(`${target}: logout during a streamed continue body cannot initiate another paid request`, async (t) => {
    let calls = 0;
    const application = await app(
      t,
      simulatedModel(1000000, async (body) => {
        calls++;
        return modelResponse(body, { text: '{invalid' });
      }),
      undefined,
      target,
    );
    const task = await (await application.post(startInput)).json();
    await finished(application);
    const body = JSON.stringify({ action: 'continue', taskId: task.id });
    let complete!: (response: { status: number; body: string }) => void;
    const result = new Promise<{ status: number; body: string }>((resolve) => {
      complete = resolve;
    });
    const request = httpRequest(
      `${application.base}${target === '$batch' ? '/api/review/analysis' : '/api/review/trades/BTCUSDT-demo-fill-1/analysis'}`,
      {
        method: 'POST',
        headers: {
          Cookie: application.cookie,
          Origin: application.base,
          'Content-Type': 'application/json',
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => complete({ status: response.statusCode!, body }));
      },
    );
    request.write(body.slice(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      (
        await fetch(`${application.base}/logout`, {
          method: 'POST',
          redirect: 'manual',
          headers: { Cookie: application.cookie, Origin: application.base },
        })
      ).status,
      303,
    );
    request.end(body.slice(2));
    assert.equal((await result).status, 401);
    assert.equal(calls, 1);
  });

void test('synthesis preserves fact and user classifications while explicitly citing segment results', async (t) => {
  const application = await app(
    t,
    simulatedModel(12000, async (body) => {
      const input = JSON.parse(String(body.input));
      const fact =
        input.stage === 'evidence'
          ? input.records.find((row: { kind: string }) => row.kind === 'fact')
          : input.summaries
              .flatMap(
                (row: { report: { observations: { id: string; kind: string }[] } }) =>
                  row.report.observations,
              )
              .find((row: { kind: string }) => row.kind === 'fact');
      const user =
        input.stage === 'evidence'
          ? input.records.find((row: { path: string }) => row.path.endsWith('/freeNote'))
          : input.summaries
              .flatMap(
                (row: { report: { evidence: { id: string; kind: string }[] } }) =>
                  row.report.evidence,
              )
              .find((row: { kind: string }) => row.kind === 'user');
      return modelResponse(body, {
        text: JSON.stringify({
          observations: [
            {
              text: '事实源于当前证据或已完成分段事实。',
              kind: fact ? 'fact' : 'inference',
              timing: 'unknown',
              refs: [fact?.id ?? input.records[0].id],
            },
          ],
          evidence: user
            ? [{ text: '用户已保存自述。', kind: 'user', timing: 'unknown', refs: [user.id] }]
            : [],
          improvements: [],
          nextChecks: [],
        }),
      });
    }),
  );
  const detail = await (
    await fetch(`${application.base}/api/review/trades/BTCUSDT-demo-fill-1`, {
      headers: { Cookie: application.cookie },
    })
  ).json();
  await fetch(`${application.base}/api/review/trades/${detail.id}/note`, {
    method: 'POST',
    headers: {
      Cookie: application.cookie,
      Origin: application.base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      noteId: null,
      version: 0,
      basis: detail.noteBasis,
      entryReason: '',
      exitReason: '',
      executionProblem: '',
      improvement: '',
      freeNote: '已保存自述',
      tagIds: [],
    }),
  });
  await application.post({ ...startInput, includeNotes: true });
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.equal(task.report!.observations[0]!.kind, 'fact');
  assert.equal(task.report!.evidence[0]!.kind, 'user');
  assert.match(
    task.report!.observations[0]!.refs[0]!,
    /^(segment|synthesis)-\d+\/observations\/\d+$/,
  );
});

for (const target of ['BTCUSDT-demo-fill-1', '$batch'])
  void test(`${target}: simultaneous reuse requests create one task instead of duplicate paid requests`, async (t) => {
    let metadata = 0,
      paid = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = simulatedModel();
    const original = llm.transport!;
    llm.transport = async (url, init) => {
      if (String(url).endsWith('/models')) {
        metadata++;
        if (metadata === 2) release();
        await gate;
      } else paid++;
      return original(url, init);
    };
    const application = await app(t, llm, undefined, target);
    const [a, b] = await Promise.all([application.post(startInput), application.post(startInput)]);
    assert.equal((await a.json()).id, (await b.json()).id);
    await finished(application);
    assert.equal(paid, target === '$batch' ? 2 : 1);
  });

void test('ledger protects report structure, complete coverage and source/account isolation', async (t) => {
  const application = await app(t);
  await application.post(startInput);
  const task = await finished(application);
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  ledger.saveAnalysis(task);
  assert.equal(ledger.analysis(task.id)?.status, 'complete');
  const wrong = new ReviewLedger(':memory:', { source: 'demo', accountId: 'other' });
  t.after(() => wrong.close());
  assert.equal(wrong.analysis(task.id), null);
  assert.throws(() => wrong.saveAnalysis(task));
  const invalid = structuredClone(task);
  invalid.requests[0]!.report!.observations[0]!.refs = ['fabricated'];
  assert.throws(() => ledger.saveAnalysis(invalid), /引用/);
  const omitted = structuredClone(task);
  omitted.requests[0]!.records.pop();
  assert.throws(() => ledger.saveAnalysis(omitted), /完整|覆盖/);
});

void test('open and incomplete trades freeze filtered statistics, raw order metadata and permitted notes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'analysis-evidence-'));
  const path = join(directory, 'demo.sqlite');
  const ids = seedReviewFilters(path);
  const ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  const trade = ledger.get(ids.open)!;
  trade.evidence.raw = [
    {
      kind: 'history',
      id: trade.evidence.orders[0]!.id,
      time: Date.parse(trade.evidence.orders[0]!.time),
      payload: {
        symbol: trade.symbol,
        orderId: trade.evidence.orders[0]!.id,
        status: 'FILLED',
        clientOrderId: 'raw-order-marker',
        apiKey: 'never-forward-key',
        accountId: 'unrelated-account',
      },
    },
  ];
  ledger.project('SOLUSDT', [trade, ledger.get(ids.pending)!]);
  ledger.close();
  let captured = '';
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      captured += String(body.input);
      return modelResponse(body);
    }),
    path,
    ids.open,
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await application.post({ ...startInput, query: 'symbol=SOLUSDT' });
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.equal(task.snapshot.statistics.total, 2);
  assert.ok(task.snapshot.missing.some((item) => item.includes('最终表现')));
  assert.ok(captured.includes('raw-order-marker'), 'related raw order metadata is covered');
  assert.ok(
    !/never-forward-key|unrelated-account|simulation-only-key|demo-account/.test(captured),
    'credentials and internal account identifiers are excluded',
  );
});

void test('completed segments survive a paid-request failure and are not sent again on explicit continue', async (t) => {
  let calls = 0,
    fail = true;
  const sent: string[][] = [];
  const application = await app(
    t,
    simulatedModel(12000, async (body) => {
      calls++;
      const input = JSON.parse(String(body.input));
      sent.push(input.records.map((row: { id: string }) => row.id));
      if (calls === 2 && fail) throw new Error('temporary network failure with private details');
      return modelResponse(body);
    }),
  );
  const original = await (await application.post(startInput)).json();
  const failed = await finished(application);
  assert.equal(failed.status, 'failed');
  assert.equal(calls, 2);
  assert.equal(failed.requests[0]!.status, 'complete');
  fail = false;
  await application.post({ action: 'continue', taskId: original.id });
  const complete = await finished(application);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(sent[2], sent[1]);
  assert.equal(complete.requests[0]!.attempts.length, 1);
});

void test('all archived periods include full raw candle coverage despite screen sampling', async (t) => {
  const seen = new Set<string>();
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      const input = JSON.parse(String(body.input));
      for (const row of input.records) seen.add(row.path);
      return modelResponse(body);
    }),
  );
  const read = (interval: string) =>
    fetch(
      `${application.base}/api/review/trades/BTCUSDT-demo-fill-1/market?interval=${interval}&refresh=1`,
      { headers: { Cookie: application.cookie } },
    );
  const small = await (await read('1m')).json();
  assert.ok(small.series.contract.sampled);
  await read('1h');
  await application.post(startInput);
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.equal(task.snapshot.markets.length, 2);
  const minute = task.snapshot.markets.find((row) => row.interval === '1m')!;
  assert.ok(minute.series.contract.candles.length > 301);
  const index = task.snapshot.markets.indexOf(minute);
  assert.ok(
    seen.has(
      `/markets/${index}/series/contract/candles/${minute.series.contract.candles.length - 1}/close`,
    ),
  );
  assert.ok(task.snapshot.missing.includes('5m 行情未读取'));
});

void test('saved-note changes during a request do not rewrite its evidence and regeneration preserves the older report', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      if (first) {
        first = false;
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return modelResponse(body);
    }),
  );
  const detail = await (
    await fetch(`${application.base}/api/review/trades/BTCUSDT-demo-fill-1`, {
      headers: { Cookie: application.cookie },
    })
  ).json();
  const saveNote = (value: unknown) =>
    fetch(`${application.base}/api/review/trades/${detail.id}/note`, {
      method: 'POST',
      headers: {
        Cookie: application.cookie,
        Origin: application.base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
  const fields = {
    noteId: null,
    version: 0,
    basis: detail.noteBasis,
    entryReason: '',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '旧内容',
    tagIds: [],
  };
  const journal = await (await saveNote(fields)).json();
  const saved = journal.notes[0];
  const started = await (await application.post({ ...startInput, includeNotes: true })).json();
  await gate;
  await saveNote({ ...fields, noteId: saved.id, version: saved.version, freeNote: '新内容' });
  release();
  const old = await finished(application);
  assert.equal(old.snapshot.notes[0]!.freeNote, '旧内容');
  assert.deepEqual(old.snapshot, started.snapshot);
  await application.post({ ...startInput, includeNotes: true, regenerate: true });
  const next = await finished(application);
  assert.equal(next.snapshot.notes[0]!.freeNote, '新内容');
  const tasks = (await (await application.get()).json()).tasks as AnalysisTask[];
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((row) => row.report !== null));
});

for (const failure of [
  { name: 'invalid JSON', text: '{broken' },
  {
    name: 'truncated output',
    status: 'incomplete',
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  },
  {
    name: 'unsupported evidence',
    text: JSON.stringify({
      observations: [{ text: '虚构事实', kind: 'fact', timing: 'unknown', refs: ['invented'] }],
      evidence: [],
      improvements: [],
      nextChecks: [],
    }),
  },
])
  void test(`${failure.name} remains incomplete and exposes only returned usage`, async (t) => {
    const application = await app(
      t,
      simulatedModel(1000000, async (body) => modelResponse(body, failure)),
    );
    await application.post(startInput);
    const task = await finished(application);
    assert.equal(task.status, 'failed');
    assert.equal(task.report, null);
    assert.deepEqual(
      task.requests[0]!.usage,
      failure.usage ? { inputTokens: 7, outputTokens: 3, totalTokens: 10 } : null,
    );
  });

void test('saved notes are optional, user evidence cannot masquerade as facts, and original raw data is allowlisted', async (t) => {
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      const input = JSON.parse(String(body.input));
      const note = input.records.find((row: { path: string }) => row.path.endsWith('/freeNote'));
      if (note)
        return modelResponse(body, {
          text: JSON.stringify({
            observations: [
              { text: '把用户笔记当事实', kind: 'fact', timing: 'unknown', refs: [note.id] },
            ],
            evidence: [],
            improvements: [],
            nextChecks: [],
          }),
        });
      return modelResponse(body);
    }),
  );
  const trade = await (
    await fetch(`${application.base}/api/review/trades/BTCUSDT-demo-fill-1`, {
      headers: { Cookie: application.cookie },
    })
  ).json();
  const note = await fetch(`${application.base}/api/review/trades/${trade.id}/note`, {
    method: 'POST',
    headers: {
      Cookie: application.cookie,
      Origin: application.base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      noteId: null,
      version: 0,
      basis: trade.noteBasis,
      entryReason: '',
      exitReason: '',
      executionProblem: '',
      improvement: '',
      freeNote: '用户允许的已保存内容',
      tagIds: [],
    }),
  });
  assert.equal(note.status, 200);
  await application.post(startInput);
  const first = await finished(application);
  assert.equal(first.status, 'complete');
  assert.equal(first.snapshot.notes.length, 0);
  await application.post({ ...startInput, includeNotes: true });
  const second = await finished(application);
  assert.equal(second.status, 'failed');
  assert.equal(second.snapshot.notes[0]!.freeNote, '用户允许的已保存内容');
});

for (const target of ['BTCUSDT-demo-fill-1', '$batch'])
  void test(`${target}: server interruption is durable and never automatically restarts a paid request`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'analysis-stop-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    const llm = simulatedModel(1000000, async (_body, signal) => {
      calls++;
      return new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
      );
    });
    const path = join(directory, 'demo.sqlite');
    const application = await app(t, llm, path, target);
    const task = await (await application.post(startInput)).json();
    assert.equal(task.status, 'running');
    await new Promise<void>((resolve) => {
      application.server.closeAllConnections();
      application.server.close(() => resolve());
    });
    const restarted = await app(t, llm, path, target);
    const tasks = (await (await restarted.get()).json()).tasks;
    assert.equal(tasks[0].status, 'interrupted');
    assert.equal(calls, 1);
  });

void test('oversized context covers every evidence record and synthesizes only completed segments', async (t) => {
  const seen = new Set<string>();
  let calls = 0;
  const application = await app(
    t,
    simulatedModel(12000, async (body) => {
      assert.deepEqual(body.reasoning, { effort: 'high' });
      const input = JSON.parse(String(body.input));
      for (const row of input.records) seen.add(row.id);
      assert.ok(Buffer.byteLength(JSON.stringify(body)) + Number(body.max_output_tokens) < 12000);
      calls++;
      return modelResponse(body, {
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      });
    }),
  );
  assert.equal((await application.post(startInput)).status, 202);
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.ok(calls > 1);
  assert.ok(task.requests.some((request) => request.stage === 'synthesis'));
  for (const row of task.records) assert.ok(seen.has(row.id), row.path);
  assert.ok(
    task.requests.every(
      (request) => request.status === 'complete' && request.usage?.totalTokens === 10,
    ),
  );
});

for (const target of ['BTCUSDT-demo-fill-1', '$batch'])
  void test(`${target}: cancelled tasks keep frozen evidence, continue explicitly and reuse a persisted report`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'analysis-http-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let waiting = true,
      calls = 0;
    const llm = simulatedModel(1000000, async (body, signal) => {
      calls++;
      if (waiting)
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        );
      return modelResponse(body);
    });
    const application = await app(t, llm, join(directory, 'demo.sqlite'), target);
    const first = (await (await application.post(startInput)).json()) as AnalysisTask;
    assert.equal((await application.post({ action: 'cancel', taskId: first.id })).status, 200);
    const cancelled = await finished(application);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.report, null);
    waiting = false;
    assert.equal((await application.post({ action: 'continue', taskId: first.id })).status, 202);
    const complete = await finished(application);
    assert.equal(complete.status, 'complete');
    assert.deepEqual(complete.snapshot, first.snapshot);
    assert.equal(complete.requests[0]!.attempts[0]!.usage, null);
    const reused = await (await application.post(startInput)).json();
    assert.equal(reused.id, first.id);
    assert.equal(calls, target === '$batch' ? 3 : 2);
    await new Promise<void>((resolve) => {
      application.server.closeAllConnections();
      application.server.close(() => resolve());
    });
    const restarted = await app(t, llm, join(directory, 'demo.sqlite'), target);
    assert.equal((await (await restarted.get()).json()).tasks[0].status, 'complete');
    assert.equal(calls, target === '$batch' ? 3 : 2);
  });

void test('single trade analysis starts only explicitly and retains its report', async (t) => {
  const server = createServer({
    password: 'analysis-test-only',
    mode: 'demo',
    llm: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      effort: 'high',
      apiKey: 'test-only',
      transport: async (url, init) => {
        if (String(url).endsWith('/models'))
          return new Response(
            JSON.stringify({
              data: [{ id: 'deepseek-v4-pro', context_window: 1000000, max_output_tokens: 393216 }],
            }),
          );
        const body = JSON.parse(String(init?.body));
        const input = JSON.parse(body.input);
        const ref = input.records[0].id;
        return new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      observations: [
                        {
                          text: '已有交易证据，动机无法判断。',
                          kind: 'inference',
                          timing: 'unknown',
                          refs: [ref],
                        },
                      ],
                      evidence: [],
                      improvements: [],
                      nextChecks: [],
                    }),
                  },
                ],
              },
            ],
          }),
        );
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=analysis-test-only',
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const path = '/api/review/trades/BTCUSDT-demo-fill-1/analysis';
  assert.equal((await fetch(`${base}${path}`)).status, 401);
  const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tasks, []);
  const started = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeNotes: false, regenerate: false, query: '' }),
  });
  assert.equal(started.status, 202);
  const task = (await started.json()) as AnalysisTask;
  assert.equal(task.snapshot.trade!.id, 'BTCUSDT-demo-fill-1');
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

void test('batch freezes the full cross-page and multi-symbol range with independent valid and excluded samples', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'batch-range-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'demo.sqlite');
  const ids = seedReviewFilters(path);
  let captured = '';
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      captured += String(body.input);
      return modelResponse(body);
    }),
    path,
    '$batch',
  );
  assert.equal((await application.get()).status, 200);
  assert.equal((await application.post({ ...startInput, query: 'page=2' })).status, 202);
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.equal(task.tradeId, '$batch');
  assert.equal(task.snapshot.trades?.length, 29);
  assert.equal(task.snapshot.statistics.total, 29);
  assert.equal(task.snapshot.statistics.pnl.samples, 26);
  assert.equal(task.snapshot.statistics.pnl.excluded.length, 3);
  assert.ok(task.snapshot.trades?.some((trade) => trade.id === ids.pending));
  assert.ok(task.snapshot.trades?.some((trade) => trade.id === ids.open));
  assert.ok(captured.includes('ETHUSDT') && captured.includes('SOLUSDT'));
  assert.ok(!captured.includes('demo-account'));
  const ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  assert.equal(ledger.analysis(task.id)?.snapshot.trades?.length, 29);
  const invalid = structuredClone(task);
  invalid.snapshot.trades!.pop();
  assert.throws(() => ledger.saveAnalysis(invalid), /范围|覆盖|交易/);
  const omitted = structuredClone(task);
  omitted.records = omitted.records.filter((row) => row.tradeId !== ids.pending);
  for (const request of omitted.requests)
    request.records = request.records.filter((row) => row.tradeId !== ids.pending);
  assert.throws(() => ledger.saveAnalysis(omitted), /范围|覆盖|交易/);
});

void test('batch always finishes through an explicit synthesis citing completed results, even with one evidence segment', async (t) => {
  const application = await app(t, simulatedModel(), undefined, '$batch');
  await application.post(startInput);
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.equal(task.requests.length, 2);
  assert.equal(task.requests.at(-1)!.stage, 'synthesis');
  assert.deepEqual(task.requests.at(-1)!.segments, ['segment-1']);
  assert.match(task.report!.observations[0]!.refs[0]!, /^segment-/);
});

void test('100 selected trades are accepted but 101 (even excluded trades) and empty selections are refused before model calls', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'batch-limit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'demo.sqlite');
  const ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const id = ledger.archive((await import('../src/review-ledger.ts')).demoTrade());
  const original = ledger.get(id)!;
  const trades = Array.from({ length: 101 }, (_, index) =>
    index === 0
      ? structuredClone(original)
      : {
          ...structuredClone(original),
          id: `BTCUSDT-limit-${index}`,
          status: 'incomplete' as const,
          netPnl: null,
          missing: ['成交链缺口'],
        },
  );
  let calls = 0,
    metadata = 0;
  const llm = simulatedModel(10000000, async (body) => {
    calls++;
    return modelResponse(body);
  });
  const transport = llm.transport!;
  llm.transport = async (url, init) => {
    if (String(url).endsWith('/models')) metadata++;
    return transport(url, init);
  };
  const application = await app(t, llm, path, '$batch');
  await application.get();
  ledger.project('BTCUSDT', trades.slice(0, 100));
  assert.equal((await application.post(startInput)).status, 202);
  const task = await finished(application);
  assert.equal(task.snapshot.trades?.length, 100);
  assert.equal(task.snapshot.statistics.pnl.samples, 1);
  assert.equal(task.status, 'complete');
  ledger.project('BTCUSDT', trades);
  const over = await application.post(startInput);
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /101.*100.*缩小/);
  assert.equal((await application.post({ ...startInput, query: 'symbol=ETHUSDT' })).status, 400);
  assert.equal(calls, 2);
  assert.equal(metadata, 1);
});

void test('batch segments preserve complete trade/time coverage through failure and explicit continue', async (t) => {
  let calls = 0,
    fail = true;
  const seen = new Set<string>();
  const application = await app(
    t,
    simulatedModel(12000, async (body) => {
      calls++;
      const input = JSON.parse(String(body.input));
      if (calls === 2 && fail) throw new Error('network failed');
      for (const row of input.records) seen.add(row.id);
      return modelResponse(body);
    }),
    undefined,
    '$batch',
  );
  const started = await (await application.post(startInput)).json();
  const failed = await finished(application);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.report, null);
  assert.equal(failed.requests[0]!.status, 'complete');
  fail = false;
  await application.post({ action: 'continue', taskId: started.id });
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.equal(task.requests[0]!.attempts.length, 1);
  for (const row of task.records) assert.ok(seen.has(row.id), row.path);
  assert.ok(
    task.requests
      .filter((row) => row.stage === 'evidence')
      .some((row) =>
        row.records.some(
          (record) => record.tradeId === 'BTCUSDT-demo-fill-1' && record.time !== null,
        ),
      ),
  );
});

void test('model style suggestions are separate inferences, reference selected trades and never write personal tags', async (t) => {
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      const input = JSON.parse(String(body.input));
      const ref =
        input.stage === 'evidence'
          ? input.records.find((row: { tradeId: string }) => row.tradeId === 'BTCUSDT-demo-fill-1')
              .id
          : input.summaries[0].styleSuggestions[0].id;
      return modelResponse(body, {
        text: JSON.stringify({
          observations: [
            { text: '证据不足，风格需确认', kind: 'inference', timing: 'unknown', refs: [ref] },
          ],
          evidence: [],
          improvements: [],
          nextChecks: [],
          styleSuggestions: [{ tradeId: 'BTCUSDT-demo-fill-1', name: '顺势', refs: [ref] }],
        }),
      });
    }),
    undefined,
    '$batch',
  );
  await application.post(startInput);
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  assert.equal(task.report!.styleSuggestions?.[0]?.name, '顺势');
  const journal = await (
    await fetch(`${application.base}/api/review/journal`, {
      headers: { Cookie: application.cookie },
    })
  ).json();
  assert.deepEqual(journal.tags, []);
  assert.deepEqual(journal.notes, []);
});

void test('batch cancellation and explicit continue keep the original range, saved notes, tags and all archived market periods while evidence changes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'batch-frozen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'demo.sqlite');
  const ids = seedReviewFilters(path);
  const ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const trade = ledger.get(ids.start)!;
  const note = ledger.journal().notes.find((row) => row.trade.id === trade.id)!;
  const fields = {
    noteId: note.id,
    version: note.version,
    basis: trade.noteBasis,
    entryReason: '原始理由',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '旧笔记',
    tagIds: note.tagIds,
  };
  ledger.saveNote(trade.id, fields);
  let waiting = true,
    calls = 0;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const application = await app(
    t,
    simulatedModel(1000000, async (body, signal) => {
      calls++;
      if (waiting) {
        entered();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        );
      }
      return modelResponse(body);
    }),
    path,
    '$batch',
  );
  for (const id of ['BTCUSDT-demo-fill-1', trade.id])
    assert.equal(
      (
        await fetch(`${application.base}/api/review/trades/${id}/market?interval=1h&refresh=1`, {
          headers: { Cookie: application.cookie },
        })
      ).status,
      200,
    );
  const started = (await (
    await application.post({ ...startInput, includeNotes: true })
  ).json()) as AnalysisTask;
  await gate;
  const saved = ledger.journal().notes.find((row) => row.id === note.id)!;
  ledger.saveNote(trade.id, { ...fields, version: saved.version, freeNote: '新笔记' });
  const tag = ledger.journal().tags.find((row) => row.id === note.tagIds[0])!;
  ledger.saveTag({ id: tag.id, version: tag.version, active: tag.active, name: '改名后标签' });
  const others = ledger
    .list()
    .filter((row) => row.symbol === 'ETHUSDT')
    .map((row) => ledger.get(row.id)!);
  ledger.project('ETHUSDT', [...others, { ...structuredClone(trade), id: 'ETHUSDT-new-trade' }]);
  await fetch(`${application.base}/api/review/trades/${trade.id}/market?interval=5m&refresh=1`, {
    headers: { Cookie: application.cookie },
  });
  assert.equal(calls, 1);
  const cancelled = (await (
    await application.post({ action: 'cancel', taskId: started.id })
  ).json()) as AnalysisTask;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.snapshot, started.snapshot);
  waiting = false;
  await application.post({ action: 'continue', taskId: started.id });
  const complete = await finished(application);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.snapshot, started.snapshot);
  assert.equal(complete.snapshot.trades?.length, 29);
  assert.equal(complete.snapshot.markets.length, 2);
  assert.equal(complete.snapshot.notes.find((row) => row.tradeId === trade.id)?.freeNote, '旧笔记');
  assert.ok(!complete.snapshot.tags.some((row) => row.name === '改名后标签'));
  assert.equal(complete.requests[0]!.attempts[0]!.usage, null);
  await application.post({ ...startInput, query: 'symbol=SOLUSDT', regenerate: true });
  const next = await finished(application);
  assert.equal(next.snapshot.trades?.length, 4);
  assert.notEqual(next.id, complete.id);
  assert.equal((await (await application.get()).json()).tasks.length, 2);
});

for (const fault of ['unselected', 'unrelated', 'truncated'])
  void test(`batch rejects ${fault} model output and keeps the incomplete report and unknown usage`, async (t) => {
    const application = await app(
      t,
      simulatedModel(1000000, async (body) => {
        if (fault === 'truncated') return modelResponse(body, { status: 'incomplete' });
        const input = JSON.parse(String(body.input));
        const ref =
          fault === 'unrelated'
            ? input.records.find((row: { tradeId: string }) => row.tradeId === '$scope').id
            : input.records[0].id;
        return modelResponse(body, {
          text: JSON.stringify({
            observations: [{ text: '证据不足', kind: 'inference', timing: 'unknown', refs: [ref] }],
            evidence: [],
            improvements: [],
            nextChecks: [],
            styleSuggestions: [
              {
                tradeId: fault === 'unselected' ? 'foreign-trade' : 'BTCUSDT-demo-fill-1',
                name: '顺势',
                refs: [ref],
              },
            ],
          }),
        });
      }),
      undefined,
      '$batch',
    );
    await application.post(startInput);
    const task = await finished(application);
    assert.equal(task.status, 'failed');
    assert.equal(task.report, null);
    assert.equal(task.requests[0]!.attempts[0]!.usage, null);
  });

void test('batch HTTP protects login, origin, input filters and single-trade task boundaries without extra model calls', async (t) => {
  let calls = 0;
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      calls++;
      return modelResponse(body);
    }),
    undefined,
    '$batch',
  );
  const endpoint = `${application.base}/api/review/analysis`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          Cookie: application.cookie,
          Origin: 'http://foreign.invalid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(startInput),
      })
    ).status,
    403,
  );
  assert.equal((await application.post({ ...startInput, query: 'from=invalid' })).status, 400);
  assert.equal(
    (await application.post({ ...startInput, query: 'symbol=BTCUSDT&symbol=ETHUSDT' })).status,
    400,
  );
  assert.equal((await application.post({ ...startInput, includeNotes: 'yes' })).status, 400);
  assert.equal(calls, 0);
  const response = await application.post(startInput);
  const task = await response.json();
  await finished(application);
  const single = `${application.base}/api/review/trades/BTCUSDT-demo-fill-1/analysis`;
  assert.equal(
    (
      await fetch(single, {
        method: 'POST',
        headers: {
          Cookie: application.cookie,
          Origin: application.base,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'continue', taskId: task.id }),
      })
    ).status,
    404,
  );
  assert.equal(
    (await (await fetch(single, { headers: { Cookie: application.cookie } })).json()).tasks.length,
    0,
  );
});

void test('raw exchange tradeId stays an evidence value and cannot change a batch record cycle or sample eligibility', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'batch-raw-id-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'demo.sqlite');
  const ids = seedReviewFilters(path);
  const ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  const trade = ledger.get(ids.pending)!;
  trade.evidence.raw = [
    {
      kind: 'income',
      id: 'fee-income',
      time: Date.parse(trade.openedAt!),
      payload: {
        symbol: trade.symbol,
        tradeId: '21',
        income: '-0.01',
        incomeType: 'COMMISSION',
        asset: 'USDT',
        time: Date.parse(trade.openedAt!),
      },
    },
  ];
  ledger.project(
    'SOLUSDT',
    ledger
      .list()
      .filter((row) => row.symbol === 'SOLUSDT')
      .map((row) => (row.id === trade.id ? trade : ledger.get(row.id)!)),
  );
  ledger.close();
  const application = await app(t, simulatedModel(), path, '$batch');
  await application.post({ ...startInput, query: 'symbol=SOLUSDT' });
  const task = await finished(application);
  assert.equal(task.status, 'complete');
  const record = task.records.find((row) => row.path.endsWith('/payload/tradeId'))!;
  assert.equal(record.value, '21');
  assert.equal(record.tradeId, ids.pending);
  assert.equal(record.pnlEligible, false);
  const income = task.records.find((row) => row.path.endsWith('/payload/income'))!;
  assert.equal(income.tradeId, ids.pending);
  assert.equal(income.pnlEligible, false);
});

for (const reference of ['whole-segment', 'unanchored-item'])
  void test(`batch final conclusions reject ${reference} references that cannot identify a trade or statistics group`, async (t) => {
    const application = await app(
      t,
      simulatedModel(1000000, async (body) => {
        const input = JSON.parse(String(body.input));
        if (input.stage === 'synthesis')
          return modelResponse(body, {
            text: JSON.stringify({
              observations: [
                {
                  text: '只引用整体分段，没有具体依据',
                  kind: 'inference',
                  timing: 'unknown',
                  refs: [
                    reference === 'whole-segment'
                      ? input.summaries[0].id
                      : input.summaries[0].report.observations[0].id,
                  ],
                },
              ],
              evidence: [],
              improvements: [],
              nextChecks: [],
            }),
          });
        if (reference === 'unanchored-item')
          return modelResponse(body, {
            text: JSON.stringify({
              observations: [
                {
                  text: '只有一般缺项描述',
                  kind: 'inference',
                  timing: 'unknown',
                  refs: [
                    input.records.find((row: { path: string }) => row.path === '/missing/0').id,
                  ],
                },
              ],
              evidence: [],
              improvements: [],
              nextChecks: [],
            }),
          });
        return modelResponse(body);
      }),
      undefined,
      '$batch',
    );
    await application.post(startInput);
    const task = await finished(application);
    assert.equal(task.status, 'failed');
    assert.equal(task.report, null);
    assert.equal(task.requests[0]!.status, 'complete');
  });

void test('full backup restores completed and unfinished batch tasks without changing evidence or calling the model', async (t) => {
  let calls = 0;
  const application = await app(
    t,
    simulatedModel(1000000, async (body) => {
      calls++;
      return modelResponse(body);
    }),
    undefined,
    '$batch',
  );
  await application.post(startInput);
  const complete = await finished(application);
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  source.archive((await import('../src/review-ledger.ts')).demoTrade());
  source.saveAnalysis(complete);
  const pending = structuredClone(complete);
  pending.id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  pending.status = 'running';
  pending.report = null;
  pending.requests.at(-1)!.report = null;
  pending.requests.at(-1)!.status = 'running';
  pending.requests.at(-1)!.attempts.at(-1)!.status = 'running';
  source.saveAnalysis(pending);
  const backup = source.backup();
  const preview = target.previewRestore(backup);
  assert.deepEqual(preview.rejected, []);
  target.restoreBackup(backup, preview.token, []);
  assert.deepEqual(target.analysis(complete.id), complete);
  assert.equal(target.analysis(pending.id)?.status, 'interrupted');
  assert.equal(target.analysis(pending.id)?.report, null);
  assert.deepEqual(target.analysis(pending.id)?.snapshot, pending.snapshot);
  assert.equal(calls, 2);
  assert.equal(target.previewRestore(backup).added, 0);
});
