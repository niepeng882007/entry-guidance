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
    Math.abs(Date.now() - Date.parse(data.queriedAt)) > 30_000
  )
    throw new Error('账户来源或查询时间无效，本次快照不可用。');
  for (const field of coreAmounts) decimal(data[field]);
  for (const field of detailAmounts) if (data[field] !== null) decimal(data[field]);
  if (decimal(data.equity) !== decimal(data.walletBalance) + decimal(data.unrealizedProfit))
    throw new Error('账户权益与钱包余额、未实现盈亏不一致。');
  return data as Assets;
}

export function useAccountPage(expectedSource: Assets['source']) {
  const snapshot = shallowRef<Assets | null>(null);
  const attemptedAt = ref('');
  const busy = ref(false);
  const stale = ref(true);
  const relogin = ref(false);
  const status = ref('等待首次查询');
  let suspended = false;
  let sequence = 0;
  let pending: AbortController | undefined;

  async function refresh() {
    if (busy.value || suspended || relogin.value || document.hidden || !navigator.onLine) return;
    const id = ++sequence;
    const controller = new AbortController();
    pending = controller;
    busy.value = true;
    attemptedAt.value = new Date().toISOString();
    try {
      const response = await fetch('/api/account/assets', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        cache: 'no-store',
      });
      if (id !== sequence || controller.signal.aborted) return;
      if (response.status === 401) {
        relogin.value = true;
        throw new Error('登录已过期，请重新登录。');
      }
      const data: unknown = await response.json();
      if (id !== sequence || controller.signal.aborted) return;
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : '账户读取失败，请稍后重试。';
        throw new Error(message);
      }
      const next = validateAssets(data, expectedSource);
      if (snapshot.value && Date.parse(next.queriedAt) < Date.parse(snapshot.value.queriedAt))
        throw new Error('账户响应早于上次成功查询，本次快照不可用。');
      snapshot.value = next;
      stale.value = false;
      status.value = `${expectedSource === 'demo' ? '模拟' : 'Binance '}查询成功 · 仅代表查询时点`;
    } catch (error) {
      if (id !== sequence || controller.signal.aborted) return;
      stale.value = true;
      const reason = error instanceof Error ? error.message : '账户读取失败，请稍后重试。';
      status.value = `${reason} ${snapshot.value ? '上次快照已过期，原数值与成功时间保留。' : '尚无成功数据。'}`;
    } finally {
      if (pending === controller) {
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
    stale.value = true;
    status.value = `${reason} ${snapshot.value ? '上次快照已过期。' : '尚无成功数据。'}`;
  }

  function resume() {
    if (document.hidden || !navigator.onLine || relogin.value) return;
    suspended = false;
    void refresh();
  }

  let cleanup = () => {};
  onMounted(() => {
    const events = new AbortController();
    const options = { signal: events.signal };
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) pause('页面已隐藏，离开期间不监控。');
        else resume();
      },
      options,
    );
    window.addEventListener('offline', () => pause('网络已断开，等待联网后重新查询。'), options);
    window.addEventListener('online', resume, options);
    window.addEventListener('pagehide', () => pause('页面已离开，返回后重新查询。'), options);
    window.addEventListener('pageshow', resume, options);
    const timer = setInterval(() => void refresh(), 3_000);
    cleanup = () => {
      events.abort();
      clearInterval(timer);
      pause('页面已关闭。');
    };
    if (!navigator.onLine) pause('网络已断开，等待联网后重新查询。');
    else if (document.hidden) pause('页面已隐藏，返回后重新查询。');
    else resume();
  });
  onUnmounted(() => cleanup());

  return { snapshot, attemptedAt, busy, stale, relogin, status, refresh };
}
