import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewSummary } from '../src/review-ledger.ts';
import { dateRangeError, filterReviewTrades, readReviewLocation, reviewUrl, reviewTime } from '../frontend/review-records.ts';

function record(id: string, openedAt: string | null, symbol = 'BTCUSDT'): ReviewSummary {
  return {
    id, openedAt, symbol, baseAsset: symbol.slice(0, -4), source: 'demo', accountId: 'demo-account', side: 'long',
    status: 'incomplete', closedAt: null, realizedPnl: null, commission: null, fundingNet: null, netPnl: null,
    missing: ['成本待确认'], groupingVersion: 1,
  };
}
const location = readReviewLocation(new URL('http://localhost/review?from=2026-10-03&to=2026-10-03'));
test('opening-date filters include the whole Beijing day, not the UTC day or later fills', () => {
  const rows = [
    record('before', '2026-10-02T15:59:59.999Z'), record('start', '2026-10-02T16:00:00Z'),
    record('end', '2026-10-03T15:59:59.999Z'), record('after', '2026-10-03T16:00:00Z'),
    record('unknown', null), record('other', '2026-10-03T00:00:00Z', 'ETHUSDT'),
  ];
  assert.deepEqual(filterReviewTrades(rows, { ...location, symbol: 'BTCUSDT' }).map((row) => row.id), ['end', 'start']);
  assert.equal(filterReviewTrades(rows, { ...location, from: '', to: '' }).at(-1)?.id, 'unknown');
  assert.equal(filterReviewTrades(rows, { ...location, from: '', to: '' }).length, rows.length);
  assert.match(reviewTime('2026-10-02T16:00:00Z'), /2026\/10\/3 00:00:00/);
});
test('invalid ranges never silently expand to all trades; filters and page survive detail URLs', () => {
  for (const value of ['2026-02-30', 'invalid', '2026-13-01']) assert.ok(dateRangeError(value, ''));
  assert.ok(dateRangeError('2026-10-04', '2026-10-03'));
  assert.equal(filterReviewTrades([record('a', '2026-10-03T00:00:00Z')], { ...location, from: 'invalid' }).length, 0);
  const detail = { ...location, tradeId: 'BTCUSDT-a', symbol: 'BTCUSDT', page: 3 };
  assert.deepEqual(readReviewLocation(new URL(reviewUrl(detail), 'http://localhost')), detail);
  assert.equal(readReviewLocation(new URL('http://localhost/review?page=NaN')).page, 1);
});
