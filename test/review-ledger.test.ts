import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewLedger, demoTrade } from '../src/review-ledger.ts';

void test('one complete trade retains its evidence and exact net PnL across restart', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-ledger-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'demo.sqlite');
  let ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  ledger.archive(demoTrade());
  assert.equal(ledger.list().length, 1);
  const id = ledger.list()[0]!.id;
  ledger.close();
  ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const trade = ledger.get(id)!;
  assert.equal(trade.status, 'closed');
  assert.equal(trade.realizedPnl, '13');
  assert.equal(trade.commission, '0.6065');
  assert.equal(trade.fundingNet, '0.08');
  assert.equal(trade.netPnl, '12.4735');
  assert.equal(trade.evidence.orders.length, 3);
  assert.equal(trade.evidence.fills.length, 4);
  assert.deepEqual(
    trade.evidence.funding.map((item) => item.amount),
    ['0.12', '-0.04'],
  );
  assert.equal(trade.groupingVersion, 1);
  assert.equal(trade.accountId, 'demo-account');
});

void test('retries deduplicate; a conflicting write rolls back all new evidence and leaves prior trades readable', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const evidence = demoTrade();
  const id = ledger.archive(evidence);
  ledger.archive(demoTrade());
  assert.equal(ledger.list().length, 1);
  const second = demoTrade();
  second.orders.forEach((order) => {
    order.id += '-second';
  });
  second.fills.forEach((fill) => {
    fill.id += '-second';
    fill.orderId += '-second';
  });
  second.funding[1]!.amount = '-0.05';
  assert.throws(() => ledger.archive(second), /冲突/);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.get(id)!.netPnl, '12.4735');
  // A successful retry with changed new evidence proves the failed write left no fragments.
  second.funding[1]!.amount = '-0.04';
  second.funding.forEach((fee) => {
    fee.id += '-second';
  });
  second.fills[0]!.price = '59999';
  ledger.archive(second);
  assert.equal(ledger.list().length, 2);
});

void test('source and account identities isolate records even in the same database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  const demo = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  const real = new ReviewLedger(path, { source: 'binance', accountId: 'demo-account' });
  const other = new ReviewLedger(path, { source: 'demo', accountId: 'other-account' });
  t.after(() => {
    demo.close();
    real.close();
    other.close();
  });
  const id = demo.archive(demoTrade());
  assert.deepEqual(real.list(), []);
  assert.equal(real.get(id), null);
  assert.deepEqual(other.list(), []);
  assert.throws(
    () => new ReviewLedger(':memory:', { source: 'binance', accountId: '' }),
    /账户身份/,
  );
});

void test('unknown costs preserve original amounts and never produce confirmed net PnL', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const evidence = demoTrade();
  evidence.fills[0]!.commissionAsset = 'BNB';
  evidence.fundingComplete = false;
  const trade = ledger.get(ledger.archive(evidence))!;
  assert.equal(trade.status, 'incomplete');
  assert.equal(trade.netPnl, null);
  assert.equal(trade.commission, null);
  assert.equal(trade.fundingNet, null);
  assert.equal(trade.realizedPnl, '13');
  assert.equal(trade.evidence.fills[0]!.commission, '0.12');
  assert.equal(trade.evidence.fills[0]!.commissionAsset, 'BNB');
  assert.equal(trade.missing.length, 2);
});

void test('a broken position chain cannot be archived as a complete trade', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const evidence = demoTrade();
  evidence.fills[3]!.quantity = '0.007';
  assert.throws(() => ledger.archive(evidence), /反手/);
  assert.deepEqual(ledger.list(), []);
});

void test('notes stay with stable evidence and changed grouping preserves an unassigned snapshot', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const id = ledger.archive(demoTrade());
  const original = ledger.get(id)!;
  const input = {
    noteId: null,
    version: 0,
    basis: original.noteBasis,
    entryReason: '原入场',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '',
    tagIds: [],
  };
  const saved = ledger.saveNote(id, input).notes[0]!;
  const enriched = structuredClone(original);
  enriched.groupingVersion = 2;
  enriched.evidence.fundingComplete = false;
  ledger.project('BTCUSDT', [enriched]);
  assert.equal(ledger.journal().notes[0]!.binding, 'current');
  const regrouped = structuredClone(enriched);
  regrouped.evidence.fills[0]!.allocation = 'open';
  regrouped.evidence.fills[0]!.quantity = '0.002';
  ledger.project('BTCUSDT', [regrouped]);
  assert.equal(ledger.journal().notes[0]!.binding, 'pending');
  assert.equal(ledger.journal().notes[0]!.trade.evidence.fills[0]!.quantity, '0.004');
  assert.throws(
    () =>
      ledger.saveNote(id, {
        ...input,
        noteId: saved.id,
        version: 1,
        basis: ledger.get(id)!.noteBasis,
      }),
    /归属/,
  );
  const current = ledger.saveNote(id, {
    ...input,
    basis: ledger.get(id)!.noteBasis,
    entryReason: '新的确认',
  });
  assert.equal(current.notes.length, 2);
  assert.equal(current.notes.find((note) => note.binding === 'current')!.entryReason, '新的确认');
  ledger.project('BTCUSDT', []);
  assert.equal(ledger.journal().notes.length, 2);
  assert.ok(ledger.journal().notes.every((note) => note.binding === 'pending'));
});

void test('personal records isolate accounts and inactive tags retain history but cannot be newly applied', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-notes-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  const owner = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  const other = new ReviewLedger(path, { source: 'demo', accountId: 'other' });
  const real = new ReviewLedger(path, { source: 'binance', accountId: 'demo-account' });
  t.after(() => {
    owner.close();
    other.close();
    real.close();
  });
  const id = owner.archive(demoTrade());
  const tag = owner.saveTag({ id: null, version: 0, name: '顺势', active: true }).tags[0]!;
  const input = {
    noteId: null,
    version: 0,
    basis: owner.get(id)!.noteBasis,
    entryReason: '',
    exitReason: '',
    executionProblem: '',
    improvement: '',
    freeNote: '个人内容',
    tagIds: [tag.id],
  };
  const note = owner.saveNote(id, input).notes[0]!;
  owner.saveTag({ id: tag.id, version: 1, name: '顺势更新', active: false });
  assert.equal(owner.saveNote(id, { ...input, noteId: note.id, version: 1 }).notes[0]!.version, 2);
  const second = owner.get(id)!;
  second.id += '-second';
  owner.project('BTCUSDT', [owner.get(id)!, second]);
  assert.throws(
    () => owner.saveNote(second.id, { ...input, basis: owner.get(second.id)!.noteBasis }),
    /停用/,
  );
  for (const ledger of [other, real]) {
    assert.deepEqual(ledger.journal().notes, []);
    assert.deepEqual(ledger.journal().tags, []);
    assert.throws(() => ledger.saveNote(id, input), /未找到/);
    assert.throws(
      () => ledger.saveTag({ id: tag.id, version: 2, name: '盗用', active: true }),
      /未找到/,
    );
  }
  assert.throws(
    () => owner.saveTag({ id: null, version: 0, name: '多行\n标签', active: true }),
    /单行/,
  );
  assert.throws(
    () => owner.saveTag({ id: null, version: 0, name: 'x'.repeat(41), active: true }),
    /单行/,
  );
  assert.throws(
    () => owner.saveTag({ id: null, version: 0, name: '顺势更新', active: true }),
    /同名/,
  );
});
