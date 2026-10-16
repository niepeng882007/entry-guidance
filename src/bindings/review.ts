import type { PrismaClient } from '../generated/prisma/client.ts';
import type { Delegation } from '../identity/delegation.ts';
import type { ReviewReader } from '../review-reader.ts';
import { PostgresReviewLedger } from '../postgres-review-ledger.ts';
import {
  parseReviewQuery,
  reviewPageSize,
  ReviewFilterError,
  matchesReview,
} from '../review-filters.ts';
import { bindingMetadata, BindingError, requireBusinessIdentity } from './binding.ts';

export async function readBoundReview(
  database: PrismaClient,
  claims: Delegation,
  bindingId: string,
  tradeId: string | undefined,
  query: URLSearchParams,
  simulation = false,
) {
  const binding = await database.binanceBinding.findFirst({
    where: { id: bindingId, userId: claims.sub, state: 'active', source: 'binance-live' },
    select: bindingMetadata,
  });
  if (!binding) throw new BindingError(404, '未找到此账户记录。');
  const source = simulation ? ('demo' as const) : ('binance' as const);
  const ledger: ReviewReader = new PostgresReviewLedger(database, {
    userId: claims.sub,
    bindingId,
    source,
    accountId: binding.uid,
  });
  let result;
  if (tradeId) {
    if (query.size) throw new ReviewFilterError('交易详情参数无效。');
    const trade = await ledger.get(tradeId);
    if (!trade) throw new BindingError(404, '未找到此交易记录。');
    result = { trade };
  } else {
    const { filters, page } = parseReviewQuery(query);
    const all = await ledger.list();
    const matching = all.filter((row) => matchesReview(row, filters));
    result = {
      trades: matching.slice((page - 1) * reviewPageSize, page * reviewPageSize),
      total: matching.length,
      page,
      pageSize: reviewPageSize,
      nextPage: page * reviewPageSize < matching.length ? page + 1 : null,
      filters,
      options: { symbols: [...new Set(all.map((row) => row.symbol))].sort() },
    };
  }
  await requireBusinessIdentity(database, claims);
  const current = await database.binanceBinding.findFirst({
    where: {
      id: binding.id,
      userId: claims.sub,
      state: 'active',
      authorizationVersion: binding.authorizationVersion,
      credentialVersion: binding.credentialVersion,
    },
    select: { id: true },
  });
  if (!current) throw new BindingError(401, '账户连接已变化，请重新登录。');
  return {
    ...result,
    userId: claims.sub,
    binding,
    source,
    readAt: new Date().toISOString(),
    coverage: '仅展示本账户已归档记录；未读取或未发现的历史范围仍待确认。',
  };
}
