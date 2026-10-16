'use client';
import { useEffect, useRef, useState } from 'react';
import {
  readReviewLocation,
  reviewUrl,
  type ReviewLocation,
} from '../../../frontend/review-records.ts';
import type { ReviewTrade, ReviewSummary } from '../../../src/review-ledger.ts';
import type { BindingMetadata } from '../dashboard/connections-form.tsx';
import { businessRequest, BusinessRequestError } from '../dashboard/business-request.ts';

type Owner = {
  profile: { id: string; name: string; email: string; simulation?: boolean };
  binding: BindingMetadata | null;
};
export type ReviewData = {
  userId: string;
  binding: BindingMetadata;
  source: 'demo' | 'binance';
  readAt: string;
  coverage: string;
} & (
  | { trade: ReviewTrade }
  | {
      trades: ReviewSummary[];
      total: number;
      page: number;
      pageSize: number;
      nextPage: number | null;
      options: { symbols: string[] };
    }
);
function sameBinding(a: BindingMetadata | null, b: BindingMetadata | null) {
  return (
    a?.id === b?.id &&
    a?.uid === b?.uid &&
    a?.source === b?.source &&
    a?.authorizationVersion === b?.authorizationVersion &&
    a?.credentialVersion === b?.credentialVersion
  );
}
export function useReviewBrowser() {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<ReviewData | null>(null);
  const [location, setLocation] = useState<ReviewLocation>({
    view: 'cycles',
    tradeId: null,
    from: '',
    to: '',
    symbol: '',
    page: 1,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const actions = useRef<{
    read: () => void;
    navigate: (next: ReviewLocation) => void;
    logout: () => void;
  }>({ read: () => {}, navigate: () => {}, logout: () => {} });
  useEffect(() => {
    let active = true,
      signedOut = false,
      generation = 0;
    let currentOwner: Owner | null = null;
    let pending: AbortController | undefined;
    let currentLocation = readReviewLocation(new URL(window.location.href));
    let listScroll = 0;
    let pausedScroll: number | null = null;
    let navigation = false;
    const bus = new BroadcastChannel('workbench-identity');
    setLocation(currentLocation);
    function cancel() {
      generation++;
      pending?.abort();
      pending = undefined;
      if (active) setBusy(false);
    }
    function identityLost() {
      signedOut = true;
      cancel();
      currentOwner = null;
      setOwner(null);
      setData(null);
      setVisible(false);
      window.location.replace('/login');
    }
    async function identity(signal: AbortSignal): Promise<Owner> {
      const profile: Owner['profile'] = await (await businessRequest('profile', signal)).json();
      if (currentOwner && profile.id !== currentOwner.profile.id)
        throw new BusinessRequestError(401, '登录身份已变化，请重新登录。');
      const { binding } = (await (await businessRequest('binding', signal, profile.id)).json()) as {
        binding: BindingMetadata | null;
      };
      return { profile, binding };
    }
    function showIdentity(next: Owner) {
      if (currentOwner && !sameBinding(currentOwner.binding, next.binding)) {
        setData(null);
        setMessage('账户连接已变化，请重新读取。');
      }
      currentOwner = next;
      setOwner(next);
      setVisible(true);
    }
    async function run(read: boolean) {
      if (!active || signedOut || document.hidden) return;
      if (!navigator.onLine) {
        setMessage('网络已断开；联网后请重新读取。');
        return;
      }
      cancel();
      const version = generation;
      const controller = new AbortController();
      pending = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      setBusy(true);
      if (read) setMessage('');
      try {
        const next = await identity(signal);
        if (!active || version !== generation) return;
        showIdentity(next);
        if (!read || !next.binding) {
          if (pausedScroll !== null) {
            const scroll = pausedScroll;
            pausedScroll = null;
            requestAnimationFrame(() => {
              if (active && version === generation) window.scrollTo(0, scroll);
            });
          }
          return;
        }
        const query = new URLSearchParams(window.location.search);
        if (query.get('view') === 'cycles') query.delete('view');
        const suffix = currentLocation.tradeId
          ? `/${encodeURIComponent(currentLocation.tradeId)}`
          : query.size
            ? `?${query}`
            : '';
        const response = await businessRequest(
          `review/${next.binding.id}/trades${suffix}`,
          signal,
          next.profile.id,
        );
        const result = (await response.json()) as ReviewData;
        // Recheck the cookie identity and binding after a possibly delayed private response.
        const check = await identity(signal);
        if (!active || version !== generation || controller.signal.aborted) return;
        if (
          result.userId !== check.profile.id ||
          !sameBinding(result.binding, check.binding) ||
          !sameBinding(next.binding, check.binding)
        )
          throw new BusinessRequestError(401, '账户连接已变化，请重新登录。');
        if (
          result.source !== (next.profile.simulation ? 'demo' : 'binance') ||
          !Number.isFinite(Date.parse(result.readAt))
        )
          throw new Error('账本响应来源或读取时间无效。');
        setData(result);
        if (navigation) {
          navigation = false;
          requestAnimationFrame(() => {
            if (!active || version !== generation) return;
            if (!currentLocation.tradeId) window.scrollTo(0, listScroll);
          });
        }
      } catch (cause) {
        if (!active || version !== generation || controller.signal.aborted) return;
        if (cause instanceof BusinessRequestError && cause.status === 401) {
          identityLost();
          return;
        }
        setMessage(
          (cause instanceof Error ? cause.message : '读取失败，请重试。') +
            ' 已有内容为上次读取结果。',
        );
        if (!read) setVisible(false);
      } finally {
        if (active && version === generation) {
          pending = undefined;
          setBusy(false);
        }
      }
    }
    function navigate(next: ReviewLocation, pop = false) {
      if (!currentLocation.tradeId && next.tradeId) listScroll = window.scrollY;
      if (!next.tradeId && !currentLocation.tradeId) listScroll = 0;
      navigation = true;
      currentLocation = next;
      if (!pop) window.history.pushState(null, '', reviewUrl(next));
      setLocation(next);
      setData(null);
      void run(true);
    }
    function pause() {
      pausedScroll = window.scrollY;
      if (pending) setMessage('读取已取消，请重新读取。');
      cancel();
      setVisible(false);
    }
    const visibility = () => {
      if (document.hidden) pause();
      else void run(false);
    };
    const focus = () => {
      if (!pending) void run(false);
    };
    const offline = () => {
      cancel();
      setMessage('网络已断开；已有内容为上次读取结果，联网后请重新读取。');
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) void run(false);
    };
    const pop = () => navigate(readReviewLocation(new URL(window.location.href)), true);
    async function logout() {
      signedOut = true;
      cancel();
      setData(null);
      setOwner(null);
      setVisible(false);
      bus.postMessage('changed');
      try {
        const response = await fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) throw new Error();
        window.location.replace('/login');
      } catch {
        setMessage('退出尚未完成，请重试；私有资料已隐藏。');
      }
    }
    actions.current = {
      read: () => {
        if (!pending) void run(true);
      },
      navigate,
      logout: () => void logout(),
    };
    bus.onmessage = identityLost;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pause);
    window.addEventListener('pageshow', show);
    window.addEventListener('focus', focus);
    window.addEventListener('offline', offline);
    window.addEventListener('popstate', pop);
    void run(true);
    return () => {
      active = false;
      cancel();
      bus.close();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pause);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('focus', focus);
      window.removeEventListener('offline', offline);
      window.removeEventListener('popstate', pop);
    };
  }, []);
  return { owner, visible, data, location, busy, message, actions };
}
