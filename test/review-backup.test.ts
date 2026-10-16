import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewLedger, demoTrade } from '../src/review-ledger.ts';
import { TradeAnalysis } from '../src/trade-analysis.ts';
import { readTradeMarket } from '../src/trade-market.ts';
import { defaultReviewFilters } from '../src/review-filters.ts';
import { simulatedModel } from './analysis-fixtures.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewTrade } from '../src/review-ledger.ts';
import type { MarketArchive } from '../src/trade-market.ts';

void test('a full backup restores exact trades and personal records, and a repeated restore adds nothing', (t) => {
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  const id = source.archive(demoTrade());
  const tag = source.saveTag({ id: null, version: 0, name: '顺势', active: true }).tags[0]!;
  source.saveNote(id, {
    noteId: null,
    version: 0,
    basis: source.get(id)!.noteBasis,
    entryReason: '原入场',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '完整笔记',
    tagIds: [tag.id],
  });
  const backup = source.backup();
  const preview = target.previewRestore(backup);
  assert.equal(preview.rejected.length, 0);
  assert.equal(preview.conflicts.length, 0);
  assert.ok(preview.added > 0);
  target.restoreBackup(backup, preview.token, []);
  assert.equal(target.get(id)!.netPnl, '12.4735');
  assert.deepEqual(target.get(id), source.get(id));
  assert.deepEqual(target.journal(), source.journal());
  const repeated = target.previewRestore(backup);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.duplicates, backup.records.length);
  target.restoreBackup(backup, repeated.token, []);
  assert.deepEqual(target.journal(), source.journal());
});

void test('two incoming notes for the same retained trade preview a personal conflict instead of creating two current notes', (t) => {
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  const id = source.archive(demoTrade());
  source.saveNote(id, {
    noteId: null,
    version: 0,
    basis: source.get(id)!.noteBasis,
    entryReason: '第一条',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '',
    tagIds: [],
  });
  const backup = source.backup(),
    duplicate = structuredClone(backup.records.find((row) => row.table === 'review_notes')!);
  duplicate.data.id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  Object.assign(duplicate.data.payload as Record<string, unknown>, {
    id: duplicate.data.id,
    entryReason: '另一条',
  });
  backup.records.push(duplicate);
  const preview = target.previewRestore(backup);
  assert.deepEqual(preview.rejected, []);
  assert.equal(preview.conflicts.filter((row) => row.table === 'review_notes').length, 1);
  target.restoreBackup(backup, preview.token, []);
  assert.equal(target.journal().notes.filter((row) => row.binding === 'current').length, 1);
  assert.equal(target.restoreVersions().length, 1);
});

void test('restore rejects confirmed trade amounts when fills, costs, order links or the position chain do not support them', (t) => {
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  source.archive(demoTrade());
  for (const mutate of [
    (trade: ReviewTrade) => {
      trade.evidence.fills = [];
      trade.evidence.orders = [];
      trade.evidence.funding = [];
    },
    (trade: ReviewTrade) => {
      trade.evidence.fills[0]!.commission = null;
    },
    (trade: ReviewTrade) => {
      trade.evidence.fills[0]!.commissionAsset = 'BNB';
    },
    (trade: ReviewTrade) => {
      trade.evidence.fills[1]!.orderId = 'unknown-order';
    },
    (trade: ReviewTrade) => {
      trade.evidence.fills[3]!.quantity = '0.005';
    },
    (trade: ReviewTrade) => {
      trade.realizedPnl = '99';
      trade.netPnl = '98.4735';
    },
  ]) {
    const backup = source.backup();
    mutate(backup.records.find((row) => row.table === 'trades')!.data.payload as ReviewTrade);
    const preview = target.previewRestore(backup);
    assert.ok(preview.rejected.length > 0);
    assert.throws(() => target.restoreBackup(backup, preview.token, []), /备份/);
    assert.deepEqual(target.list(), []);
  }
});

void test('restore rejects a complete market with absent candles, hidden gaps or prices inconsistent with its range', async (t) => {
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  const id = source.archive(demoTrade());
  await readTradeMarket({}, source, source.get(id)!, '15m', new AbortController().signal);
  for (const mutate of [
    (market: MarketArchive) => {
      market.series.contract.candles = [];
    },
    (market: MarketArchive) => {
      market.series.mark.candles.splice(1, 1);
    },
    (market: MarketArchive) => {
      market.series.contract.candles[0]!.low = '99999999';
    },
  ]) {
    const backup = source.backup();
    mutate(
      backup.records.find((row) => row.table === 'review_market')!.data.payload as MarketArchive,
    );
    const preview = target.previewRestore(backup);
    assert.ok(preview.rejected.length > 0);
    assert.throws(() => target.restoreBackup(backup, preview.token, []), /备份/);
    assert.deepEqual(target.backup().records, []);
  }
});

void test('a note whose snapshot does not belong to the retained trade is previewed as a conflict and kept only as a readable old version', (t) => {
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  const id = source.archive(demoTrade());
  target.archive(demoTrade());
  source.saveNote(id, {
    noteId: null,
    version: 0,
    basis: source.get(id)!.noteBasis,
    entryReason: '旧归属',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '',
    tagIds: [],
  });
  const current = target.get(id)!;
  current.evidence.fills[0]!.price = '10000';
  target.project('BTCUSDT', [current]);
  const backup = source.backup(),
    preview = target.previewRestore(backup);
  const noteConflict = preview.conflicts.find((row) => row.table === 'review_notes');
  assert.ok(noteConflict && !noteConflict.overwritable);
  target.restoreBackup(backup, preview.token, []);
  assert.deepEqual(target.journal().notes, []);
  assert.equal(target.restoreVersions().length, 1);
});

void test('account-level income with an empty symbol and archive discovery state survive backup restoration', (t) => {
  const source = new ReviewLedger(':memory:', { source: 'binance', accountId: '12345' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  source.saveArchive(
    {
      status: 'complete',
      startTime: 1,
      endTime: 1000,
      symbols: [],
      pendingSymbols: [],
      completedSymbols: [],
      missing: [],
      scopeMissing: ['未发现历史合约仍未知'],
      lastSuccessAt: '2026-10-14T00:00:00.000Z',
      discovery: {
        symbol: '*',
        startTime: 1,
        endTime: 1000,
        status: 'complete',
        pages: 1,
        records: 1,
        pending: [],
        completed: [{ source: 'income', startTime: 1, endTime: 1000, page: 1 }],
        missing: [],
        lastSuccessAt: '2026-10-14T00:00:00.000Z',
      },
    },
    [
      {
        kind: 'income',
        id: 'TRANSFER-1',
        time: 500,
        payload: {
          symbol: '',
          incomeType: 'TRANSFER',
          income: '1',
          asset: 'USDT',
          tranId: 1,
          time: 500,
        },
      },
    ],
  );
  const backup = source.backup(),
    preview = target.previewRestore(backup);
  assert.deepEqual(preview.rejected, []);
  target.restoreBackup(backup, preview.token, []);
  assert.deepEqual(target.raw(''), source.raw(''));
  assert.equal(target.archiveState()!.status, 'interrupted');
  assert.equal(target.archiveState()!.discovery.completed.length, 0);
});

void test('same-name tags and notes with a different identity remain viewable history instead of replacing current personal records', (t) => {
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  t.after(() => {
    source.close();
    target.close();
  });
  const id = source.archive(demoTrade());
  target.archive(demoTrade());
  const input = {
    noteId: null,
    version: 0,
    basis: source.get(id)!.noteBasis,
    entryReason: '备份',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '',
    tagIds: [] as string[],
  };
  const tag = source.saveTag({ id: null, version: 0, name: '同名', active: true }).tags[0]!;
  source.saveNote(id, { ...input, tagIds: [tag.id] });
  target.saveTag({ id: null, version: 0, name: '同名', active: true });
  target.saveNote(id, { ...input, entryReason: '当前' });
  const backup = source.backup(),
    preview = target.previewRestore(backup);
  assert.equal(preview.conflicts.length, 2);
  assert.ok(preview.conflicts.every((row) => !row.overwritable));
  target.restoreBackup(backup, preview.token, []);
  assert.equal(target.journal().notes.length, 1);
  assert.equal(target.journal().notes[0]!.entryReason, '当前');
  assert.equal(target.tags().length, 1);
  assert.equal(target.restoreVersions().length, 2);
  const retained = target.backup(),
    empty = new ReviewLedger(':memory:', target.scope());
  t.after(() => empty.close());
  const retainedPreview = empty.previewRestore(retained);
  assert.deepEqual(retainedPreview.rejected, []);
  empty.restoreBackup(retained, retainedPreview.token, []);
  assert.deepEqual(empty.restoreVersions(), target.restoreVersions());
});

void test('backup retains every market snapshot and report segment, while imported sync and running analysis remain unconfirmed', async (t) => {
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const target = new ReviewLedger(':memory:', source.scope());
  const analysis = new TradeAnalysis(source, simulatedModel(12000));
  t.after(async () => {
    await analysis.stop();
    source.close();
    target.close();
  });
  const id = source.archive(demoTrade()),
    trade = source.get(id)!;
  const market = await readTradeMarket({}, source, trade, '15m', new AbortController().signal);
  source.saveMarket(market);
  source.saveMarket({
    ...market,
    snapshotId: 'a'.repeat(64),
    queriedAt: '2026-10-14T00:00:00.000Z',
  });
  const page = { source: 'trades' as const, startTime: 1, endTime: 1000, page: 1 };
  source.saveSync(
    {
      symbol: 'BTCUSDT',
      startTime: 1,
      endTime: 1000,
      status: 'complete',
      pages: 1,
      records: 1,
      pending: [],
      completed: [page],
      missing: [],
      lastSuccessAt: '2026-10-14T00:00:00.000Z',
    },
    [{ kind: 'trades', id: 'retained-raw', time: 500, payload: { symbol: 'BTCUSDT' } }],
  );
  const started = await analysis.start(trade, defaultReviewFilters(), false, false, () => true);
  for (
    let attempt = 0;
    attempt < 200 && source.analysis(started.id)?.status === 'running';
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const complete = source.analysis(started.id)!;
  assert.equal(complete.status, 'complete');
  const running = structuredClone(complete);
  running.id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  running.status = 'running';
  running.report = null;
  const request = running.requests.at(-1)!;
  request.status = 'running';
  request.report = null;
  request.usage = null;
  request.attempts.push({ status: 'running', usage: null });
  source.saveAnalysis(running);
  const backup = source.backup(),
    preview = target.previewRestore(backup);
  assert.deepEqual(preview.rejected, []);
  target.restoreBackup(backup, preview.token, []);
  assert.equal(target.backup().records.filter((row) => row.table === 'review_market').length, 2);
  assert.deepEqual(target.analysis(complete.id), complete);
  assert.equal(target.analysis(running.id)!.status, 'interrupted');
  assert.equal(target.analysis(running.id)!.report, null);
  assert.equal(
    target.analysis(running.id)!.requests.at(-1)!.attempts.at(-1)!.status,
    'interrupted',
  );
  assert.deepEqual(target.raw('BTCUSDT'), source.raw('BTCUSDT'));
  assert.equal(target.sync()!.status, 'interrupted');
  assert.equal(target.sync()!.completed.length, 0);
  assert.ok(target.sync()!.pending.length > 0);
  assert.ok(target.sync()!.missing.length > 0);
  assert.equal(target.previewRestore(backup).conflicts.length, 0);
});

void test('a storage write failure rolls back earlier restored records and preserves existing evidence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'restore-failure-'));
  const source = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  const path = join(directory, 'demo.sqlite');
  const target = new ReviewLedger(path, source.scope());
  t.after(() => {
    source.close();
    target.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = source.archive(demoTrade());
  source.saveNote(id, {
    noteId: null,
    version: 0,
    basis: source.get(id)!.noteBasis,
    entryReason: '',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '新笔记',
    tagIds: [],
  });
  // Inject a failure at the SQLite boundary, then observe the result only through public readers.
  const storage = new DatabaseSync(path);
  storage.exec(
    "CREATE TRIGGER restore_test_failure BEFORE INSERT ON review_notes BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
  );
  storage.close();
  const before = target.backup().records,
    backup = source.backup();
  assert.throws(
    () => target.restoreBackup(backup, target.previewRestore(backup).token, []),
    /simulated write failure/,
  );
  assert.deepEqual(target.backup().records, before);
  assert.deepEqual(target.list(), []);
});

void test('personal conflicts retain the current note, keep the backup as a readable old version, and overwrite only by explicit selection', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const id = ledger.archive(demoTrade());
  const input = {
    noteId: null,
    version: 0,
    basis: ledger.get(id)!.noteBasis,
    entryReason: '备份入场',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '',
    tagIds: [],
  };
  const saved = ledger.saveNote(id, input).notes[0]!;
  const backup = ledger.backup();
  ledger.saveNote(id, {
    ...input,
    noteId: saved.id,
    version: saved.version,
    entryReason: '当前入场',
  });
  const preview = ledger.previewRestore(backup);
  assert.equal(preview.conflicts.length, 1);
  ledger.restoreBackup(backup, preview.token, []);
  assert.equal(ledger.journal().notes[0]!.entryReason, '当前入场');
  const versions = ledger.restoreVersions();
  assert.equal(versions.length, 1);
  assert.equal((versions[0]!.value as { entryReason: string }).entryReason, '备份入场');
  ledger.restoreBackup(backup, ledger.previewRestore(backup).token, []);
  assert.deepEqual(ledger.restoreVersions(), versions);
  const next = ledger.previewRestore(backup);
  ledger.restoreBackup(backup, next.token, [next.conflicts[0]!.key]);
  assert.equal(ledger.journal().notes[0]!.entryReason, '备份入场');
  assert.ok(ledger.journal().notes[0]!.version > saved.version + 1);
  assert.equal(ledger.restoreVersions().length, 2);
  const stale = ledger.previewRestore(backup);
  ledger.saveTag({ id: null, version: 0, name: '预览后新增', active: true });
  assert.throws(() => ledger.restoreBackup(backup, stale.token, []), /重新预览/);
});

void test('invalid versions, mixed identities and malformed records reject the whole restore without changing the ledger', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  ledger.archive(demoTrade());
  const before = ledger.backup().records;
  for (const mutate of [
    (value: Record<string, unknown>) => {
      value.version = 999;
    },
    (value: Record<string, unknown>) => {
      value.accountId = 'other';
    },
    (value: Record<string, unknown>) => {
      value.source = 'binance';
    },
    (value: Record<string, unknown>) => {
      value.records = [
        ...ledger.backup().records,
        { table: 'configuration', data: { payload: {} } },
      ];
    },
    (value: Record<string, unknown>) => {
      const rows = value.records as { table: string; data: { payload: { accountId?: string } } }[];
      rows.find((row) => row.table === 'trades')!.data.payload.accountId = 'other';
    },
  ]) {
    const value = structuredClone(ledger.backup()) as unknown as Record<string, unknown>;
    mutate(value);
    const preview = ledger.previewRestore(value);
    assert.ok(preview.rejected.length > 0);
    assert.throws(() => ledger.restoreBackup(value, preview.token, []), /备份|账户|格式|版本/);
    assert.deepEqual(ledger.backup().records, before);
  }
});
