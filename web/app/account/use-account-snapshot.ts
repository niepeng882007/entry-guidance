'use client';
import { useEffect, useRef, useState } from 'react';
import { validateAccountAmounts } from '../../../public/account-amounts.ts';
import type { readAccountAssets } from '../../../src/account.ts';
import {
  businessRequest,
  BusinessRequestError,
  requestBusinessGrant,
} from '../dashboard/business-request.ts';
import type { BindingMetadata } from '../dashboard/connections-form.tsx';

type Assets = Awaited<ReturnType<typeof readAccountAssets>>;
type Snapshot = Pick<
  Assets,
  'equity' | 'availableBalance' | 'walletBalance' | 'unrealizedProfit' | 'queriedAt'
> &
  Partial<
    Pick<
      Assets,
      'positionInitialMargin' | 'openOrderInitialMargin' | 'maintMargin' | 'maxWithdrawAmount'
    >
  >;
function validate(
  value: unknown,
  userId: string,
  binding: BindingMetadata,
  simulation: boolean,
  summary: boolean,
): Snapshot {
  if (!value || typeof value !== 'object') throw new Error('账户响应无效。');
  const data = value as Record<string, unknown>;
  const owner = data.binding as BindingMetadata | undefined;
  if (
    data.userId !== userId ||
    !owner ||
    owner.id !== binding.id ||
    owner.uid !== binding.uid ||
    owner.source !== binding.source ||
    owner.credentialVersion !== binding.credentialVersion ||
    owner.authorizationVersion !== binding.authorizationVersion
  )
    throw new BusinessRequestError(401, '账户连接已变化，请重新登录。');
  if (
    data.source !== (simulation ? 'demo' : 'binance') ||
    typeof data.queriedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.queriedAt)) ||
    Math.abs(Date.now() - Date.parse(data.queriedAt)) > 60000
  )
    throw new Error('账户来源或查询时间无效。');
  validateAccountAmounts(data, !summary);
  return data as Snapshot;
}
export function useAccountSnapshot({
  userId,
  binding,
  simulation = false,
  summary = false,
  onIdentityInvalid,
}: {
  userId: string;
  binding: BindingMetadata;
  simulation?: boolean;
  summary?: boolean;
  onIdentityInvalid: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [attempted, setAttempted] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(true);
  const [message, setMessage] = useState('');
  const [errorDetail, setErrorDetail] = useState('');
  const [relogin, setRelogin] = useState(false);
  const [progress, setProgress] = useState(1);
  const [paused, setPaused] = useState('');
  const refresh = useRef<() => void>(() => {});
  const interval = summary ? 3000 : 30000;
  useEffect(() => {
    let active = true,
      sequence = 0,
      retryAt = 0,
      nextAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: AbortController | undefined;
    let latest: Snapshot | null = null;
    let expired = false;
    const pause = (clear = false) => {
      sequence++;
      clearTimeout(timer);
      nextAt = 0;
      pending?.abort();
      pending = undefined;
      setBusy(false);
      setStale(true);
      setPaused('已暂停');
      if (clear) {
        latest = null;
        setSnapshot(null);
        setAttempted('');
        setErrorDetail('');
      }
    };
    const schedule = () => {
      const delay = Math.max(interval, retryAt - Date.now());
      nextAt = performance.now() + delay;
      timer = setTimeout(() => void load(true), delay);
    };
    const load = async (automatic = false) => {
      if (
        !active ||
        expired ||
        pending ||
        document.hidden ||
        !navigator.onLine ||
        Date.now() < retryAt
      )
        return;
      clearTimeout(timer);
      nextAt = 0;
      const id = ++sequence;
      const controller = new AbortController();
      pending = controller;
      setBusy(true);
      setPaused('');
      setMessage('');
      setErrorDetail('');
      setAttempted(new Date().toISOString());
      try {
        const response = await businessRequest(
          summary ? 'account/summary' : 'account/assets',
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          userId,
          automatic,
        );
        const data: unknown = await response.json();
        // Cookies can change in another tab before its identity broadcast arrives.
        await requestBusinessGrant(
          'account:read',
          AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          userId,
        );
        if (!active || id !== sequence || controller.signal.aborted) return;
        const next = validate(data, userId, binding, simulation, summary);
        if (latest && Date.parse(next.queriedAt) < Date.parse(latest.queriedAt))
          throw new Error('账户响应早于上次成功查询。');
        latest = next;
        setSnapshot(next);
        setStale(false);
        setMessage('');
        const attemptedAt = (data as { attemptedAt?: string }).attemptedAt;
        if (attemptedAt && Number.isFinite(Date.parse(attemptedAt))) setAttempted(attemptedAt);
      } catch (error) {
        if (!active || id !== sequence || controller.signal.aborted) return;
        if (error instanceof BusinessRequestError && error.status === 401) {
          expired = true;
          pause(true);
          setRelogin(true);
          setMessage('登录或账户连接已变化，请重新登录。');
          onIdentityInvalid();
          return;
        }
        setStale(true);
        let reason = '账户数据异常，请重新查询。';
        if (error instanceof BusinessRequestError) {
          const retry = Date.parse(error.retryAt ?? '');
          if (Number.isFinite(retry)) retryAt = Math.max(retryAt, retry);
          if (error.attemptedAt && Number.isFinite(Date.parse(error.attemptedAt)))
            setAttempted(error.attemptedAt);
          reason =
            error.code === 'rate_limited'
              ? '请求过于频繁，稍后自动重试。'
              : error.code === 'timeout'
                ? '账户查询超时，请重试。'
                : error.code === 'access_denied'
                  ? '账户读取被拒绝，请检查只读凭据和 IP 限制。'
                  : error.status === 409
                    ? '请先连接只读 Binance 账户。'
                    : '账户查询失败，稍后自动重试。';
        } else if (error instanceof Error && error.name === 'TimeoutError')
          reason = '账户查询超时，请重试。';
        setMessage(reason + (latest ? ' 数据待更新。' : ''));
        setErrorDetail(error instanceof Error ? error.message : '');
      } finally {
        if (active && id === sequence) {
          pending = undefined;
          setBusy(false);
          if (!expired && !document.hidden && navigator.onLine) schedule();
        }
      }
    };
    const resume = () => {
      if (document.hidden || !navigator.onLine || expired) return;
      if (Date.now() < retryAt) {
        clearTimeout(timer);
        nextAt = performance.now() + retryAt - Date.now();
        timer = setTimeout(() => void load(), retryAt - Date.now());
      } else void load();
    };
    const visibility = () => {
      if (document.hidden) pause(true);
      else resume();
    };
    const offline = () => {
      pause();
      setMessage(`网络已断开。${latest ? ' 数据待更新。' : ''}`);
    };
    const hide = () => pause(true);
    const identity = () => {
      expired = true;
      pause(true);
      setRelogin(true);
      setMessage('登录身份已变化，请重新登录。');
    };
    const bus = new BroadcastChannel('workbench-identity');
    bus.onmessage = identity;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', offline);
    window.addEventListener('online', resume);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', resume);
    const ring = setInterval(() => {
      if (nextAt) {
        setProgress(Math.max(0, Math.min(1, (nextAt - performance.now()) / interval)));
        setPaused(Date.now() < retryAt ? '限流暂停' : '');
      }
    }, 100);
    refresh.current = () => void load();
    if (!navigator.onLine) offline();
    else resume();
    return () => {
      active = false;
      sequence++;
      clearTimeout(timer);
      clearInterval(ring);
      pending?.abort();
      bus.close();
      refresh.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', resume);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', resume);
    };
  }, [userId, binding, simulation, summary, interval, onIdentityInvalid]);
  return {
    snapshot,
    attempted,
    busy,
    stale,
    message,
    errorDetail,
    relogin,
    progress,
    paused,
    refresh,
    interval,
  };
}
