import { formatDecimal, parseDecimal } from '../public/draft.js';
import { dateBoundary, parseReviewQuery, reviewPageSize, ReviewFilterError } from './review-filters.ts';
import type { ReviewLedger, ReviewIdentity, ReviewFill, ArchiveProgress } from './review-ledger.ts';

export type OrderRecord = {
  id: string; orderId: string; symbol: string; time: string; updateTime: string | null;
  side: 'BUY' | 'SELL'; type: string | null; status: string | null;
  price: string | null; avgPrice: string | null; quantity: string | null; executedQty: string | null;
  quoteQty: string | null; stopPrice: string | null; realizedPnl: string | null;
  commissions: { asset: string; amount: string }[] | null; missing: string[]; tradeIds: string[];
};
export type OrderList = {
  source: ReviewIdentity['source']; accountId: string | null; orders: OrderRecord[];
  total: number; page: number; pageSize: number; symbols: string[];
  filters: { from: string; to: string; symbol: string }; archive: ArchiveProgress | null;
};

function decimal(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^-?\d{1,24}(\.\d{1,8})?$/.test(value)) throw new Error('订单金额无效。');
  return formatDecimal(signed(value));
}
function signed(value: string) { return parseDecimal(value.replace(/^-/, ''), '订单金额') * (value.startsWith('-') ? -1n : 1n); }
function stamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const time = typeof value === 'string' ? Date.parse(value) : value;
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0) throw new Error('订单时间无效。');
  return new Date(time).toISOString();
}

export function orderRecords(ledger: ReviewLedger): OrderRecord[] {
  const orders = new Map<string, Record<string, unknown>>();
  const fills = new Map<string, ReviewFill>();
  const links = new Map<string, Set<string>>();
  const key = (symbol: string, id: string) => `${symbol}:${id}`;
  for (const summary of ledger.list()) {
    const trade = ledger.get(summary.id)!;
    for (const order of trade.evidence.orders) {
      const identity = key(order.symbol, order.id);
      if (!orders.has(identity)) orders.set(identity, { ...order, orderId: order.id, origQty: order.quantity });
      const ids = links.get(identity) ?? new Set<string>(); ids.add(trade.id); links.set(identity, ids);
    }
    // Allocated fills can belong to two cycles. Only original raw fills can be summed in that case.
    for (const fill of trade.evidence.fills) if (!fill.allocation) fills.set(key(fill.symbol, fill.id), fill);
  }
  for (const raw of ledger.allRaw()) {
    const row = raw.payload;
    if (typeof row.symbol !== 'string') continue;
    if (raw.kind === 'history') orders.set(key(row.symbol, String(row.orderId)), row);
    if (raw.kind === 'trades') fills.set(key(row.symbol, String(row.id)), {
      id: String(row.id), orderId: String(row.orderId), symbol: row.symbol,
      side: row.side as ReviewFill['side'], positionSide: row.positionSide as ReviewFill['positionSide'],
      quantity: decimal(row.qty)!, price: decimal(row.price)!, time: stamp(row.time)!,
      realizedPnl: decimal(row.realizedPnl), commission: decimal(row.commission),
      commissionAsset: typeof row.commissionAsset === 'string' ? row.commissionAsset : null,
    });
  }
  const byOrder = new Map<string, ReviewFill[]>();
  for (const fill of fills.values()) {
    const identity = key(fill.symbol, fill.orderId);
    const group = byOrder.get(identity) ?? []; group.push(fill); byOrder.set(identity, group);
  }
  return [...orders].map(([identity, row]): OrderRecord => {
    const symbol = String(row.symbol), orderId = String(row.orderId);
    if (!['BUY', 'SELL'].includes(String(row.side))) throw new Error('订单方向无效。');
    const group = byOrder.get(identity) ?? [];
    const executedQty = decimal(row.executedQty ?? (ledger.scope().source === 'demo' ? row.origQty : null));
    const complete = executedQty !== null && signed(executedQty) >= 0n && group.reduce((sum, fill) => sum + signed(fill.quantity), 0n) === signed(executedQty);
    const missing: string[] = [];
    if (!complete) missing.push('订单执行数量与完整成交尚未对齐');
    if (group.some((fill) => fill.realizedPnl === null)) missing.push('成交已实现盈亏缺失');
    const realizedPnl = missing.length ? null : formatDecimal(group.reduce((sum, fill) => sum + signed(fill.realizedPnl!), 0n));
    const fees = new Map<string, bigint>();
    for (const fill of group) if (fill.commission !== null && fill.commissionAsset) fees.set(fill.commissionAsset, (fees.get(fill.commissionAsset) ?? 0n) + signed(fill.commission));
    const commissions = !complete || group.some((fill) => fill.commission === null || !fill.commissionAsset) ? null : [...fees].sort(([a], [b]) => a.localeCompare(b)).map(([asset, amount]) => ({ asset, amount: formatDecimal(amount) }));
    return {
      id: `${symbol}-${orderId}`, orderId, symbol, time: stamp(row.time)!, updateTime: stamp(row.updateTime),
      side: row.side as OrderRecord['side'], type: typeof row.type === 'string' ? row.type : null, status: typeof row.status === 'string' ? row.status : null,
      price: decimal(row.price), avgPrice: decimal(row.avgPrice), quantity: decimal(row.origQty), executedQty,
      quoteQty: decimal(row.cumQuote), stopPrice: decimal(row.stopPrice), realizedPnl, commissions, missing,
      tradeIds: [...(links.get(identity) ?? [])].sort(),
    };
  }).sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id));
}

export function listOrders(ledger: ReviewLedger | undefined, source: ReviewIdentity['source'], query: URLSearchParams, archive: ArchiveProgress | null = null): OrderList {
  if ([...query.keys()].some((name) => !['from', 'to', 'symbol', 'page'].includes(name))) throw new ReviewFilterError('订单筛选参数无效。');
  const { filters, page } = parseReviewQuery(query);
  const all = ledger ? orderRecords(ledger) : [];
  const selected = all.filter((order) => (!filters.symbol || order.symbol === filters.symbol)
    && (!filters.from || Date.parse(order.time) >= dateBoundary(filters.from))
    && (!filters.to || Date.parse(order.time) < dateBoundary(filters.to) + 86_400_000));
  return { source, accountId: ledger?.scope().accountId ?? null, orders: selected.slice((page - 1) * reviewPageSize, page * reviewPageSize), total: selected.length, page, pageSize: reviewPageSize,
    symbols: [...new Set(all.map((row) => row.symbol))].sort(), filters: { from: filters.from, to: filters.to, symbol: filters.symbol }, archive };
}
