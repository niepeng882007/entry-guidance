import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { parseDecimal } from '../public/draft.js';
import type { ReviewList, ReviewSummary, ReviewTrade } from '../src/review-ledger.ts';

type Source = ReviewList['source'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('复盘响应格式无效。');
  return value as Record<string, unknown>;
}
function amount(value: unknown) {
  if (value === null) return;
  if (typeof value !== 'string') throw new Error('复盘金额无效。');
  parseDecimal(value.startsWith('-') ? value.slice(1) : value, '复盘金额');
}
function validateTrade(value: unknown, source: Source, accountId: string): ReviewSummary {
  const data = object(value);
  if (
    data.source !== source ||
    data.accountId !== accountId ||
    typeof data.id !== 'string' ||
    !/^[A-Za-z0-9-]{1,160}$/.test(data.id) ||
    typeof data.symbol !== 'string' ||
    typeof data.baseAsset !== 'string' ||
    data.symbol !== `${data.baseAsset}USDT` ||
    !['long', 'short'].includes(String(data.side)) ||
    !['closed', 'incomplete'].includes(String(data.status)) ||
    data.groupingVersion !== 1 ||
    typeof data.openedAt !== 'string' ||
    typeof data.closedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.openedAt)) ||
    !Number.isFinite(Date.parse(data.closedAt)) ||
    Date.parse(data.closedAt) < Date.parse(data.openedAt) ||
    !Array.isArray(data.missing) ||
    !data.missing.every((item) => typeof item === 'string')
  )
    throw new Error('复盘来源、身份或交易信息无效。');
  for (const field of ['realizedPnl', 'commission', 'fundingNet', 'netPnl']) amount(data[field]);
  if (
    (data.status === 'closed' &&
      (data.missing.length ||
        ['realizedPnl', 'commission', 'fundingNet', 'netPnl'].some(
          (field) => data[field] === null,
        ))) ||
    (data.status === 'incomplete' && data.netPnl !== null)
  )
    throw new Error('复盘完整性与净盈亏状态不一致。');
  return data as ReviewSummary;
}
function validateDetail(value: unknown, source: Source, accountId: string): ReviewTrade {
  validateTrade(value, source, accountId);
  const data = object(value);
  const evidence = object(data.evidence);
  if (evidence.symbol !== data.symbol || evidence.baseAsset !== data.baseAsset)
    throw new Error('交易证据关联无效。');
  for (const kind of ['orders', 'fills', 'funding']) {
    const records = evidence[kind];
    if (!Array.isArray(records)) throw new Error('交易证据缺失。');
    for (const item of records) {
      const record = object(item);
      if (
        typeof record.id !== 'string' ||
        record.symbol !== data.symbol ||
        typeof record.time !== 'string' ||
        !Number.isFinite(Date.parse(record.time))
      )
        throw new Error('交易证据格式无效。');
      if (kind !== 'funding') {
        if (!['BUY', 'SELL'].includes(String(record.side))) throw new Error('成交方向无效。');
        amount(record.quantity);
        if (record.quantity === null) throw new Error('证据数量缺失。');
      }
      if (kind === 'orders' && ![null, 'LIMIT', 'MARKET'].includes(record.type as string | null))
        throw new Error('订单类型无效。');
      if (kind === 'fills') {
        if (typeof record.orderId !== 'string') throw new Error('成交关联无效。');
        amount(record.price);
        if (record.price === null) throw new Error('成交价格缺失。');
        amount(record.realizedPnl);
        amount(record.commission);
        if (record.commissionAsset !== null && typeof record.commissionAsset !== 'string')
          throw new Error('手续费资产无效。');
      }
      if (kind === 'funding') {
        amount(record.amount);
        if (record.asset !== null && typeof record.asset !== 'string')
          throw new Error('资金费资产无效。');
      }
    }
  }
  return data as ReviewTrade;
}

export function useReviewPage(source: Source) {
  const list = shallowRef<ReviewList | null>(null);
  const trade = shallowRef<ReviewTrade | null>(null);
  const busy = ref(false);
  const relogin = ref(false);
  const status = ref('正在读取归档…');
  let sequence = 0;
  let pending: AbortController | undefined;
  let suspended = false;
  let cleanup = () => {};

  async function read(id?: string) {
    if (suspended || relogin.value || document.hidden || !navigator.onLine) return;
    const current = ++sequence;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    busy.value = true;
    trade.value = null;
    try {
      const response = await fetch(`/api/review/trades${id ? `/${id}` : ''}`, {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (current !== sequence || controller.signal.aborted) return;
      if (response.status === 401) {
        relogin.value = true;
        throw new Error('登录已过期，请重新登录。');
      }
      const data: unknown = await response.json();
      if (current !== sequence || controller.signal.aborted) return;
      if (!response.ok) throw new Error('复盘账本读取失败，已有归档保留，请重试。');
      if (id) {
        if (!list.value?.accountId) throw new Error('账户身份未知，无法读取交易详情。');
        const next = validateDetail(data, source, list.value.accountId);
        if (next.id !== id) throw new Error('交易身份不匹配。');
        trade.value = next;
      } else {
        const next = object(data);
        if (
          next.source !== source ||
          (source === 'demo'
            ? next.syncStatus !== 'demo' || next.accountId !== 'demo-account'
            : next.syncStatus !== 'not-synced' || next.accountId !== null) ||
          !Array.isArray(next.trades) ||
          (source === 'binance' && next.trades.length)
        )
          throw new Error('复盘来源或同步状态无效。');
        for (const item of next.trades) validateTrade(item, source, String(next.accountId));
        list.value = next as ReviewList;
      }
      status.value = source === 'demo' ? '演示归档 · 不是真实交易' : '尚未同步 · 无真实交易归档';
    } catch (error) {
      if (current !== sequence || controller.signal.aborted) return;
      status.value = error instanceof Error ? error.message : '复盘读取失败，请重试。';
    } finally {
      if (current === sequence) {
        pending = undefined;
        busy.value = false;
      }
    }
  }

  function pause(reason: string) {
    suspended = true;
    sequence++;
    pending?.abort();
    pending = undefined;
    busy.value = false;
    status.value = reason;
  }
  function resume() {
    if (document.hidden || !navigator.onLine || relogin.value) return;
    suspended = false;
    void read();
  }
  onMounted(() => {
    const events = new AbortController();
    const options = { signal: events.signal };
    window.addEventListener('pagehide', () => pause('页面已离开，待完成读取已取消。'), options);
    window.addEventListener('pageshow', resume, options);
    window.addEventListener('offline', () => pause('网络已断开，已有归档保留。'), options);
    window.addEventListener('online', resume, options);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) pause('页面已隐藏，待完成读取已取消。');
        else resume();
      },
      options,
    );
    cleanup = () => events.abort();
    if (!navigator.onLine) pause('网络已断开，已有归档保留。');
    else resume();
  });
  onUnmounted(() => {
    cleanup();
    pause('页面已关闭。');
  });
  return {
    list,
    trade,
    busy,
    relogin,
    status,
    refresh: () => read(),
    open: (id: string) => read(id),
  };
}
