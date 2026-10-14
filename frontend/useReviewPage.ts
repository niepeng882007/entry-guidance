import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { parseDecimal } from '../public/draft.js';
import type {
  RawRecord,
  ReviewList,
  ReviewSummary,
  ReviewTrade,
  SyncState,
  ArchiveProgress,
} from '../src/review-ledger.ts';

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
    (data.side !== null && !['long', 'short'].includes(String(data.side))) ||
    !['closed', 'open', 'incomplete'].includes(String(data.status)) ||
    ![1, 2].includes(Number(data.groupingVersion)) ||
    typeof data.groupingVersion !== 'number' ||
    (data.openedAt !== null &&
      (typeof data.openedAt !== 'string' || !Number.isFinite(Date.parse(data.openedAt)))) ||
    (data.closedAt !== null &&
      (typeof data.closedAt !== 'string' || !Number.isFinite(Date.parse(data.closedAt)))) ||
    (typeof data.openedAt === 'string' &&
      typeof data.closedAt === 'string' &&
      Date.parse(data.closedAt) < Date.parse(data.openedAt)) ||
    !Array.isArray(data.missing) ||
    !data.missing.every((item) => typeof item === 'string')
  )
    throw new Error('复盘来源、身份或交易信息无效。');
  for (const field of ['realizedPnl', 'commission', 'fundingNet', 'netPnl']) amount(data[field]);
  if (
    (data.status === 'closed' &&
      (data.missing.length ||
        !data.openedAt ||
        !data.closedAt ||
        data.side === null ||
        ['realizedPnl', 'commission', 'fundingNet', 'netPnl'].some(
          (field) => data[field] === null,
        ))) ||
    (data.status !== 'closed' && data.netPnl !== null) ||
    (data.status === 'open' && (!data.openedAt || data.closedAt !== null || data.side === null))
  )
    throw new Error('复盘完整性与净盈亏状态不一致。');
  if (data.groupingVersion === 2) {
    if (
      typeof data.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(data.observedAt)) ||
      (typeof data.openedAt === 'string' &&
        Date.parse(data.observedAt) < Date.parse(data.openedAt)) ||
      (typeof data.closedAt === 'string' && Date.parse(data.observedAt) < Date.parse(data.closedAt))
    )
      throw new Error('归并查询时点无效。');
    amount(data.unrealizedPnl);
    if (
      (data.unrealizedPnl === null && data.unrealizedAt !== null) ||
      (data.unrealizedPnl !== null &&
        (data.closedAt !== null ||
          typeof data.unrealizedAt !== 'string' ||
          !Number.isFinite(Date.parse(data.unrealizedAt)) ||
          Date.parse(data.unrealizedAt) < Date.parse(data.observedAt)))
    )
      throw new Error('浮动盈亏查询时点无效。');
  }
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
      if (kind === 'orders' && record.algoId !== undefined && typeof record.algoId !== 'string')
        throw new Error('条件订单关联无效。');
      if (kind === 'orders' && record.type !== null && typeof record.type !== 'string')
        throw new Error('订单类型无效。');
      if (kind === 'fills') {
        if (
          !['BOTH', 'LONG', 'SHORT'].includes(String(record.positionSide)) ||
          (record.allocation !== undefined &&
            !['open', 'close'].includes(String(record.allocation))) ||
          (record.event !== undefined &&
            !['entry', 'add', 'reduce', 'exit'].includes(String(record.event)))
        )
          throw new Error('成交归并信息无效。');
        if (typeof record.orderId !== 'string') throw new Error('成交关联无效。');
        amount(record.price);
        if (record.price === null) throw new Error('成交价格缺失。');
        amount(record.realizedPnl);
        amount(record.commission);
        if (record.commissionAsset !== null && typeof record.commissionAsset !== 'string')
          throw new Error('手续费资产无效。');
      }
      if (kind === 'funding') {
        if (
          record.attribution !== undefined &&
          !['confirmed', 'ambiguous'].includes(String(record.attribution))
        )
          throw new Error('资金费归属状态无效。');
        amount(record.amount);
        if (record.asset !== null && typeof record.asset !== 'string')
          throw new Error('资金费资产无效。');
      }
    }
  }
  return data as ReviewTrade;
}

function validateSync(value: unknown, discovery = false): SyncState {
  const data = object(value);
  if (
    typeof data.symbol !== 'string' ||
    !(discovery ? data.symbol === '*' : /^[\p{L}\p{N}_]{1,30}USDT$/u.test(data.symbol)) ||
    !['running', 'complete', 'failed', 'interrupted'].includes(String(data.status)) ||
    !Number.isSafeInteger(data.startTime) ||
    !Number.isSafeInteger(data.endTime) ||
    Number(data.startTime) <= 0 ||
    Number(data.endTime) < Number(data.startTime) ||
    !Number.isSafeInteger(data.pages) ||
    Number(data.pages) < 0 ||
    !Number.isSafeInteger(data.records) ||
    Number(data.records) < 0 ||
    !Array.isArray(data.missing) ||
    !data.missing.every((item) => typeof item === 'string') ||
    (data.lastSuccessAt !== null &&
      (typeof data.lastSuccessAt !== 'string' || !Number.isFinite(Date.parse(data.lastSuccessAt))))
  )
    throw new Error('同步进度格式无效。');
  for (const key of [
    'pending',
    'completed',
    ...(data.unavailable === undefined ? [] : ['unavailable']),
  ]) {
    if (!Array.isArray(data[key])) throw new Error('同步区间缺失。');
    for (const value of data[key]) {
      const page = object(value);
      if (
        !(
          discovery ? ['income'] : ['trades', 'history', 'algoHistory', 'income', 'forceOrders']
        ).includes(String(page.source)) ||
        !Number.isSafeInteger(page.startTime) ||
        !Number.isSafeInteger(page.endTime) ||
        Number(page.startTime) <= 0 ||
        Number(page.endTime) < Number(page.startTime) ||
        !Number.isSafeInteger(page.page) ||
        Number(page.page) < 1
      )
        throw new Error('同步区间格式无效。');
    }
  }
  if (data.status === 'complete' && Array.isArray(data.pending) && data.pending.length)
    throw new Error('同步完成状态与分页进度不一致。');
  return data as SyncState;
}

function validateArchive(value: unknown, accountId?: string | null): ArchiveProgress {
  const data = object(value);
  if (
    data.source !== 'binance' ||
    typeof data.accountId !== 'string' ||
    !/^[1-9]\d{0,23}$/.test(data.accountId) ||
    (accountId && data.accountId !== accountId) ||
    !['running', 'complete', 'failed', 'interrupted'].includes(String(data.status)) ||
    !Number.isSafeInteger(data.startTime) ||
    Number(data.startTime) <= 0 ||
    !Number.isSafeInteger(data.endTime) ||
    Number(data.endTime) < Number(data.startTime) ||
    (data.lastSuccessAt !== null &&
      (typeof data.lastSuccessAt !== 'string' || !Number.isFinite(Date.parse(data.lastSuccessAt))))
  )
    throw new Error('全账户归档身份或进度无效。');
  for (const key of ['symbols', 'pendingSymbols', 'completedSymbols', 'missing', 'scopeMissing']) {
    const values = data[key];
    if (
      !Array.isArray(values) ||
      !values.every((value) => typeof value === 'string') ||
      ((key.includes('Symbols') || key === 'symbols') &&
        (new Set(values).size !== values.length ||
          !values.every((value) => /^[\p{L}\p{N}_]{1,30}USDT$/u.test(value))))
    )
      throw new Error('全账户归档范围无效。');
  }
  const result = data as ArchiveProgress;
  validateSync(result.discovery, true);
  if (
    !Array.isArray(result.contracts) ||
    result.contracts.some((value) => !result.symbols.includes(validateSync(value).symbol)) ||
    result.pendingSymbols.some(
      (symbol) => !result.symbols.includes(symbol) || result.completedSymbols.includes(symbol),
    ) ||
    result.completedSymbols.some((symbol) => !result.symbols.includes(symbol)) ||
    (result.status === 'complete' &&
      (result.pendingSymbols.length || result.discovery.status !== 'complete'))
  )
    throw new Error('全账户归档完成状态与范围不一致。');
  return result;
}

export function useReviewPage(source: Source) {
  const list = shallowRef<ReviewList | null>(null);
  const trade = shallowRef<ReviewTrade | null>(null);
  const busy = ref(false);
  const relogin = ref(false);
  const status = ref('正在读取归档…');
  const symbol = ref('BTCUSDT');
  const symbols = shallowRef<string[]>([]);
  const sync = shallowRef<SyncState | null>(null);
  const archive = shallowRef<ArchiveProgress | null>(null);
  const archiveIssue = ref('');
  const evidence = shallowRef<{
    symbol: string;
    records: RawRecord[];
    nextOffset: number | null;
  } | null>(null);
  let sequence = 0;
  let pending: AbortController | undefined;
  let suspended = false;
  let cleanup = () => {};
  let polling: ReturnType<typeof setTimeout> | undefined;

  async function read(
    id?: string,
    startSync = false,
    evidenceOffset?: number,
    fullAccount = false,
  ) {
    if (suspended || relogin.value || document.hidden || !navigator.onLine) return;
    const current = ++sequence;
    clearTimeout(polling);
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    busy.value = true;
    trade.value = null;
    try {
      const requestedSymbol = symbol.value.trim().toUpperCase();
      const response = await fetch(
        startSync
          ? fullAccount
            ? '/api/review/archive'
            : '/api/review/sync'
          : evidenceOffset !== undefined
            ? `/api/review/evidence?symbol=${encodeURIComponent(requestedSymbol)}&offset=${evidenceOffset}`
            : `/api/review/trades${id ? `/${encodeURIComponent(id)}` : ''}`,
        {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          ...(startSync
            ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                  fullAccount ? {} : { symbol: symbol.value.trim().toUpperCase() },
                ),
              }
            : {}),
        },
      );
      if (current !== sequence || controller.signal.aborted) return;
      if (response.status === 401) {
        relogin.value = true;
        throw new Error('登录已过期，请重新登录。');
      }
      const data: unknown = await response.json();
      if (current !== sequence || controller.signal.aborted) return;
      if (!response.ok) {
        if (startSync)
          throw new Error(
            typeof object(data).error === 'string'
              ? String(object(data).error)
              : '同步失败，已有归档保留，请重试。',
          );
        throw new Error('复盘账本读取失败，已有归档保留，请重试。');
      }
      if (startSync) {
        if (fullAccount) {
          archive.value = validateArchive(data, list.value?.accountId);
          archiveIssue.value = '';
        } else sync.value = validateSync(data);
        list.value = null;
        evidence.value = null;
        status.value = fullAccount ? '全账户归档正在运行…' : '正在同步真实历史…';
      } else if (evidenceOffset !== undefined) {
        const next = object(data);
        if (
          next.source !== source ||
          next.accountId !== list.value?.accountId ||
          next.symbol !== requestedSymbol ||
          !Array.isArray(next.records) ||
          (next.nextOffset !== null &&
            (!Number.isSafeInteger(next.nextOffset) || Number(next.nextOffset) <= evidenceOffset))
        )
          throw new Error('原始证据身份或分页无效。');
        for (const value of next.records) {
          const record = object(value);
          if (
            !['trades', 'history', 'algoHistory', 'income', 'forceOrders', 'position'].includes(
              String(record.kind),
            ) ||
            typeof record.id !== 'string' ||
            !Number.isSafeInteger(record.time) ||
            object(record.payload).symbol !== requestedSymbol
          )
            throw new Error('原始证据格式无效。');
        }
        evidence.value = next as {
          symbol: string;
          records: RawRecord[];
          nextOffset: number | null;
        };
      } else if (id) {
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
            : !(
                (next.syncStatus === 'not-synced' && next.accountId === null) ||
                (next.syncStatus === 'synced' &&
                  typeof next.accountId === 'string' &&
                  /^[1-9]\d{0,23}$/.test(next.accountId))
              )) ||
          !Array.isArray(next.trades) ||
          (next.accountId === null && next.trades.length)
        )
          throw new Error('复盘来源或同步状态无效。');
        for (const item of next.trades) validateTrade(item, source, String(next.accountId));
        if (list.value?.accountId !== next.accountId) evidence.value = null;
        sync.value = next.sync === undefined || next.sync === null ? null : validateSync(next.sync);
        if (source === 'demo' && sync.value) throw new Error('演示模式不接受真实同步进度。');
        const nextArchive =
          next.archive === undefined || next.archive === null
            ? null
            : validateArchive(next.archive, String(next.accountId));
        if (source === 'demo' && nextArchive) throw new Error('演示模式不接受真实账户归档。');
        let issue = '';
        if (next.archiveIssue !== undefined) {
          const value = object(next.archiveIssue);
          if (
            source !== 'binance' ||
            typeof value.code !== 'string' ||
            typeof value.message !== 'string' ||
            typeof value.attemptedAt !== 'string' ||
            !Number.isFinite(Date.parse(value.attemptedAt))
          )
            throw new Error('后台归档失败状态无效。');
          issue = `${value.message}（尝试时间：${new Date(value.attemptedAt).toLocaleString('zh-CN', { hour12: false })}）`;
        }
        archive.value = nextArchive;
        archiveIssue.value = issue;
        list.value = next as ReviewList;
      }
      if (!startSync)
        status.value =
          source === 'demo'
            ? '演示归档 · 不是真实交易'
            : archiveIssue.value
              ? `后台归档暂停 · ${archiveIssue.value}`
              : archive.value
                ? {
                    running: '全账户归档正在运行…',
                    complete: '全账户读取结束 · 完整性按合约与交易分别确认',
                    failed: '全账户归档失败 · 已有进度保留，下一轮补查',
                    interrupted: '全账户归档中断 · 服务恢复后补查',
                  }[archive.value.status]
                : sync.value
                  ? {
                      running: '正在同步真实历史…',
                      complete: '历史读取结束 · 交易完整性逐笔确认',
                      failed: '同步失败 · 已有归档保留，请再次同步补查',
                      interrupted: '同步中断 · 请再次同步补查',
                    }[sync.value.status]
                  : '尚未同步 · 无真实交易归档';
      if (sync.value?.status === 'running' || archive.value?.status === 'running')
        polling = setTimeout(() => void read(), 1000);
      else if (source === 'binance' && !id && evidenceOffset === undefined)
        polling = setTimeout(() => void read(), 5000);
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

  watch(symbol, () => {
    sequence++;
    pending?.abort();
    pending = undefined;
    busy.value = false;
    trade.value = null;
    evidence.value = null;
    clearTimeout(polling);
  });

  function pause(reason: string) {
    suspended = true;
    sequence++;
    clearTimeout(polling);
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
    if (source === 'binance')
      void fetch('/api/symbols', { cache: 'no-store', signal: events.signal })
        .then(async (response) => {
          if (!response.ok) return;
          const data = object(await response.json());
          if (
            Array.isArray(data.symbols) &&
            data.symbols.every(
              (value) => typeof value === 'string' && /^[\p{L}\p{N}_]{1,30}USDT$/u.test(value),
            )
          )
            symbols.value = data.symbols;
        })
        .catch(() => {
          /* The contract can still be entered when suggestions are unavailable. */
        });
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
    symbol,
    symbols,
    sync,
    archive,
    archiveIssue,
    evidence,
    readEvidence: (offset = 0) => read(undefined, false, offset),
    startSync: () => read(undefined, true),
    startArchive: () => read(undefined, true, undefined, true),
    refresh: () => read(),
    open: (id: string) => read(id),
  };
}
