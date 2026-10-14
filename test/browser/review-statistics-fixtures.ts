import { createHash } from 'node:crypto';
import type { ReviewList, ReviewSummary } from '../../src/review-ledger.ts';
import { reviewStatistics } from '../../src/review-statistics.ts';

export function withStatistics(
  list: Omit<ReviewList, 'statistics'>,
  selected: ReviewSummary[] = list.trades,
): ReviewList {
  const snapshot = reviewStatistics(
    { source: list.source, accountId: list.accountId },
    list.filters,
    selected,
    list.options.tags,
  );
  return {
    ...list,
    statistics: {
      ...snapshot,
      evidenceId: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      queriedAt: new Date().toISOString(),
    },
  };
}
