'use client';
import { useEffect, useRef, useState } from 'react';
import {
  generateDraft,
  generateEntryPreview,
  type EntryInput,
  type Snapshot,
} from '../../../public/draft.js';
import type { SavedEntryPlan, CheckedEntryPlan } from '../../../src/bindings/entry.ts';
import type { Verification } from '../../../src/verification.ts';
import type { BindingMetadata } from '../dashboard/connections-form.tsx';
import {
  businessRequest,
  BusinessRequestError,
  requestBusinessGrant,
} from '../dashboard/business-request.ts';
import { useAccountSnapshot } from '../account/use-account-snapshot.ts';

const initial: EntryInput = {
  symbol: '',
  side: '',
  entryType: 'MARKET',
  stopLevels: 'single',
  budgetMode: 'amount',
  budget: '',
  stopMode: 'percent',
  stop: '',
  leverage: '',
  slippage: '',
  funding: '',
  minimumBuffer: '',
  fundingCap: '',
};
const amounts = ['equity', 'availableBalance', 'walletBalance', 'unrealizedProfit'] as const;
export interface EntryProps {
  userId: string;
  binding: BindingMetadata;
  simulation?: boolean;
  onIdentityInvalid: () => void;
}
export function useEntryPlan({
  userId,
  binding,
  simulation = false,
  onIdentityInvalid,
}: EntryProps) {
  const [input, setInput] = useState(initial);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [market, setMarket] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState<SavedEntryPlan | null>(null);
  const [current, setCurrent] = useState(false);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState('');
  const [verification, setVerification] = useState<Verification | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [storageError, setStorageError] = useState('');
  const [restoring, setRestoring] = useState(true);
  const [checking, setChecking] = useState(false);
  const [automatic, setAutomatic] = useState(0);
  const checkedTime = verification?.entryCheck?.queriedAt ?? verification?.queriedAt;
  const currentAt = checkedTime
    ? Date.parse(checkedTime)
    : saved
      ? Math.min(
          Date.parse(saved.plan.accountTime),
          Date.parse(saved.plan.bookTime),
          Date.parse(saved.plan.markTime),
        )
      : 0;
  const storageBlocked = useRef(false);
  const check = useRef<() => Promise<void>>(async () => {});
  const storageKey = `entry-current:${JSON.stringify([userId, binding.id, binding.uid, binding.source, simulation])}`;
  const sequence = useRef(0);
  const generating = useRef<AbortController | null>(null);
  const card = useRef<HTMLElement | null>(null);
  const account = useAccountSnapshot({
    userId,
    binding,
    simulation,
    summary: true,
    onIdentityInvalid,
  });
  const accountState =
    account.stale || !account.snapshot
      ? ''
      : JSON.stringify(amounts.map((key) => account.snapshot![key]));
  const invalidate = (message: string) => {
    setCurrent(false);
    setVerification(null);
    setReason(message);
    setCopied('');
  };
  function remember(nextInput: EntryInput, plan: SavedEntryPlan | null, queriedAt = lastQuery) {
    if (storageBlocked.current) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ input: nextInput, planId: plan?.plan.id ?? null, queriedAt }),
      );
      setStorageError('');
    } catch {
      setStorageError('本浏览器保存失败；刷新或离开可能无法继续本单。原方案仍保留在服务端。');
    }
  }
  const matches = (left: EntryInput, right: EntryInput) =>
    Object.keys(initial).every(
      (key) => (left[key as keyof EntryInput] ?? '') === (right[key as keyof EntryInput] ?? ''),
    );
  const continuing = Boolean(saved && matches(input, saved.input));
  const checkOwner = (value: Pick<SavedEntryPlan, 'userId' | 'binding'>) => {
    if (
      value.userId !== userId ||
      value.binding.id !== binding.id ||
      value.binding.uid !== binding.uid ||
      value.binding.source !== binding.source ||
      value.binding.credentialVersion !== binding.credentialVersion ||
      value.binding.authorizationVersion !== binding.authorizationVersion
    )
      throw new BusinessRequestError(401, '账户连接已变化，请重新登录。');
  };
  useEffect(() => {
    const controller = new AbortController();
    const version = ++sequence.current;
    async function restore() {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return;
        let local: { input: EntryInput; planId: string | null; queriedAt: string };
        try {
          local = JSON.parse(raw) as typeof local;
          if (
            !local ||
            !local.input ||
            typeof local.input !== 'object' ||
            Object.keys(local.input).some(
              (key) =>
                !(key in initial) || typeof local.input[key as keyof EntryInput] !== 'string',
            ) ||
            Object.keys(initial).some(
              (key) => typeof local.input[key as keyof EntryInput] !== 'string',
            ) ||
            (local.planId !== null &&
              (typeof local.planId !== 'string' || !/^[a-f0-9-]{36}$/.test(local.planId))) ||
            typeof local.queriedAt !== 'string' ||
            (local.queriedAt !== '' && !Number.isFinite(Date.parse(local.queriedAt)))
          )
            throw new Error('invalid record');
        } catch {
          storageBlocked.current = true;
          setStorageError('本浏览器记录损坏，未覆盖原记录。可明确清除本单记录后重新开始。');
          return;
        }
        setInput(local.input);
        setLastQuery(local.queriedAt);
        if (!local.planId) return;
        const response = await businessRequest(
          `entry/plans/${local.planId}`,
          controller.signal,
          userId,
        );
        const data: SavedEntryPlan = await response.json();
        await requestBusinessGrant('entry:read', controller.signal, userId);
        if (controller.signal.aborted || version !== sequence.current) return;
        if (
          data.userId !== userId ||
          data.binding.id !== binding.id ||
          data.binding.uid !== binding.uid ||
          data.binding.source !== binding.source ||
          data.binding.credentialVersion !== binding.credentialVersion ||
          data.binding.authorizationVersion !== binding.authorizationVersion ||
          data.plan.source !== (simulation ? 'demo' : 'binance')
        )
          throw new BusinessRequestError(401, '恢复账户已变化。');
        setSaved(data);
        setReason('已取回原方案；必须重新查询，旧通过状态不会恢复。');
        setAutomatic((value) => value + 1);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof BusinessRequestError && cause.status === 401) onIdentityInvalid();
        else
          setStorageError(
            cause instanceof Error ? `本单恢复失败：${cause.message}` : '本单恢复失败。',
          );
      } finally {
        if (!controller.signal.aborted) setRestoring(false);
      }
    }
    void restore();
    return () => controller.abort();
  }, [storageKey, userId, binding, simulation, onIdentityInvalid]);
  useEffect(() => {
    const controller = new AbortController();
    void businessRequest(
      'entry/symbols',
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      userId,
    )
      .then(async (response) => {
        const data: { symbols: string[]; userId: string; binding: BindingMetadata } =
          await response.json();
        if (controller.signal.aborted) return;
        if (data.userId !== userId || data.binding.id !== binding.id)
          throw new BusinessRequestError(401, '账户连接已变化。');
        setSymbols(data.symbols);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof BusinessRequestError && cause.status === 401) onIdentityInvalid();
        else setError(cause instanceof Error ? cause.message : '合约读取失败。');
      });
    return () => controller.abort();
  }, [userId, binding, onIdentityInvalid, reload]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (continuing || !input.symbol || !accountState || document.hidden || !navigator.onLine)
        return;
      setLoading(true);
      setMarket(null);
      try {
        const response = await businessRequest(
          `entry/market?symbol=${encodeURIComponent(input.symbol)}`,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          userId,
        );
        const data: Snapshot & { userId: string; binding: BindingMetadata } = await response.json();
        await requestBusinessGrant('entry:read', controller.signal, userId);
        if (!active) return;
        if (
          data.userId !== userId ||
          data.binding.id !== binding.id ||
          data.binding.credentialVersion !== binding.credentialVersion ||
          data.binding.authorizationVersion !== binding.authorizationVersion ||
          data.source !== (simulation ? 'demo' : 'binance')
        )
          throw new BusinessRequestError(401, '账户连接或数据来源已变化。');
        setMarket(data);
        setError('');
      } catch (cause) {
        if (!active) return;
        setCurrent(false);
        setVerification(null);
        setReason('行情读取失败，请重新查询原方案。');
        if (cause instanceof BusinessRequestError && cause.status === 401) onIdentityInvalid();
        else setError(cause instanceof Error ? cause.message : '行情读取失败。');
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(() => void load(), 10000);
        }
      }
    };
    setMarket(null);
    setLoading(false);
    timer = setTimeout(() => void load(), 500);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, userId, binding, simulation, onIdentityInvalid, reload, accountState, continuing]);
  useEffect(() => {
    if (!saved) return;
    const baseline = verification?.account ?? saved.plan.account;
    const generatedAt = Date.parse(verification?.account?.queriedAt ?? saved.plan.accountTime);
    const failedAfterGeneration = account.stale && Date.parse(account.attempted) >= generatedAt;
    const changedAfterGeneration =
      account.snapshot &&
      Date.parse(account.snapshot.queriedAt) > generatedAt &&
      amounts.some((key) => account.snapshot![key] !== baseline[key]);
    if (failedAfterGeneration || changedAfterGeneration) {
      setCurrent(false);
      setVerification(null);
      setReason('账户数据已变化或待更新，请重新查询原方案。');
    }
  }, [account.snapshot, account.stale, account.attempted, saved, verification]);
  useEffect(() => {
    const expire = () => {
      if (currentAt && Date.now() - currentAt >= 30000) {
        setCurrent(false);
        setVerification(null);
        setReason('查询数据已过期，请重新查询原方案。');
      }
      if (
        market &&
        Date.now() - Math.min(Date.parse(market.bookTime), Date.parse(market.markTime)) >= 30000
      )
        setMarket(null);
    };
    const offline = () => {
      sequence.current++;
      generating.current?.abort();
      generating.current = null;
      setBusy(false);
      setChecking(false);
      setMarket(null);
      setCurrent(false);
      setVerification(null);
      setReason('网络已断开，请联网后重新查询原方案。');
    };
    const online = () => {
      setReload((value) => value + 1);
      setAutomatic((value) => value + 1);
    };
    const timer = setInterval(expire, 1000);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      clearInterval(timer);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [currentAt, market]);
  useEffect(
    () => () => {
      sequence.current++;
      generating.current?.abort();
    },
    [],
  );
  function change(key: keyof EntryInput, value: string) {
    sequence.current++;
    generating.current?.abort();
    generating.current = null;
    setBusy(false);
    setChecking(false);
    setMarket(null);
    invalidate('输入已修改，原方案保持不变；请恢复原方案输入后核验。');
    const next = {
      ...input,
      [key]: value,
      ...(key === 'symbol' && input.stopMode === 'price' ? { stop: '' } : {}),
    };
    setInput(next);
    remember(next, saved);
  }
  let draft: ReturnType<typeof generateDraft> | null = null;
  let preview: ReturnType<typeof generateEntryPreview> | null = null;
  let draftError = continuing
    ? '原方案已固定，请查看本次开仓卡并重新查询。'
    : '选择合约并填写本次计划。';
  if (
    market &&
    accountState &&
    account.snapshot &&
    amounts.every((key) => market.account[key] === account.snapshot![key])
  ) {
    try {
      draft = generateDraft(input, market);
      draftError = '';
      preview = generateEntryPreview(input, market);
    } catch (cause) {
      draftError = cause instanceof Error ? cause.message : '输入尚未完整。';
    }
  }
  async function generate() {
    if (restoring || generating.current || !navigator.onLine || document.hidden) return;
    const id = ++sequence.current;
    const controller = new AbortController();
    generating.current = controller;
    setBusy(true);
    setError('');
    invalidate('正在刷新并保存新方案。');
    try {
      const response = await businessRequest(
        'entry/plans',
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        userId,
        input,
      );
      const data: SavedEntryPlan = await response.json();
      await requestBusinessGrant('entry:read', controller.signal, userId);
      if (id !== sequence.current || controller.signal.aborted) return;
      checkOwner(data);
      if (data.plan.source !== (simulation ? 'demo' : 'binance'))
        throw new Error('方案来源不一致。');
      setSaved(data);
      setLastQuery('');
      remember(input, data, '');
      setCurrent(true);
      setReason('已保存固定方案；仅代表生成时点，不代表成交或止损已核验。');
      requestAnimationFrame(() => card.current?.focus());
    } catch (cause) {
      if (id !== sequence.current || controller.signal.aborted) return;
      if (cause instanceof BusinessRequestError && cause.status === 401) onIdentityInvalid();
      else
        setError(cause instanceof Error ? cause.message : '生成或保存失败，没有可执行的新卡片。');
    } finally {
      if (generating.current === controller) generating.current = null;
      if (id === sequence.current) setBusy(false);
    }
  }
  async function verify(restoreInput = false) {
    if (!saved || restoring || generating.current || !navigator.onLine || document.hidden) return;
    if (!restoreInput && !matches(input, saved.input)) return;
    const nextInput = restoreInput ? saved.input : input;
    if (restoreInput) setInput(nextInput);
    const id = ++sequence.current;
    const controller = new AbortController();
    generating.current = controller;
    setChecking(true);
    setError('');
    invalidate('正在重新查询实际持仓、成本与止损。');
    remember(nextInput, saved);
    try {
      const response = await businessRequest(
        `entry/plans/${saved.plan.id}/verify`,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        userId,
        {},
      );
      const data: CheckedEntryPlan = await response.json();
      await requestBusinessGrant('entry:read', controller.signal, userId);
      if (id !== sequence.current || controller.signal.aborted) return;
      checkOwner(data);
      if (
        data.plan.id !== saved.plan.id ||
        data.verification.source !== (simulation ? 'demo' : 'binance') ||
        !Number.isFinite(Date.parse(data.verification.queriedAt)) ||
        Math.abs(Date.now() - Date.parse(data.verification.queriedAt)) >= 30000
      )
        throw new Error('核验归属、来源或查询时间不一致，请重新查询。');
      setVerification(data.verification);
      setLastQuery(data.verification.queriedAt);
      setCurrent(
        data.verification.status === 'waiting' && data.verification.entryCheck?.status === 'ready',
      );
      setReason('原预算与绝对止损保持不变；下方结果仅代表本次查询时点。');
      remember(nextInput, saved, data.verification.queriedAt);
    } catch (cause) {
      if (id !== sequence.current || controller.signal.aborted) return;
      invalidate('核验失败，旧结果已失效；保留原方案，请重试。');
      if (cause instanceof BusinessRequestError && cause.status === 401) onIdentityInvalid();
      else setError(cause instanceof Error ? cause.message : '本单核验失败。');
    } finally {
      if (generating.current === controller) generating.current = null;
      if (id === sequence.current) setChecking(false);
    }
  }
  useEffect(() => {
    check.current = () => verify();
  });
  useEffect(() => {
    if (!automatic || restoring) return;
    void check.current();
  }, [automatic, restoring]);
  useEffect(() => {
    if (!saved || restoring || checking || busy) return;
    const timer = setTimeout(() => void check.current(), 10000);
    return () => clearTimeout(timer);
  }, [saved, input, restoring, checking, busy, automatic]);
  function clearLocal() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      setStorageError('本浏览器清除失败，原记录仍保留。');
      return;
    }
    sequence.current++;
    generating.current?.abort();
    generating.current = null;
    storageBlocked.current = false;
    setStorageError('');
    setSaved(null);
    setInput(initial);
    setLastQuery('');
    setBusy(false);
    setChecking(false);
    invalidate('已清除本浏览器记录，不会改变 Binance 持仓或服务端历史。');
  }
  async function copy(value: string) {
    if (!current || !saved || document.hidden || !navigator.onLine) return;
    if (Date.now() - currentAt >= 30000) {
      invalidate('原卡查询数据已过期，请重新查询原方案。');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied('已复制数值，请核对币种和单位。');
    } catch {
      setCopied('复制失败，请手动选择数值复制。');
    }
  }
  function refresh() {
    invalidate('已请求刷新，原方案需重新核验。');
    setMarket(null);
    setReload((value) => value + 1);
    account.refresh.current();
  }
  return {
    input,
    symbols,
    market,
    error,
    busy,
    loading,
    saved,
    current,
    reason,
    copied,
    card,
    account,
    change,
    draft,
    preview,
    draftError,
    generate,
    copy,
    refresh,
    verification,
    lastQuery,
    storageError,
    restoring,
    checking,
    verify,
    clearLocal,
    inputMatches: saved ? matches(input, saved.input) : false,
  };
}
