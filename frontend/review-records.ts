import { dateBoundary } from '../src/review-filters.ts';

export type ReviewLocation = {
  tradeId: string | null;
  from: string;
  to: string;
  symbol: string;
  page: number;
};

export function readReviewLocation(url: URL): ReviewLocation {
  const page = Number(url.searchParams.get('page') ?? 1);
  return {
    tradeId: url.pathname.match(/^\/review\/trades\/([A-Za-z0-9-]{1,160})$/)?.[1] ?? null,
    from: url.searchParams.get('from') ?? '',
    to: url.searchParams.get('to') ?? '',
    symbol: url.searchParams.get('symbol') ?? '',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function reviewUrl(location: ReviewLocation) {
  const query = new URLSearchParams();
  for (const key of ['from', 'to', 'symbol'] as const)
    if (location[key]) query.set(key, location[key]);
  if (location.page > 1) query.set('page', String(location.page));
  return `/review${location.tradeId ? `/trades/${location.tradeId}` : ''}${query.size ? `?${query}` : ''}`;
}

function validDate(value: string) {
  try {
    dateBoundary(value);
    return true;
  } catch {
    return false;
  }
}

export function dateRangeError(from: string, to: string) {
  if ((from && !validDate(from)) || (to && !validDate(to))) return '日期无效，请重新选择。';
  if (from && to && from > to) return '开始日期不能晚于结束日期。';
  return '';
}

export function reviewTime(value: string | null) {
  return value === null
    ? '待确认'
    : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export function reviewAmount(value: string | null, asset: string | null = 'USDT') {
  return value === null ? '待确认' : `${value} ${asset ?? '未知资产'}`;
}

export function reviewDuration(opened: string | null, closed: string | null) {
  if (!opened || !closed) return '待确认';
  const minutes = Math.floor((Date.parse(closed) - Date.parse(opened)) / 60_000);
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
