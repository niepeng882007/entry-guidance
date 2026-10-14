import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { parseDecimal } from '../public/draft.js';
import type { readAccountAssets } from '../src/account.ts';

type Assets = Omit<Awaited<ReturnType<typeof readAccountAssets>>, 'source'> & {
  source: 'binance' | 'demo';
};

const coreAmounts = ['equity', 'availableBalance', 'walletBalance', 'unrealizedProfit'] as const;
const detailAmounts = [
  'positionInitialMargin',
  'openOrderInitialMargin',
  'maintMargin',
  'maxWithdrawAmount',
] as const;

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,24}(\.\d{1,8})?$/.test(value))
    throw new Error('账户金额无效，本次快照不可用。');
  return parseDecimal(value.replace('-', ''), '账户金额') * (value.startsWith('-') ? -1n : 1n);
}

function validateAssets(value: unknown, expectedSource: Assets['source']): Assets {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('账户响应无效，请重新查询。');
  const data = value as Record<string, unknown>;
  if (
    data.source !== expectedSource ||
    typeof data.queriedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.queriedAt)) ||
    Math.abs(Date.now() - Date.parse(data.queriedAt)) > 60_000
  )
    throw new Error('账户来源或查询时间无效，本次快照不可用。');
  for (const field of coreAmounts) decimal(data[field]);
  for (const field of detailAmounts) if (data[field] !== null) decimal(data[field]);
  if (decimal(data.equity) !== decimal(data.walletBalance) + decimal(data.unrealizedProfit))
    throw new Error('账户权益与钱包余额、未实现盈亏不一致。');
  return data as Assets;
}

function failureMessage(code: unknown, status: number): string {
  if (code === 'rate_limited' || status === 429 || status === 418)
    return '请求过于频繁，稍后自动重试。';
  switch (code) {
    case 'missing_credentials':
      return '账户尚未连接，请配置只读凭据。';
    case 'access_denied':
      return '账户读取被拒绝，请检查只读凭据和 IP 限制。';
    case 'reading_disabled':
    case 'unverified_permissions':
      return '只读权限未确认，请检查凭据。';
    case 'unsafe_permissions':
      return '请更换专用只读凭据。';
    case 'unsupported_account':
      return '当前账户模式暂不支持。';
    case 'clock_error':
      return '查询时间校验失败，请同步电脑时间后重试。';
    case 'invalid_response':
    case 'scope_unconfirmed':
      return '账户数据异常，请重新查询。';
    case 'timeout':
      return '账户查询超时，请重试。';
    case 'connection_failed':
      return '账户连接失败，请检查网络后重试。';
    default:
      return '刷新失败，请重试。';
  }
}

export function useAccountPage(expectedSource: Assets['source']) {
  const snapshot = shallowRef<Assets | null>(null);
  const attemptedAt = ref('');
  const busy = ref(false);
  const stale = ref(true);
  const relogin = ref(false);
  const status = ref('');
  const errorDetail = ref('');
  const refreshProgress = ref(1);
  const refreshPause = ref('');
  const refreshInterval = 30_000;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let nextRefreshAt = 0;
  let suspended = false;
  let sequence = 0;
  let pending: AbortController | undefined;
  let retryAt = 0;
  let retryMessage = '';
  let retryDetail = '';
  let assetRetryAt = 0;

  function showFailure(message: string, detail = '') {
    stale.value = true;
    status.value = [message, snapshot.value ? '数据待更新。' : ''].filter(Boolean).join(' ');
    errorDetail.value = detail;
  }

  function updateCountdown() {
    if (!nextRefreshAt) return;
    refreshProgress.value = Math.max(
      0,
      Math.min(1, (nextRefreshAt - performance.now()) / refreshInterval),
    );
    refreshPause.value = Date.now() < retryAt ? '限流暂停' : '';
  }

  function stopCountdown() {
    clearTimeout(refreshTimer);
    nextRefreshAt = 0;
  }

  function scheduleRefresh(delay = Math.max(refreshInterval, retryAt - Date.now())) {
    stopCountdown();
    nextRefreshAt = performance.now() + delay;
    updateCountdown();
    refreshTimer = setTimeout(() => void refresh(true), delay);
  }

  async function refresh(automatic = false) {
    if (
      busy.value ||
      suspended ||
      relogin.value ||
      document.hidden ||
      !navigator.onLine ||
      Date.now() < retryAt
    )
      return;
    stopCountdown();
    refreshPause.value = '';
    const id = ++sequence;
    const controller = new AbortController();
    pending = controller;
    busy.value = true;
    if (Date.now() >= assetRetryAt) {
      status.value = snapshot.value && stale.value ? '数据待更新。' : '';
      errorDetail.value = '';
    }
    let summary = '刷新失败，请重试。';
    let scopeInvalid = false;
    const current = () => id === sequence && !controller.signal.aborted && !scopeInvalid;
    function revokeScope(reason: string) {
      scopeInvalid = true;
      showFailure(summary, reason);
    }
    async function request(): Promise<unknown> {
      attemptedAt.value = new Date().toISOString();
      const response = await fetch('/api/account/assets', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        cache: 'no-store',
        headers: automatic ? { 'X-Account-Refresh': 'automatic' } : {},
      });
      if (id !== sequence || controller.signal.aborted) throw new Error('查询已取消。');
      if (response.status === 401) {
        relogin.value = true;
        pause('登录已过期，请重新登录。');
        throw new Error('登录已过期，请重新登录。');
      }
      const data: unknown = await response.json();
      if (!current()) throw new Error('查询已取消。');
      const meta = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      if (typeof meta.attemptedAt === 'string' && Number.isFinite(Date.parse(meta.attemptedAt))) {
        attemptedAt.value = meta.attemptedAt;
      }
      summary = failureMessage(meta.code, response.status);
      const retry =
        typeof meta.retryAt === 'string' && Number.isFinite(Date.parse(meta.retryAt))
          ? ' 稍后自动重试。'
          : '';
      if (retry && summary === '刷新失败，请重试。') summary = '刷新失败，稍后自动重试。';
      else if (retry && !summary.includes('稍后自动重试')) summary += retry;
      if (!response.ok && typeof meta.retryAt === 'string') {
        const until = Date.parse(meta.retryAt);
        if (Number.isFinite(until)) {
          if (meta.code === 'rate_limited' || response.status === 429 || response.status === 418) {
            retryAt = Math.max(retryAt, until);
            retryMessage = summary;
            retryDetail = typeof meta.error === 'string' ? meta.error : '';
          } else assetRetryAt = Math.max(assetRetryAt, until);
        }
      }
      if (
        meta.scopeConfirmed === false ||
        (meta.source !== undefined && meta.source !== expectedSource)
      ) {
        if (response.ok || typeof meta.code !== 'string') {
          summary = failureMessage('invalid_response', response.status);
          if (retry && !summary.includes('稍后自动重试')) summary += retry;
        }
        revokeScope(typeof meta.error === 'string' ? meta.error : '账户来源无效，无法确认。');
        throw new Error('账户来源或口径未确认。');
      }
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : '账户读取失败，请稍后重试。';
        throw new Error(message);
      }
      if (relogin.value) throw new Error('登录已过期，请重新登录。');
      return data;
    }
    async function assetsRead() {
      if (Date.now() < assetRetryAt) {
        showFailure('稍后自动重试。');
        return;
      }
      try {
        const data = await request();
        if (!current()) return;
        summary = '账户数据异常，请重新查询。';
        const next = validateAssets(data, expectedSource);
        if (snapshot.value && Date.parse(next.queriedAt) < Date.parse(snapshot.value.queriedAt))
          throw new Error('账户响应早于上次成功查询，本次快照不可用。');
        snapshot.value = next;
        stale.value = false;
        status.value = '';
        errorDetail.value = '';
      } catch (error) {
        if (!current()) return;
        if (error instanceof Error && error.name === 'TimeoutError')
          summary = '账户查询超时，请重试。';
        showFailure(summary, error instanceof Error ? error.message : '');
      }
    }
    try {
      await assetsRead();
    } finally {
      if (pending === controller) {
        pending = undefined;
        busy.value = false;
        if (!suspended && !relogin.value) scheduleRefresh();
      }
    }
  }

  function pause(reason = '', detail = '') {
    suspended = true;
    stopCountdown();
    refreshPause.value = '已暂停';
    sequence++;
    pending?.abort();
    pending = undefined;
    busy.value = false;
    showFailure(reason, detail);
  }

  function resume() {
    if (document.hidden || !navigator.onLine || relogin.value) return;
    if (Date.now() < retryAt) pause(retryMessage, retryDetail);
    suspended = false;
    if (Date.now() < retryAt) scheduleRefresh(retryAt - Date.now());
    else void refresh();
  }

  let cleanup = () => {};
  onMounted(() => {
    const events = new AbortController();
    const options = { signal: events.signal };
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) pause();
        else resume();
      },
      options,
    );
    window.addEventListener('offline', () => pause('网络已断开。'), options);
    window.addEventListener('online', resume, options);
    window.addEventListener('pagehide', () => pause(), options);
    window.addEventListener('pageshow', resume, options);
    const timer = setInterval(updateCountdown, 100);
    cleanup = () => {
      events.abort();
      clearInterval(timer);
      pause();
    };
    if (!navigator.onLine) pause('网络已断开。');
    else if (document.hidden) pause();
    else resume();
  });
  onUnmounted(() => cleanup());

  return {
    snapshot,
    attemptedAt,
    busy,
    stale,
    relogin,
    status,
    errorDetail,
    refreshProgress,
    refreshPause,
    refresh,
  };
}
