import { createHash, randomUUID } from 'node:crypto';
import { AccountError, readBinance, type AccountConfig } from './account.ts';
import { parseDecimal } from '../public/draft.js';
import type { ReviewLedger, ReviewTrade, ReviewFill } from './review-ledger.ts';

export const marketIntervals = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as const;
export type MarketInterval = keyof typeof marketIntervals;
export type PriceSource = 'contract' | 'mark';
export type Candle = { openTime: number; closeTime: number; open: string; high: string; low: string; close: string; queriedAt: string; final: boolean };
export type MarketSeries = { endpoint: string; candles: Candle[]; nextTime: number; complete: boolean; gaps: { startTime: number; endTime: number }[]; error: string | null };
export type MarketEvent = ReviewFill & { phase: 'before' | 'during' | 'after' | 'unknown'; orderKnown: boolean };
export type MarketStop = { id: string; price: string; time: number; basis: string; kind: 'plan' | 'observed' | 'historical'; label: string };
export type MarketArchive = {
  snapshotId: string; cacheKey: string; source: ReviewTrade['source']; accountId: string; tradeId: string; symbol: string;
  interval: MarketInterval; queriedAt: string; startTime: number; endTime: number; desiredEndTime: number;
  openedAt: string | null; closedAt: string | null; events: MarketEvent[]; stops: MarketStop[];
  missing: string[]; series: Record<PriceSource, MarketSeries>; evidence: ReviewTrade;
  limitations: string[];
};
export type MarketView = Omit<MarketArchive, 'evidence' | 'series' | 'cacheKey'> & {
  series: Record<PriceSource, MarketSeries & { rawCount: number; sampled: boolean }>;
};

function phase(trade: ReviewTrade, time: number): MarketEvent['phase'] {
  if (trade.closedAt && time > Date.parse(trade.closedAt)) return 'after';
  if (!trade.openedAt) return 'unknown';
  return time < Date.parse(trade.openedAt) ? 'before' : 'during';
}

function tradeEvents(trade: ReviewTrade): MarketEvent[] {
  let position: bigint | null = trade.evidence.startPosition === '0' ? 0n : null;
  return trade.evidence.fills.map((fill) => {
    let event = fill.event;
    if (trade.groupingVersion === 1 && position !== null) {
      const delta = parseDecimal(fill.quantity, '数量') * (fill.side === 'BUY' ? 1n : -1n);
      const next = position + delta;
      event = position === 0n ? 'entry' : next === 0n ? 'exit' : position * delta > 0n ? 'add' : 'reduce';
      position = next;
    }
    return { ...fill, event, phase: phase(trade, Date.parse(fill.time)), orderKnown: trade.evidence.orders.some((order) => order.id === fill.orderId && order.type !== null) };
  });
}

function tradeStops(trade: ReviewTrade, queriedAt: number): MarketStop[] {
  const stops: MarketStop[] = [];
  const comparison = trade.planComparison;
  const plan = comparison?.status === 'linked' ? comparison.plan : null;
  if (plan) {
    stops.push({ id: `${plan.id}-final`, price: plan.stopPrice, time: Date.parse(plan.startedAt), basis: 'MARK_PRICE', kind: 'plan', label: '原计划最终止损' });
    if (plan.nearStop) stops.push({ id: `${plan.id}-near`, price: plan.nearStop.price, time: Date.parse(plan.startedAt), basis: 'MARK_PRICE', kind: 'plan', label: '原计划近端止损' });
  }
  for (const check of comparison?.verifications ?? []) {
    if (!check.reviewEvidence?.snapshotConsistent) continue;
    for (const [kind, records] of [['observed', check.reviewEvidence.stops], ['historical', check.reviewEvidence.historicalStops]] as const) {
      for (const stop of records) {
        if (!['STOP', 'STOP_MARKET'].includes(stop.type)) continue;
        stops.push({ id: `${stop.id}-${check.queriedAt}-${kind}`, price: stop.triggerPrice, time: Date.parse(check.queriedAt), basis: stop.workingType, kind, label: `${kind === 'observed' ? '查询时点实际止损设置' : '查询到的历史止损设置'} ${stop.id} · ${stop.status}` });
      }
    }
  }
  for (const record of trade.evidence.raw ?? []) {
    const row = record.payload;
    if (!['algoHistory', 'history'].includes(record.kind) || !['STOP', 'STOP_MARKET'].includes(String(row.orderType ?? row.origType ?? row.type))) continue;
    const orderId = record.kind === 'algoHistory' ? String(row.actualOrderId) : record.id;
    if (!trade.evidence.orders.some((order) => order.id === orderId)) continue;
    const price = record.kind === 'algoHistory' ? row.triggerPrice : row.stopPrice;
    if (typeof price !== 'string' || !/^\d+(\.\d{1,8})?$/.test(price) || parseDecimal(price, '止损价') <= 0n) continue;
    const updated = typeof row.updateTime === 'number' && Number.isSafeInteger(row.updateTime) && row.updateTime >= record.time && row.updateTime <= queriedAt ? row.updateTime : null;
    stops.push({ id: `history-${record.kind}-${record.id}`, price, time: updated ?? queriedAt, basis: typeof row.workingType === 'string' ? row.workingType : 'UNKNOWN', kind: 'historical', label: `实际订单 ${orderId} 关联的历史止损设置 ${record.id} · ${updated === null ? '来源更新时间未知，按本次读取时点列出' : '来源更新时间'}，非触发证明` });
  }
  return stops;
}

function candles(value: unknown, start: number, end: number, step: number, queriedAt: string): Candle[] {
  if (!Array.isArray(value) || value.length > 499) throw new AccountError('invalid_response', '历史行情响应无效。');
  const rows: Candle[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 7 || !Number.isSafeInteger(row[0]) || row[0] < start || row[0] > end || row[0] % step !== 0 || row[6] !== row[0] + step - 1 || rows.some((item) => item.openTime === row[0])) throw new AccountError('invalid_response', '历史行情时间或分页响应无效。');
    const prices = row.slice(1, 5) as unknown[];
    if (prices.some((price) => typeof price !== 'string' || !/^\d{1,24}(\.\d{1,8})?$/.test(price) || parseDecimal(price, '行情价') <= 0n)) throw new AccountError('invalid_response', '历史行情价格无效。');
    const [open, high, low, close] = prices as [string, string, string, string];
    const parsed = [open, high, low, close].map((price) => parseDecimal(price, '行情价'));
    if (parsed[1]! < parsed[0]! || parsed[1]! < parsed[3]! || parsed[2]! > parsed[0]! || parsed[2]! > parsed[3]! || parsed[2]! > parsed[1]!) throw new AccountError('invalid_response', '历史行情高低价不一致。');
    rows.push({ openTime: row[0], closeTime: row[6], open, high, low, close, queriedAt, final: row[6] < Date.parse(queriedAt) });
  }
  return rows.sort((a, b) => a.openTime - b.openTime);
}

export function marketGaps(archive: Pick<MarketArchive, 'startTime' | 'endTime' | 'interval'>, candles: readonly Candle[]): MarketSeries['gaps'] {
  const gaps: MarketSeries['gaps'] = [];
  const step = marketIntervals[archive.interval];
  let next = archive.startTime;
  for (const candle of [...candles].sort((a, b) => a.openTime - b.openTime)) {
    if (candle.openTime < next || candle.openTime > archive.endTime) continue;
    if (candle.openTime > next) gaps.push({ startTime: next, endTime: candle.openTime - 1 });
    next = candle.openTime + step;
  }
  if (next <= archive.endTime) gaps.push({ startTime: next, endTime: archive.endTime });
  return gaps;
}
function coverage(series: MarketSeries, archive: MarketArchive) {
  series.gaps = marketGaps(archive, series.candles);
  series.complete = !series.gaps.length && series.nextTime > archive.endTime && series.candles.every((row) => row.final);
}

export async function readTradeMarket(config: AccountConfig, ledger: ReviewLedger, trade: ReviewTrade, interval: MarketInterval, signal: AbortSignal): Promise<MarketArchive> {
  const step = marketIntervals[interval];
  const now = Date.now();
  const first = trade.openedAt ? Date.parse(trade.openedAt) : Math.min(...trade.evidence.fills.map((fill) => Date.parse(fill.time)));
  if (!Number.isFinite(first) || first > now) throw new AccountError('missing_events', '没有可用于行情范围的已知成交时间。', 409);
  const startTime = Math.max(step, Math.floor(first / step) * step - 10 * step);
  const desiredEndTime = trade.closedAt ? Math.floor(Date.parse(trade.closedAt) / step) * step + 11 * step - 1 : now;
  const endTime = Math.min(desiredEndTime, now);
  const cacheKey = createHash('sha256').update(JSON.stringify([trade.source, trade.accountId, trade.id, trade.symbol, interval, startTime, trade.closedAt])).digest('hex');
  const cached = ledger.latestMarket(cacheKey);
  if (cached && cached.endTime === endTime && cached.series.contract.complete && cached.series.mark.complete && JSON.stringify(cached.evidence) === JSON.stringify(trade)) return cached;
  const archive: MarketArchive = cached ?? {
    snapshotId: '', cacheKey, source: trade.source, accountId: trade.accountId, tradeId: trade.id, symbol: trade.symbol, interval,
    queriedAt: new Date(now).toISOString(), startTime, endTime, desiredEndTime, openedAt: trade.openedAt, closedAt: trade.closedAt,
    events: tradeEvents(trade), stops: tradeStops(trade, now), missing: [...trade.missing], evidence: structuredClone(trade),
    limitations: ['整根 K 线仅在 closeTime 后完整可知，跨开平仓边界的 OHLC 不属于边界时点已知信息；final=false 表示读取时仍未闭合。', '出场后行情仅用于事后观察；K 线不能证明止损触发或精确逐笔价格路径。', '原计划与实际止损设置分别表达，设置证据只证明所记录时点；缺少记录的保护状态未知。', '原始行情按价格来源分别保留完整性、缺口与每根读取时点，屏幕抽稀不改变归档证据。'],
    series: { contract: { endpoint: '/fapi/v1/klines', candles: [], nextTime: startTime, complete: false, gaps: [], error: null }, mark: { endpoint: '/fapi/v1/markPriceKlines', candles: [], nextTime: startTime, complete: false, gaps: [], error: null } },
  };
  archive.snapshotId = createHash('sha256').update(randomUUID()).digest('hex');
  if (archive.endTime !== endTime) for (const series of Object.values(archive.series)) series.complete = false;
  archive.endTime = endTime;
  archive.desiredEndTime = desiredEndTime;
  archive.queriedAt = new Date(now).toISOString();
  archive.events = tradeEvents(trade);
  archive.stops = tradeStops(trade, now);
  archive.missing = [...trade.missing];
  archive.evidence = structuredClone(trade);
  archive.openedAt = trade.openedAt;
  archive.closedAt = trade.closedAt;
  for (const source of ['contract', 'mark'] as const) {
    const series = archive.series[source];
    if (series.complete) continue;
    series.error = null;
    series.candles = series.candles.filter((row) => row.final);
    coverage(series, archive);
    // Finish the forward scan before repairing old holes, so a permanent gap cannot starve later evidence.
    if (series.nextTime > endTime) series.nextTime = series.gaps[0]?.startTime ?? endTime + 1;
    for (let page = 0; page < 4 && series.nextTime <= endTime; page++) {
      const start = series.nextTime, end = Math.min(endTime, start + 499 * step - 1);
      const queriedAt = new Date().toISOString();
      try {
        let rows: Candle[];
        if (trade.source === 'demo') {
          rows = [];
          for (let time = start; time <= end; time += step) {
            const price = 60000 + Math.round(Math.sin(time / step / 8) * 300) + (source === 'mark' ? 20 : 0);
            rows.push({ openTime: time, closeTime: time + step - 1, open: String(price), high: String(price + 100), low: String(price - 100), close: String(price + 30), queriedAt, final: time + step - 1 < Date.parse(queriedAt) });
          }
        } else rows = candles(await readBinance(config, source === 'contract' ? 'klines' : 'markKlines', signal, trade.symbol, undefined, 'foreground', { interval, startTime: start, endTime: end }), start, end, step, queriedAt);
        const merged = new Map(series.candles.map((row) => [row.openTime, row]));
        for (const row of rows) merged.set(row.openTime, row);
        series.candles = [...merged.values()].sort((a, b) => a.openTime - b.openTime);
        series.nextTime = Math.floor(end / step) * step + step;
        coverage(series, archive);
        archive.queriedAt = new Date().toISOString();
        ledger.saveMarket(archive);
        if (!rows.length) { series.error = '来源未返回此区间行情，可能已不可查；缺口保留。'; break; }
      } catch (error) {
        series.error = error instanceof AccountError ? error.message : '历史行情读取失败，已知数据保留。';
        break;
      }
    }
    coverage(series, archive);
  }
  ledger.saveMarket(archive);
  return archive;
}

export function marketView(archive: MarketArchive): MarketView {
  const { evidence: _evidence, cacheKey: _cacheKey, series, ...metadata } = archive;
  const preview = (value: MarketSeries) => {
    const stride = Math.max(1, Math.ceil(value.candles.length / 300));
    return { ...value, candles: value.candles.filter((_row, index) => index % stride === 0 || index === value.candles.length - 1), rawCount: value.candles.length, sampled: stride > 1 };
  };
  return { ...metadata, series: { contract: preview(series.contract), mark: preview(series.mark) } };
}
