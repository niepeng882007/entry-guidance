import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { OrderList } from '../src/review-orders.ts';
import type { ReviewLocation } from './review-records';
import { parseDecimal } from '../public/draft.js';

function validate(value: unknown, source: OrderList['source']): OrderList {
  if (!value || typeof value !== 'object') throw new Error('订单响应无效。');
  const data = value as OrderList;
  if (
    data.source !== source ||
    (data.accountId !== null && typeof data.accountId !== 'string') ||
    !Array.isArray(data.orders) ||
    !Array.isArray(data.symbols) ||
    !data.symbols.every((symbol) => typeof symbol === 'string') ||
    !Number.isSafeInteger(data.total) ||
    data.total < 0 ||
    data.pageSize !== 20 ||
    !Number.isSafeInteger(data.page) ||
    data.page < 1
  )
    throw new Error('订单身份或分页响应无效。');
  const ids = new Set<string>();
  for (const order of data.orders) {
    if (
      !order ||
      typeof order !== 'object' ||
      typeof order.id !== 'string' ||
      ids.has(order.id) ||
      typeof order.orderId !== 'string' ||
      typeof order.symbol !== 'string' ||
      !/^[\p{L}\p{N}_]{1,30}USDT$/u.test(order.symbol) ||
      order.id !== `${order.symbol}-${order.orderId}` ||
      !['BUY', 'SELL'].includes(order.side) ||
      !Number.isFinite(Date.parse(order.time)) ||
      !Array.isArray(order.tradeIds) ||
      !order.tradeIds.every((id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,160}$/.test(id)) ||
      !Array.isArray(order.missing) ||
      !order.missing.every((message) => typeof message === 'string')
    )
      throw new Error('订单记录无效。');
    for (const field of [
      'price',
      'avgPrice',
      'quantity',
      'executedQty',
      'quoteQty',
      'stopPrice',
      'realizedPnl',
    ] as const) {
      const amount = order[field];
      if (amount !== null) {
        if (typeof amount !== 'string') throw new Error('订单金额无效。');
        parseDecimal(amount.replace(/^-/, ''), '订单金额');
      }
    }
    ids.add(order.id);
  }
  return data;
}

export function useReviewOrders(source: OrderList['source'], location: () => ReviewLocation) {
  const list = shallowRef<OrderList | null>(null);
  const busy = ref(false),
    updating = ref(false),
    stale = ref(false),
    relogin = ref(false);
  const message = ref('');
  let pending: AbortController | undefined,
    sequence = 0;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const lifetime = new AbortController();
  function cancel() {
    sequence++;
    pending?.abort();
    busy.value = false;
  }
  async function read() {
    if (lifetime.signal.aborted) return;
    cancel();
    const current = sequence,
      requested = location();
    const query = new URLSearchParams();
    for (const field of ['from', 'to', 'symbol'] as const)
      if (requested[field]) query.set(field, requested[field]);
    query.set('page', String(requested.page));
    const controller = new AbortController();
    pending = controller;
    busy.value = true;
    try {
      const response = await fetch(`/api/review/orders?${query}`, {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (current !== sequence) return;
      if (response.status === 401) relogin.value = true;
      if (!response.ok) throw new Error('订单读取失败，请重新读取本地记录。');
      const result = validate(await response.json(), source);
      if (current !== sequence) return;
      if (
        result.page !== requested.page ||
        result.filters.from !== requested.from ||
        result.filters.to !== requested.to ||
        result.filters.symbol !== requested.symbol
      )
        throw new Error('订单筛选范围不一致。');
      list.value = result;
      stale.value = false;
      message.value = result.accountId
        ? '已读取本地记录，未连接 Binance。'
        : '请手动更新，确认账户并建立本地记录。';
      clearTimeout(progressTimer);
      if (updating.value && result.archive?.status === 'running')
        progressTimer = setTimeout(() => void read(), 2000);
      else if (updating.value) {
        updating.value = false;
        message.value = '本次更新已停止，请查看进度与缺口后手动继续。';
        if (result.archive?.status === 'complete') {
          message.value = '本次更新完成。';
          if (result.archive.orderDownload && result.archive.orderDownload.status !== 'complete')
            message.value = '近期记录已补查；订单下载尚未完成，请查看进度与缺口。';
        }
      }
    } catch (error) {
      if (current !== sequence) return;
      stale.value = true;
      message.value = error instanceof Error ? error.message : '订单读取失败。';
    } finally {
      if (current === sequence) {
        busy.value = false;
        pending = undefined;
      }
    }
  }
  async function update(selectedDates = false) {
    if (updating.value || relogin.value) return;
    updating.value = true;
    try {
      const response = await fetch('/api/review/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedDates ? { from: location().from, to: location().to } : {}),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
      });
      if (response.status === 401) relogin.value = true;
      if (!response.ok) {
        const error: unknown = await response.json();
        throw new Error(
          error && typeof error === 'object' && 'error' in error && typeof error.error === 'string'
            ? error.error
            : '更新未能启动；请检查连接后手动重试。',
        );
      }
      message.value = '本次手动更新已启动，正在处理下载与补数。';
      await read();
    } catch (error) {
      updating.value = false;
      message.value = error instanceof Error ? error.message : '更新失败。';
    }
  }
  watch(location, () => {
    stale.value = true;
    void read();
  });
  onMounted(() => {
    const pause = () => {
      clearTimeout(progressTimer);
      if (pending) {
        stale.value = true;
        cancel();
      }
    };
    window.addEventListener('pagehide', pause, { signal: lifetime.signal });
    window.addEventListener('offline', pause, { signal: lifetime.signal });
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) pause();
      },
      { signal: lifetime.signal },
    );
    void read();
  });
  onUnmounted(() => {
    lifetime.abort();
    cancel();
    clearTimeout(progressTimer);
  });
  return { list, busy, updating, stale, relogin, message, read, update };
}

export const orderStatus = (status: string | null) =>
  ({
    FILLED: '全部成交',
    CANCELED: '已取消',
    EXPIRED: '已过期',
    NEW: '待成交',
    PARTIALLY_FILLED: '部分成交',
    EXPIRED_IN_MATCH: '撮合过期',
  })[status ?? ''] ??
  status ??
  '未知';
