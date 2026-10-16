import { formatDecimal, parseDecimal } from '../public/draft.js';
import type { ReviewIdentity, ReviewSummary } from './review-ledger.ts';
import { defaultReviewFilters, entryTypeLabel, type ReviewFilters } from './review-filters.ts';
import type { StyleTag } from './review-notes.ts';

function signed(value: string): bigint {
  return (
    parseDecimal(value.startsWith('-') ? value.slice(1) : value, '复盘净盈亏') *
    (value.startsWith('-') ? -1n : 1n)
  );
}
function ratio(value: bigint, divisor: bigint): string | null {
  return divisor === 0n ? null : formatDecimal((value * 100_000_000n) / divisor);
}
type Exclusion = { tradeId: string; reasons: string[] };
function pnlMetrics(trades: ReviewSummary[]) {
  const values = trades.map((trade) => signed(trade.netPnl!));
  const positive = values.filter((value) => value > 0n),
    negative = values.filter((value) => value < 0n);
  const sum = (items: bigint[]) => items.reduce((total, value) => total + value, 0n);
  const gains = sum(positive),
    losses = sum(negative);
  return {
    samples: values.length,
    wins: positive.length,
    losses: negative.length,
    flats: values.length - positive.length - negative.length,
    netPnl: values.length ? formatDecimal(gains + losses) : null,
    winRate: ratio(BigInt(positive.length) * 100n, BigInt(values.length)),
    averageWin: positive.length ? formatDecimal(gains / BigInt(positive.length)) : null,
    averageLoss: negative.length ? formatDecimal(losses / BigInt(negative.length)) : null,
    profitFactor: ratio(gains, -losses),
  };
}
function metrics(trades: ReviewSummary[]) {
  const valid = trades.filter(
    (trade) =>
      trade.status === 'closed' &&
      trade.netPnl !== null &&
      trade.realizedPnl !== null &&
      trade.commission !== null &&
      trade.fundingNet !== null &&
      !trade.missing.length,
  );
  const validIds = new Set(valid.map((trade) => trade.id));
  const excluded: Exclusion[] = trades
    .filter((trade) => !validIds.has(trade.id))
    .map((trade) => ({
      tradeId: trade.id,
      reasons: [
        ...new Set([
          ...(trade.status === 'open' ? ['交易尚未结束'] : []),
          ...trade.missing,
          ...(trade.realizedPnl === null ? ['已实现盈亏缺失'] : []),
          ...(trade.commission === null ? ['手续费缺失或换算待确认'] : []),
          ...(trade.fundingNet === null ? ['资金费缺失或归属待确认'] : []),
          ...(trade.netPnl === null && !trade.missing.length ? ['净盈亏待确认'] : []),
          ...(trade.status !== 'closed' && !trade.missing.length && trade.status !== 'open'
            ? ['交易完整性待确认']
            : []),
        ]),
      ].sort(),
    }));
  const durations = trades.filter((trade) => trade.durationMs !== null);
  const duration = {
    samples: durations.length,
    averageMs: durations.length
      ? Number(
          durations.reduce((sum, trade) => sum + BigInt(trade.durationMs!), 0n) /
            BigInt(durations.length),
        )
      : null,
    minMs: durations.length
      ? durations.reduce((min, trade) => Math.min(min, trade.durationMs!), Infinity)
      : null,
    maxMs: durations.length
      ? durations.reduce((max, trade) => Math.max(max, trade.durationMs!), 0)
      : null,
    excluded: trades
      .filter((trade) => trade.durationMs === null)
      .map((trade) => ({
        tradeId: trade.id,
        reasons: [trade.status === 'open' ? '交易尚未结束' : '开平仓时间或完整成交链待确认'],
      })),
  };
  return { total: trades.length, pnl: { ...pnlMetrics(valid), excluded }, duration };
}
const byKey = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function reviewStatistics(
  identity: { source: ReviewIdentity['source']; accountId: string | null },
  filters: ReviewFilters,
  input: ReviewSummary[],
  tagInput: Pick<StyleTag, 'id' | 'name' | 'active'>[],
) {
  const trades = structuredClone(input)
    .map((trade) => ({
      ...trade,
      missing: [...trade.missing].sort(),
      tagIds: [...trade.tagIds].sort(),
    }))
    .sort(byKey);
  const tags = structuredClone(tagInput).sort(byKey);
  const range = { ...defaultReviewFilters(), ...filters, tagIds: [...filters.tagIds].sort() };
  const totals = metrics(trades);
  const excluded = new Set(totals.pnl.excluded.map((item) => item.tradeId));
  let cumulative = 0n;
  const curve = trades
    .filter((trade) => !excluded.has(trade.id))
    .sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!) || byKey(a, b))
    .map((trade) => {
      cumulative += signed(trade.netPnl!);
      return {
        tradeId: trade.id,
        closedAt: trade.closedAt!,
        netPnl: trade.netPnl!,
        cumulativeNetPnl: formatDecimal(cumulative),
      };
    });
  function groups(
    keys: string[],
    label: (key: string) => string,
    matches: (trade: ReviewSummary, key: string) => boolean,
  ) {
    return [...new Set(keys)].sort().map((key) => ({
      key,
      label: label(key),
      ...metrics(trades.filter((trade) => matches(trade, key))),
    }));
  }
  return {
    version: 1 as const,
    ...identity,
    filters: range,
    trades,
    tags,
    ...totals,
    curve,
    groups: {
      symbols: groups(
        trades.map((trade) => trade.symbol),
        (key) => key,
        (trade, key) => trade.symbol === key,
      ),
      sides: groups(
        [...trades.map((trade) => trade.side ?? 'unknown'), 'unknown'],
        (key) => (key === 'long' ? '做多' : key === 'short' ? '做空' : '方向未知'),
        (trade, key) => (trade.side ?? 'unknown') === key,
      ),
      entryTypes: groups(
        [...trades.map((trade) => trade.entryType), 'unknown'],
        (key) => entryTypeLabel(key as ReviewSummary['entryType']),
        (trade, key) => trade.entryType === key,
      ),
      tags: groups(
        [...trades.flatMap((trade) => trade.tagIds), 'unknown'],
        (key) =>
          key === 'unknown'
            ? '未知／未标注'
            : (tags.find((tag) => tag.id === key)?.name ?? '未知标签'),
        (trade, key) => (key === 'unknown' ? !trade.tagIds.length : trade.tagIds.includes(key)),
      ),
    },
  };
}
export type StatisticsSnapshot = ReturnType<typeof reviewStatistics>;
export type StatisticsEvidence = StatisticsSnapshot & { evidenceId: string; queriedAt: string };
