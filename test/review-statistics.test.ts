import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewLedger, demoTrade } from '../src/review-ledger.ts';
import { defaultReviewFilters } from '../src/review-filters.ts';
import { reviewStatistics } from '../src/review-statistics.ts';

function sample() {
  const ledger = new ReviewLedger(':memory:', { source: 'demo', accountId: 'demo-account' });
  ledger.archive(demoTrade());
  const trade = ledger.list()[0]!;
  ledger.close();
  return trade;
}
const identity = { source: 'demo' as const, accountId: 'demo-account' };
function statistics(trades = [sample()]) {
  return reviewStatistics(identity, defaultReviewFilters(), trades, []);
}

test('all winners use net results and report no loss denominator', () => {
  const result = statistics();
  assert.equal(result.pnl.samples, 1);
  assert.equal(result.pnl.netPnl, '12.4735');
  assert.equal(result.pnl.wins, 1);
  assert.equal(result.pnl.winRate, '100');
  assert.equal(result.pnl.averageWin, '12.4735');
  assert.equal(result.pnl.averageLoss, null);
  assert.equal(result.pnl.profitFactor, null);
  assert.equal(result.curve[0]!.cumulativeNetPnl, '12.4735');
});

test('fee gaps exclude money but preserve a reliable finished duration', () => {
  const ledger = new ReviewLedger(':memory:', identity);
  const evidence = demoTrade();
  evidence.fills[0]!.commissionAsset = 'BNB';
  ledger.archive(evidence);
  const result = statistics(ledger.list());
  ledger.close();
  assert.equal(result.pnl.samples, 0);
  assert.equal(result.pnl.netPnl, null);
  assert.equal(result.pnl.excluded.length, 1);
  assert.match(result.pnl.excluded[0]!.reasons.join(' '), /手续费/);
  assert.equal(result.duration.samples, 1);
  assert.equal(result.duration.averageMs, 43200000);
});

test('losses, flats, mixed results and an empty range have explicit denominators', () => {
  const base = sample();
  const result = statistics([{ ...base, id: 'loss', netPnl: '-3' }, { ...base, id: 'flat', netPnl: '0' }]);
  assert.equal(result.pnl.wins, 0);
  assert.equal(result.pnl.losses, 1);
  assert.equal(result.pnl.flats, 1);
  assert.equal(result.pnl.winRate, '0');
  assert.equal(result.pnl.averageLoss, '-3');
  assert.equal(result.pnl.profitFactor, '0');
  const mixed = statistics([{ ...base, id: 'win', netPnl: '10' }, { ...base, id: 'loss', netPnl: '-4' }, { ...base, id: 'flat', netPnl: '0' }]);
  assert.equal(mixed.pnl.winRate, '33.33333333');
  assert.equal(mixed.pnl.netPnl, '6');
  assert.equal(mixed.pnl.profitFactor, '2.5');
  const flat = statistics([{ ...base, netPnl: '0' }]);
  assert.equal(flat.pnl.flats, 1);
  assert.equal(flat.pnl.profitFactor, null);
  const empty = statistics([]);
  assert.equal(empty.pnl.samples, 0);
  assert.equal(empty.pnl.winRate, null);
  assert.equal(empty.pnl.netPnl, null);
  assert.equal(empty.duration.averageMs, null);
  assert.deepEqual(empty.curve, []);
});

test('money stays exact beyond safe integers and tiny signed results still count', () => {
  const base = sample();
  const result = statistics([{ ...base, id: 'huge', netPnl: '9007199254740993.12345678' }, { ...base, id: 'tiny-win', netPnl: '0.00000001' }, { ...base, id: 'tiny-loss', netPnl: '-0.00000001' }]);
  assert.equal(result.pnl.netPnl, '9007199254740993.12345678');
  assert.equal(result.pnl.wins, 2);
  assert.equal(result.pnl.losses, 1);
  assert.equal(result.pnl.averageWin, '4503599627370496.56172839');
});

test('unreliable fills and funding attribution gaps never pass as complete results', () => {
  const ledger = new ReviewLedger(':memory:', identity);
  const evidence = demoTrade();
  evidence.fillsComplete = false;
  evidence.fundingComplete = false;
  ledger.archive(evidence);
  const result = statistics(ledger.list());
  ledger.close();
  assert.equal(result.pnl.samples, 0);
  assert.equal(result.duration.samples, 0);
  assert.equal(result.duration.excluded.length, 1);
  assert.match(result.pnl.excluded[0]!.reasons.join(' '), /资金费/);
  const base = sample();
  const open = statistics([{ ...base, status: 'open', closedAt: null, durationMs: null, netPnl: null }]);
  assert.match(open.pnl.excluded[0]!.reasons.join(' '), /尚未结束/);
});

test('groups overlap by confirmed tag and the frozen input and close-time curve are deterministic', () => {
  const base = sample();
  const trades = [{ ...base, id: 'b', netPnl: '-2', tagIds: ['first', 'second'] }, { ...base, id: 'a', netPnl: '5', tagIds: [] }];
  const tags = [{ id: 'second', name: '回踩', active: true }, { id: 'first', name: '顺势', active: false }];
  const result = reviewStatistics(identity, defaultReviewFilters(), trades, tags);
  assert.equal(result.groups.tags.find((group) => group.key === 'first')!.pnl.netPnl, '-2');
  assert.equal(result.groups.tags.find((group) => group.key === 'second')!.pnl.samples, 1);
  assert.equal(result.groups.tags.find((group) => group.key === 'unknown')!.pnl.netPnl, '5');
  assert.equal(result.groups.entryTypes.find((group) => group.key === 'LIMIT')!.pnl.samples, 2);
  assert.equal(result.groups.sides.find((group) => group.key === 'long')!.total, 2);
  assert.deepEqual(result.curve.map((point) => [point.tradeId, point.cumulativeNetPnl]), [['a', '5'], ['b', '3']]);
  assert.deepEqual(result, reviewStatistics(identity, defaultReviewFilters(), [...trades].reverse(), [...tags].reverse()));
  trades[0]!.tagIds.push('later');
  assert.deepEqual(result.trades.find((trade) => trade.id === 'b')!.tagIds, ['first', 'second']);
});
