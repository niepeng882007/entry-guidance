import { onMounted, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue';
import type { ReviewTrade } from '../src/review-ledger.ts';
import type { MarketInterval, MarketView } from '../src/trade-market.ts';
import { parseDecimal } from '../public/draft.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('行情响应格式无效。');
  return value as Record<string, unknown>;
}
const stamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function price(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,24}(\.\d{1,8})?$/.test(value) ||
    parseDecimal(value, '价格') <= 0n
  )
    throw new Error('行情价格无效。');
}
function validate(value: unknown, trade: ReviewTrade, interval: MarketInterval): MarketView {
  const data = object(value);
  if (
    data.source !== trade.source ||
    data.accountId !== trade.accountId ||
    data.tradeId !== trade.id ||
    data.symbol !== trade.symbol ||
    data.interval !== interval ||
    typeof data.snapshotId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.snapshotId) ||
    !stamp(data.queriedAt) ||
    !number(data.startTime) ||
    !number(data.endTime) ||
    !number(data.desiredEndTime) ||
    data.endTime < data.startTime ||
    data.desiredEndTime < data.endTime ||
    data.openedAt !== trade.openedAt ||
    data.closedAt !== trade.closedAt ||
    !Array.isArray(data.missing) ||
    !data.missing.every((item) => typeof item === 'string') ||
    !Array.isArray(data.events) ||
    data.events.length !== trade.evidence.fills.length ||
    !Array.isArray(data.stops)
  )
    throw new Error('行情来源、时点或交易依据不一致。');
  const series = object(data.series);
  for (const [source, endpoint] of [
    ['contract', '/fapi/v1/klines'],
    ['mark', '/fapi/v1/markPriceKlines'],
  ] as const) {
    const item = object(series[source]);
    if (
      item.endpoint !== endpoint ||
      typeof item.complete !== 'boolean' ||
      !number(item.nextTime) ||
      !number(item.rawCount) ||
      typeof item.sampled !== 'boolean' ||
      !(item.error === null || typeof item.error === 'string') ||
      !Array.isArray(item.candles) ||
      item.candles.length > 301 ||
      item.rawCount < item.candles.length ||
      !Array.isArray(item.gaps) ||
      (item.complete && (item.gaps.length || item.nextTime <= data.endTime))
    )
      throw new Error('行情完整性或价格来源无效。');
    let previous = -1;
    for (const value of item.candles) {
      const row = object(value);
      if (
        !number(row.openTime) ||
        !number(row.closeTime) ||
        row.openTime <= previous ||
        row.openTime < data.startTime ||
        row.openTime > data.endTime ||
        row.closeTime < row.openTime ||
        !stamp(row.queriedAt) ||
        typeof row.final !== 'boolean' ||
        (item.complete && !row.final)
      )
        throw new Error('K 线时间或完整性无效。');
      for (const field of ['open', 'high', 'low', 'close']) price(row[field]);
      previous = row.openTime;
    }
    for (const gap of item.gaps) {
      const row = object(gap);
      if (
        !number(row.startTime) ||
        !number(row.endTime) ||
        row.endTime < row.startTime ||
        row.startTime < data.startTime ||
        row.endTime > data.endTime
      )
        throw new Error('行情缺口无效。');
    }
  }
  data.events.forEach((value, index) => {
    const row = object(value);
    const fill = trade.evidence.fills[index]!;
    for (const field of ['id', 'orderId', 'price', 'time', 'quantity', 'allocation'] as const)
      if (row[field] !== fill[field]) throw new Error('行情事件与实际成交不一致。');
    if (
      (row.event !== undefined &&
        !['entry', 'add', 'reduce', 'exit'].includes(String(row.event))) ||
      !['before', 'during', 'after', 'unknown'].includes(String(row.phase)) ||
      typeof row.orderKnown !== 'boolean'
    )
      throw new Error('行情事件类型无效。');
  });
  for (const value of data.stops) {
    const row = object(value);
    if (
      typeof row.id !== 'string' ||
      typeof row.label !== 'string' ||
      typeof row.basis !== 'string' ||
      !number(row.time) ||
      !['plan', 'observed', 'historical'].includes(String(row.kind)) ||
      (row.kind === 'plan' && trade.planComparison?.status !== 'linked')
    )
      throw new Error('止损设置证据无效。');
    price(row.price);
  }
  return data as MarketView;
}

export function useTradeMarket(trade: Ref<ReviewTrade>) {
  const interval = ref<MarketInterval>('15m');
  const chart = shallowRef<MarketView | null>(null);
  const busy = ref(false),
    relogin = ref(false),
    status = ref('');
  let sequence = 0;
  let pending: AbortController | undefined;
  let suspended = false;
  function cancel(message: string) {
    suspended = true;
    sequence++;
    pending?.abort();
    busy.value = false;
    status.value = message;
  }
  async function read(refresh = true) {
    if (suspended || relogin.value) return;
    pending?.abort();
    const current = ++sequence;
    const controller = new AbortController();
    pending = controller;
    const basis = trade.value,
      period = interval.value;
    busy.value = true;
    status.value = refresh ? '正在读取并保存历史行情…' : '正在读取已归档行情…';
    const timeout = setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetch(
        `/api/review/trades/${encodeURIComponent(basis.id)}/market?interval=${period}${refresh ? '&refresh=1' : ''}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (current !== sequence) return;
      if (response.status === 404 && !refresh) {
        chart.value = null;
        status.value = '尚无该周期的本地行情，请手动读取行情。';
        return;
      }
      if (response.status === 401) {
        chart.value = null;
        relogin.value = true;
        throw new Error('登录已过期，请重新登录。');
      }
      if (!response.ok) throw new Error('行情读取失败，已知证据保留，请重试。');
      const value: unknown = await response.json();
      if (current !== sequence) return;
      try {
        chart.value = validate(value, basis, period);
      } catch (error) {
        chart.value = null;
        throw error;
      }
      status.value = '行情证据已归档 · 完整性按价格来源分别确认';
    } catch (error) {
      if (current !== sequence) return;
      status.value = controller.signal.aborted
        ? '行情读取已超时，已知证据保留，请重试。'
        : error instanceof Error
          ? error.message
          : '行情读取失败。';
    } finally {
      clearTimeout(timeout);
      if (current === sequence) {
        busy.value = false;
        pending = undefined;
      }
    }
  }
  watch([trade, interval], () => {
    sequence++;
    pending?.abort();
    chart.value = null;
    void read(false);
  });
  onMounted(() => {
    const events = new AbortController();
    const options = { signal: events.signal };
    const resume = () => {
      if (document.hidden || !navigator.onLine) return;
      suspended = false;
    };
    window.addEventListener(
      'pagehide',
      () => cancel('页面已离开，待完成行情读取已取消。'),
      options,
    );
    window.addEventListener('pageshow', resume, options);
    window.addEventListener(
      'offline',
      () => cancel('网络已断开，图中仅保留已知时点的行情。'),
      options,
    );
    window.addEventListener('online', resume, options);
    document.addEventListener(
      'visibilitychange',
      () => (document.hidden ? cancel('页面已隐藏，待完成行情读取已取消。') : resume()),
      options,
    );
    cleanup = () => events.abort();
    if (!navigator.onLine) cancel('网络已断开，无法读取行情。');
    else {
      resume();
      void read(false);
    }
  });
  let cleanup = () => {};
  onUnmounted(() => {
    cleanup();
    cancel('页面已关闭。');
  });
  return { interval, chart, busy, relogin, status, read };
}
