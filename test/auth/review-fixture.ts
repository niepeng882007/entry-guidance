import type { PrismaClient } from '../../src/generated/prisma/client.ts';
import { PostgresReviewLedger } from '../../src/postgres-review-ledger.ts';
import type { ReviewTrade } from '../../src/review-ledger.ts';

export function reviewCycle(
  accountId: string,
  id = 'cycle-00',
  openedAt = '2026-10-14T00:00:00.000Z',
): ReviewTrade {
  const closedAt = new Date(Date.parse(openedAt) + 60000).toISOString();
  const bob = accountId === '10002';
  const fills: ReviewTrade['evidence']['fills'] = [
    {
      id: `${id}-entry`,
      orderId: `${id}-buy`,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'BOTH',
      quantity: '1',
      price: '100',
      time: openedAt,
      realizedPnl: '0',
      commission: '0.1',
      commissionAsset: 'USDT',
      event: 'entry',
    },
    {
      id: `${id}-exit`,
      orderId: `${id}-sell`,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'BOTH',
      quantity: '1',
      price: bob ? '130' : '110',
      time: closedAt,
      realizedPnl: bob ? '30' : '10',
      commission: '0.1',
      commissionAsset: 'USDT',
      event: 'exit',
    },
  ];
  return {
    source: 'demo',
    accountId,
    id,
    groupingVersion: 2,
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    side: 'long',
    status: 'closed',
    openedAt,
    closedAt,
    realizedPnl: bob ? '30' : '10',
    commission: '0.2',
    fundingNet: '0',
    netPnl: bob ? '29.8' : '9.8',
    missing: [],
    observedAt: closedAt,
    unrealizedPnl: null,
    unrealizedAt: null,
    evidence: {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      startPosition: '0',
      endPosition: '0',
      fillsComplete: true,
      fundingComplete: true,
      fills,
      orders: fills.map((fill) => ({
        id: fill.orderId,
        symbol: fill.symbol,
        side: fill.side,
        type: 'MARKET',
        quantity: fill.quantity,
        time: fill.time,
      })),
      funding: [],
      raw: [
        {
          kind: 'trades',
          id: `${id}-entry`,
          time: Date.parse(openedAt),
          payload: { symbol: 'BTCUSDT', id: `${id}-entry`, qty: '1', price: '100' },
        },
      ],
    },
  };
}
export function reviewCycles(accountId: string): ReviewTrade[] {
  const rows = Array.from({ length: accountId === '10001' ? 23 : 2 }, (_, index) =>
    reviewCycle(
      accountId,
      `cycle-${String(index).padStart(2, '0')}`,
      new Date(Date.UTC(2026, 9, 14, 0, index)).toISOString(),
    ),
  );
  if (accountId !== '10001') return rows;
  const cost = reviewCycle(accountId, 'missing-cost');
  cost.status = 'incomplete';
  cost.commission = null;
  cost.netPnl = null;
  cost.missing = ['手续费缺失或非 USDT，缺少可靠换算'];
  cost.evidence.fills[1]!.commission = null;
  const start = reviewCycle(accountId, 'missing-start');
  start.status = 'incomplete';
  start.openedAt = null;
  start.side = null;
  start.netPnl = null;
  start.fundingNet = null;
  start.missing = ['开仓起点待确认', '成交区间未确认完整', '资金费区间未确认完整'];
  start.evidence.startPosition = null;
  start.evidence.fillsComplete = false;
  start.evidence.fundingComplete = false;
  return [...rows, cost, start];
}

export async function seedReview(database: PrismaClient) {
  const bindings = await database.binanceBinding.findMany({
    where: {
      userId: { in: ['synthetic-alice', 'synthetic-bob'] },
      state: 'active',
    },
  });
  for (const binding of bindings) {
    const ledger = new PostgresReviewLedger(database, {
      userId: binding.userId,
      bindingId: binding.id,
      source: 'demo',
      accountId: binding.uid,
    });
    await ledger.store(reviewCycles(binding.uid));
  }
  return bindings.length;
}
