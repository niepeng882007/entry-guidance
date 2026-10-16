'use client';
import { useEffect, useRef, useState } from 'react';
import {
  generateDraft,
  generateEntryPreview,
  type EntryInput,
  type Snapshot,
} from '../../../public/draft.js';
import type { SavedEntryPlan } from '../../../src/bindings/entry.ts';
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
  const invalidate = (message: string) => {
    setCurrent(false);
    setReason(message);
    setCopied('');
  };
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
      if (!input.symbol || document.hidden || !navigator.onLine) return;
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
        setReason('行情读取失败，请显式重新生成。');
        if (cause instanceof BusinessRequestError && cause.status === 401) onIdentityInvalid();
        else setError(cause instanceof Error ? cause.message : '行情读取失败。');
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(() => void load(), 10000);
        }
      }
    };
    timer = setTimeout(() => void load(), 500);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, userId, binding, simulation, onIdentityInvalid, reload]);
  useEffect(() => {
    if (!saved) return;
    if (
      account.stale ||
      !account.snapshot ||
      amounts.some((key) => account.snapshot![key] !== saved.plan.account[key])
    ) {
      setCurrent(false);
      setReason('账户数据已变化或待更新，请显式重新生成。');
    }
  }, [account.snapshot, account.stale, saved]);
  useEffect(() => {
    const expire = () => {
      if (
        saved &&
        Date.now() -
          Math.min(
            Date.parse(saved.plan.accountTime),
            Date.parse(saved.plan.bookTime),
            Date.parse(saved.plan.markTime),
          ) >=
          30000
      ) {
        setCurrent(false);
        setReason('原卡查询数据已过期，请显式重新生成。');
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
      setBusy(false);
      setMarket(null);
      setCurrent(false);
      setReason('网络已断开，请联网后显式重新生成。');
    };
    const online = () => setReload((value) => value + 1);
    const timer = setInterval(expire, 1000);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      clearInterval(timer);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [saved, market]);
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
    setBusy(false);
    setMarket(null);
    invalidate('输入已修改，原方案保持不变，请显式重新生成。');
    setInput((previous) => ({
      ...previous,
      [key]: value,
      ...(key === 'symbol' && previous.stopMode === 'price' ? { stop: '' } : {}),
    }));
  }
  let draft: ReturnType<typeof generateDraft> | null = null;
  let preview: ReturnType<typeof generateEntryPreview> | null = null;
  let draftError = '选择合约并填写本次计划。';
  if (market) {
    try {
      draft = generateDraft(input, market);
      draftError = '';
      preview = generateEntryPreview(input, market);
    } catch (cause) {
      draftError = cause instanceof Error ? cause.message : '输入尚未完整。';
    }
  }
  async function generate() {
    if (generating.current || !navigator.onLine || document.hidden) return;
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
  async function copy(value: string) {
    if (!current || !saved || document.hidden || !navigator.onLine) return;
    if (
      Date.now() -
        Math.min(
          Date.parse(saved.plan.accountTime),
          Date.parse(saved.plan.bookTime),
          Date.parse(saved.plan.markTime),
        ) >=
      30000
    ) {
      invalidate('原卡查询数据已过期，请显式重新生成。');
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
    invalidate('已请求刷新，请显式重新生成。');
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
  };
}
