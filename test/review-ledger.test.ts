import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewLedger, demoTrade } from '../src/review-ledger.ts';

test('one complete trade retains its evidence and exact net PnL across restart', (t) => {
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
  assert.deepEqual(trade.evidence.funding.map((item) => item.amount), ['0.12', '-0.04']);
  assert.equal(trade.groupingVersion, 1);
  assert.equal(trade.accountId, 'demo-account');
});

test('retries deduplicate; a conflicting write rolls back all new evidence and leaves prior trades readable', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const evidence = demoTrade();
  const id = ledger.archive(evidence);
  ledger.archive(demoTrade());
  assert.equal(ledger.list().length, 1);
  const second = demoTrade();
  second.orders.forEach((order) => { order.id += '-second'; });
  second.fills.forEach((fill) => { fill.id += '-second'; fill.orderId += '-second'; });
  second.funding[1]!.amount = '-0.05';
  assert.throws(() => ledger.archive(second), /冲突/);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.get(id)!.netPnl, '12.4735');
  // A successful retry with changed new evidence proves the failed write left no fragments.
  second.funding[1]!.amount = '-0.04';
  second.funding.forEach((fee) => { fee.id += '-second'; });
  second.fills[0]!.price = '59999';
  ledger.archive(second);
  assert.equal(ledger.list().length, 2);
});

test('source and account identities isolate records even in the same database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  const demo = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  const real = new ReviewLedger(path, { source: 'binance', accountId: 'demo-account' });
  const other = new ReviewLedger(path, { source: 'demo', accountId: 'other-account' });
  t.after(() => { demo.close(); real.close(); other.close(); });
  const id = demo.archive(demoTrade());
  assert.deepEqual(real.list(), []);
  assert.equal(real.get(id), null);
  assert.deepEqual(other.list(), []);
  assert.throws(() => new ReviewLedger(':memory:', { source: 'binance', accountId: '' }), /账户身份/);
});

test('unknown costs preserve original amounts and never produce confirmed net PnL', (t) => {
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

test('a broken position chain cannot be archived as a complete trade', (t) => {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  t.after(() => ledger.close());
  const evidence = demoTrade();
  evidence.fills[3]!.quantity = '0.007';
  assert.throws(() => ledger.archive(evidence), /反手/);
  assert.deepEqual(ledger.list(), []);
});
