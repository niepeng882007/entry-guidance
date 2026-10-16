import type { PrismaClient, Prisma } from './generated/prisma/client.ts';
import type { ReviewIdentity, ReviewSummary, ReviewTrade } from './review-ledger.ts';
import {
  defaultReviewFilters,
  matchesReview,
  sortReview,
  type ReviewFilters,
} from './review-filters.ts';
import { reviewSummary, type ReviewReader } from './review-reader.ts';
import { validateReviewTrade } from './review-backup.ts';
import { BindingError } from './bindings/binding.ts';

type Scope = ReviewIdentity & { userId: string; bindingId: string };
export class PostgresReviewLedger implements ReviewReader {
  private database: PrismaClient;
  private scope: Scope;
  constructor(database: PrismaClient, scope: Scope) {
    this.database = database;
    this.scope = scope;
  }
  private where() {
    const { userId, bindingId, source, accountId } = this.scope;
    return { bindingId, source, binding: { userId, uid: accountId, source: 'binance-live' } };
  }
  async list(filters: ReviewFilters = defaultReviewFilters()): Promise<ReviewSummary[]> {
    const rows = await this.database.reviewCycle.findMany({
      where: this.where(),
      select: { summary: true },
    });
    return rows
      .map((row) => row.summary as unknown as ReviewSummary)
      .filter((row) => matchesReview(row, filters))
      .sort(sortReview);
  }
  async get(id: string): Promise<ReviewTrade | null> {
    const row = await this.database.reviewCycle.findFirst({
      where: { ...this.where(), id },
      select: { payload: true },
    });
    if (!row) return null;
    validateReviewTrade(row.payload, this.scope);
    return row.payload;
  }
  // Internal ingestion only: no browser write endpoint. Keep IDs and money exactly as supplied.
  async store(trades: ReviewTrade[]): Promise<void> {
    for (const trade of trades) validateReviewTrade(trade, this.scope);
    await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM auth_user WHERE id = ${this.scope.userId} FOR UPDATE`;
      const binding = await tx.binanceBinding.findFirst({
        where: {
          id: this.scope.bindingId,
          userId: this.scope.userId,
          uid: this.scope.accountId,
          source: 'binance-live',
          state: 'active',
          user: { disabled: false },
        },
      });
      if (!binding) throw new BindingError(404, '未找到可写入的账户归属。');
      for (const trade of trades) {
        const data = {
          summary: JSON.parse(JSON.stringify(reviewSummary(trade))) as Prisma.InputJsonObject,
          payload: JSON.parse(JSON.stringify(trade)) as Prisma.InputJsonObject,
        };
        const key = { bindingId: binding.id, source: this.scope.source, id: trade.id };
        await tx.reviewCycle.upsert({
          where: { bindingId_source_id: key },
          create: { ...key, ...data },
          update: data,
        });
      }
    });
  }
}
