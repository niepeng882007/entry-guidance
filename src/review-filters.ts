import { parseDecimal } from '../public/draft.js';
import type { ReviewSummary, ReviewTrade } from './review-ledger.ts';

export const reviewTimeZone = 'Asia/Shanghai';
export const reviewPageSize = 20;
export const orderTypes = {
  LIMIT: '限价单', MARKET: '市价单', STOP: '止损限价单', STOP_MARKET: '止损市价单',
  TAKE_PROFIT: '止盈限价单', TAKE_PROFIT_MARKET: '止盈市价单', TRAILING_STOP_MARKET: '追踪止损单',
} as const;
export type EntryType = keyof typeof orderTypes | 'mixed' | 'unknown';
export type ReviewFilters = {
  timeZone: typeof reviewTimeZone; dateField: 'openedAt' | 'closedAt'; from: string; to: string;
  symbol: string; side: '' | 'long' | 'short' | 'unknown'; pnl: '' | 'win' | 'loss' | 'flat' | 'pending';
  status: '' | 'open' | 'closed' | 'incomplete'; entryType: '' | EntryType;
  plan: '' | 'linked' | 'unconfirmed'; tagIds: string[];
};
export function defaultReviewFilters(): ReviewFilters {
  return { timeZone: reviewTimeZone, dateField: 'openedAt', from: '', to: '', symbol: '', side: '', pnl: '', status: '', entryType: '', plan: '', tagIds: [] };
}
export class ReviewFilterError extends Error {}
function invalid(): never { throw new ReviewFilterError('交易筛选参数无效，请检查日期、条件与页码。'); }
export function dateBoundary(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '9998-12-31') return invalid();
  const utc = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) return invalid();
  return utc - 8 * 60 * 60 * 1000;
}
export function parseReviewQuery(query: URLSearchParams): { filters: ReviewFilters; page: number } {
  const filters = defaultReviewFilters();
  const keys = [...Object.keys(filters).filter((key) => key !== 'tagIds'), 'tag', 'page'];
  if ([...query.keys()].some((key) => !keys.includes(key) || key !== 'tag' && query.getAll(key).length !== 1)) return invalid();
  function choice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
    const value = query.get(key);
    if (value === null) return fallback;
    if (!choices.includes(value as T)) return invalid();
    return value as T;
  }
  filters.timeZone = choice('timeZone', [reviewTimeZone], reviewTimeZone);
  filters.dateField = choice('dateField', ['openedAt', 'closedAt'], 'openedAt');
  filters.side = choice('side', ['long', 'short', 'unknown'], '');
  filters.pnl = choice('pnl', ['win', 'loss', 'flat', 'pending'], '');
  filters.status = choice('status', ['open', 'closed', 'incomplete'], '');
  filters.entryType = choice('entryType', [...Object.keys(orderTypes) as (keyof typeof orderTypes)[], 'mixed', 'unknown'], '');
  filters.plan = choice('plan', ['linked', 'unconfirmed'], '');
  for (const key of ['from', 'to'] as const) {
    const value = query.get(key);
    if (value !== null) { dateBoundary(value); filters[key] = value; }
  }
  if (filters.from && filters.to && filters.from > filters.to) return invalid();
  filters.symbol = query.get('symbol') ?? '';
  if (query.has('symbol') && !/^[\p{L}\p{N}_]{1,30}USDT$/u.test(filters.symbol)) return invalid();
  filters.tagIds = query.getAll('tag').sort();
  if (filters.tagIds.length > 20 || new Set(filters.tagIds).size !== filters.tagIds.length || filters.tagIds.some((id) => !/^[a-f0-9-]{36}$/.test(id))) return invalid();
  const value = query.get('page') ?? '1';
  if (!/^[1-9]\d{0,5}$/.test(value)) return invalid();
  return { filters, page: Number(value) };
}
export function reviewQuery(filters: ReviewFilters, page = 1): URLSearchParams {
  const query = new URLSearchParams();
  const defaults = defaultReviewFilters();
  for (const [key, value] of Object.entries(filters)) {
    if (key !== 'tagIds' && value && value !== defaults[key as keyof ReviewFilters]) query.set(key, String(value));
  }
  for (const id of [...filters.tagIds].sort()) query.append('tag', id);
  if (page !== 1) query.set('page', String(page));
  return query;
}
export function executionTypes(trade: ReviewTrade, entry: boolean): EntryType[] {
  const fills = trade.evidence.fills.filter((fill) => {
    if (trade.groupingVersion === 2) return entry
      ? fill.event === 'entry' || fill.event === 'add'
      : fill.event === 'reduce' || fill.event === 'exit';
    return trade.side !== null && (fill.side === (trade.side === 'long' ? 'BUY' : 'SELL')) === entry;
  });
  const types = fills.map((fill): EntryType => {
    const type = trade.evidence.orders.find((order) => order.id === fill.orderId)?.type;
    return type && Object.hasOwn(orderTypes, type) ? type as keyof typeof orderTypes : 'unknown';
  });
  return types.length ? [...new Set(types)] : ['unknown'];
}
export function entryType(trade: ReviewTrade): EntryType {
  const types = executionTypes(trade, true);
  return types.length > 1 ? 'mixed' : types[0]!;
}
export function entryTypeLabel(type: EntryType): string {
  return type === 'mixed' ? '混合' : type === 'unknown' ? '未知' : orderTypes[type];
}
export function matchesReview(trade: ReviewSummary, filters: ReviewFilters): boolean {
  const stamp = trade[filters.dateField];
  if (filters.from || filters.to) {
    if (stamp === null) return false;
    const time = Date.parse(stamp);
    if (filters.from && time < dateBoundary(filters.from) || filters.to && time >= dateBoundary(filters.to) + 86400000) return false;
  }
  if (filters.symbol && trade.symbol !== filters.symbol || filters.side && (trade.side ?? 'unknown') !== filters.side || filters.status && trade.status !== filters.status || filters.entryType && trade.entryType !== filters.entryType) return false;
  if (filters.plan && (trade.planLink?.status === 'linked') !== (filters.plan === 'linked')) return false;
  if (filters.pnl) {
    let pnl = 'pending';
    if (trade.netPnl !== null) {
      const number = parseDecimal(trade.netPnl.startsWith('-') ? trade.netPnl.slice(1) : trade.netPnl, '净盈亏');
      pnl = number === 0n ? 'flat' : trade.netPnl.startsWith('-') ? 'loss' : 'win';
    }
    if (pnl !== filters.pnl) return false;
  }
  return filters.tagIds.every((id) => trade.tagIds.includes(id));
}
export function sortReview(a: ReviewSummary, b: ReviewSummary): number {
  const time = (value: string | null) => value === null ? -Infinity : Date.parse(value);
  const difference = time(b.openedAt) - time(a.openedAt);
  return difference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
