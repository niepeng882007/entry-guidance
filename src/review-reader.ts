import type { ReviewSummary, ReviewTrade } from './review-ledger.ts';
import { entryType, type ReviewFilters } from './review-filters.ts';

// New callers await this boundary; existing SQLite callers remain synchronous.
export interface ReviewReader {
  list(filters?: ReviewFilters): ReviewSummary[] | Promise<ReviewSummary[]>;
  get(id: string): ReviewTrade | null | Promise<ReviewTrade | null>;
}
export function reviewSummary(trade: ReviewTrade, tagIds: string[] = []): ReviewSummary {
  const { evidence: _evidence, planComparison: _comparison, ...summary } = trade;
  const elapsed =
    trade.openedAt && trade.closedAt
      ? Date.parse(trade.closedAt) - Date.parse(trade.openedAt)
      : null;
  const durationMs =
    trade.status !== 'open' &&
    trade.evidence.fillsComplete &&
    trade.evidence.startPosition === '0' &&
    trade.evidence.endPosition === '0' &&
    elapsed !== null &&
    Number.isSafeInteger(elapsed) &&
    elapsed >= 0
      ? elapsed
      : null;
  return {
    ...summary,
    durationMs,
    entryType: entryType(trade),
    tagIds: [...new Set(tagIds)].sort(),
  };
}
