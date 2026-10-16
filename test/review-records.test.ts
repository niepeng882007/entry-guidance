import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dateRangeError,
  readReviewLocation,
  reviewUrl,
  reviewTime,
} from '../frontend/review-records.ts';

void test('opening dates and details use Beijing dates even when the host uses another timezone', () => {
  assert.ok(reviewTime('2026-10-02T16:00:00Z').startsWith('2026/10/3 00:00:00'));
  assert.equal(reviewTime(null), '待确认');
});
void test('invalid dates stay explicit; filters and page survive detail URLs', () => {
  for (const value of ['2026-02-30', 'invalid', '2026-13-01']) assert.ok(dateRangeError(value, ''));
  assert.ok(dateRangeError('2026-10-04', '2026-10-03'));
  const location = readReviewLocation(
    new URL('http://localhost/review?from=2026-10-03&to=2026-10-03'),
  );
  const detail = { ...location, tradeId: 'BTCUSDT-a', symbol: 'BTCUSDT', page: 3 };
  assert.deepEqual(readReviewLocation(new URL(reviewUrl(detail), 'http://localhost')), detail);
  assert.equal(readReviewLocation(new URL('http://localhost/review?page=NaN')).page, 1);
});
