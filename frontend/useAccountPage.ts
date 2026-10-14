import type { OrdersSnapshot, ConditionalOrdersSnapshot } from '../src/orders.ts';
import { onMounted, onUnmounted, ref, shallowRef, type ShallowRef } from 'vue';
import { parseDecimal } from '../public/draft.js';
import type { readAccountAssets } from '../src/account.ts';
import type {
  Position,
  PositionsSnapshot,
  MarketPart,
  LastPrice,
  Funding,
} from '../src/positions.ts';

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

function queryTime(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    Math.abs(Date.now() - Date.parse(value)) > 30_000
  )
    throw new Error('分项来源或查询时间无效。');
}

function validatePositions(value: unknown, expectedSource: Assets['source']): PositionsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('持仓响应无效。');
  const data = value as Record<string, unknown>;
  if (data.source !== expectedSource || !Array.isArray(data.positions))
    throw new Error('持仓来源或列表无效。');
  queryTime(data.queriedAt);
  const keys = new Set<string>();
  for (const item of data.positions) {
    if (!item || typeof item !== 'object') throw new Error('持仓记录无效。');
    const p = item as Record<string, unknown>;
    if (
      typeof p.symbol !== 'string' ||
      !/^[\p{L}\p{N}_]{1,30}USDT$/u.test(p.symbol) ||
      !['BOTH', 'LONG', 'SHORT'].includes(String(p.positionSide)) ||
      !['LONG', 'SHORT'].includes(String(p.direction)) ||
      (p.positionSide !== 'BOTH' && p.positionSide !== p.direction) ||
      !['cross', 'isolated'].includes(String(p.marginType)) ||
      typeof p.leverage !== 'string' ||
      !/^[1-9]\d{0,2}$/.test(p.leverage)
    )
      throw new Error('持仓标识或模式无效。');
    const key = `${p.symbol}:${p.positionSide}`;
    if (keys.has(key)) throw new Error('持仓记录重复。');
    keys.add(key);
    if (decimal(p.quantity) <= 0n || decimal(p.entryPrice) < 0n || decimal(p.markPrice) < 0n)
      throw new Error('持仓数量或价格无效。');
    decimal(p.unrealizedProfit);
    for (const field of ['notional', 'liquidationPrice', 'breakEvenPrice', 'isolatedWallet'])
      if (p[field] !== null) decimal(p[field]);
    if (
      p.updatedAt !== null &&
      (typeof p.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt)))
    )
      throw new Error('持仓更新时间无效。');
  }
  return data as PositionsSnapshot;
}

function validateOrders(value: unknown, expectedSource: Assets['source']): OrdersSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('普通委托响应无效。');
  const data = value as Record<string, unknown>;
  if (data.source !== expectedSource || !Array.isArray(data.orders))
    throw new Error('普通委托来源或列表无效。');
  queryTime(data.queriedAt);
  const keys = new Set<string>();
  for (const item of data.orders) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('普通委托记录无效。');
    const o = item as Record<string, unknown>;
    if (
      typeof o.symbol !== 'string' ||
      !/^[\p{L}\p{N}_]{1,30}USDT$/u.test(o.symbol) ||
      typeof o.orderId !== 'string' ||
      !/^\d{1,20}$/.test(o.orderId) ||
      BigInt(o.orderId) <= 0n ||
      (o.side !== 'BUY' && o.side !== 'SELL') ||
      (o.positionSide !== 'BOTH' && o.positionSide !== 'LONG' && o.positionSide !== 'SHORT') ||
      (o.type !== 'LIMIT' && o.type !== 'MARKET') ||
      (o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED')
    )
      throw new Error('普通委托标识、类型或状态无效。');
    const key = `${o.symbol}:${o.orderId}`;
    if (keys.has(key)) throw new Error('普通委托记录重复。');
    keys.add(key);
    const original = decimal(o.origQty),
      executed = decimal(o.executedQty),
      remaining = decimal(o.remainingQty);
    if (original <= 0n || executed < 0n || executed > original || remaining !== original - executed)
      throw new Error('普通委托数量或余量无效。');
    for (const field of ['price', 'avgPrice'])
      if (o[field] !== null && decimal(o[field]) < 0n) throw new Error('普通委托价格无效。');
    if (o.reduceOnly !== null && typeof o.reduceOnly !== 'boolean')
      throw new Error('普通委托只减仓设置无效。');
    if (
      o.timeInForce !== null &&
      (typeof o.timeInForce !== 'string' ||
        !['GTC', 'IOC', 'FOK', 'GTX', 'GTD', 'RPI'].includes(o.timeInForce))
    )
      throw new Error('普通委托有效方式无效。');
    for (const field of ['createdAt', 'updatedAt'])
      if (
        o[field] !== null &&
        (typeof o[field] !== 'string' || !Number.isFinite(Date.parse(o[field])))
      )
        throw new Error('普通委托时间无效。');
  }
  return data as OrdersSnapshot;
}

function validateConditionalOrders(
  value: unknown,
  expectedSource: Assets['source'],
): ConditionalOrdersSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('条件委托响应无效。');
  const data = value as Record<string, unknown>;
  if (data.source !== expectedSource || !Array.isArray(data.orders))
    throw new Error('条件委托来源或列表无效。');
  queryTime(data.queriedAt);
  const keys = new Set<string>();
  for (const item of data.orders) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('条件委托记录无效。');
    const o = item as Record<string, unknown>;
    if (
      typeof o.symbol !== 'string' ||
      !/^[\p{L}\p{N}_]{1,30}USDT$/u.test(o.symbol) ||
      typeof o.algoId !== 'string' ||
      !/^\d{1,20}$/.test(o.algoId) ||
      BigInt(o.algoId) <= 0n ||
      (o.side !== 'BUY' && o.side !== 'SELL') ||
      (o.positionSide !== 'BOTH' && o.positionSide !== 'LONG' && o.positionSide !== 'SHORT') ||
      typeof o.type !== 'string' ||
      ![
        'STOP',
        'STOP_MARKET',
        'TAKE_PROFIT',
        'TAKE_PROFIT_MARKET',
        'TRAILING_STOP_MARKET',
      ].includes(o.type) ||
      typeof o.status !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,39}$/.test(o.status)
    )
      throw new Error('条件委托标识、类型或状态无效。');
    const key = `${o.symbol}:${o.algoId}`;
    if (keys.has(key)) throw new Error('条件委托记录重复。');
    keys.add(key);
    for (const field of [
      'quantity',
      'executedQty',
      'remainingQty',
      'price',
      'triggerPrice',
      'activatePrice',
      'callbackRate',
    ])
      if (o[field] !== null && decimal(o[field]) < 0n) throw new Error('条件委托数值无效。');
    for (const field of ['reduceOnly', 'closePosition', 'priceProtect'])
      if (o[field] !== null && typeof o[field] !== 'boolean') throw new Error('条件委托设置无效。');
    if (
      (o.closePosition === true && o.quantity !== null) ||
      (o.closePosition === false && o.quantity === null) ||
      (o.quantity !== null && decimal(o.quantity) <= 0n)
    )
      throw new Error('条件委托数量语义无效。');
    if (
      o.quantity !== null &&
      o.executedQty !== null &&
      (decimal(o.executedQty) > decimal(o.quantity) ||
        o.remainingQty === null ||
        decimal(o.remainingQty) !== decimal(o.quantity) - decimal(o.executedQty))
    )
      throw new Error('条件委托余量无效。');
    if (
      o.quantity !== null &&
      o.remainingQty !== null &&
      decimal(o.remainingQty) > decimal(o.quantity)
    )
      throw new Error('条件委托余量无效。');
    for (const field of ['workingType', 'timeInForce'])
      if (
        o[field] !== null &&
        (typeof o[field] !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(o[field]))
      )
        throw new Error('条件委托参数无效。');
    for (const field of ['createdAt', 'updatedAt'])
      if (
        o[field] !== null &&
        (typeof o[field] !== 'string' || !Number.isFinite(Date.parse(o[field])))
      )
        throw new Error('条件委托时间无效。');
  }
  return data as ConditionalOrdersSnapshot;
}

function validateMarket<T extends LastPrice | Funding>(
  value: unknown,
  kind: 'last' | 'funding',
): MarketPart<T> {
  if (!value || typeof value !== 'object') throw new Error('辅助行情响应无效。');
  const part = value as Record<string, unknown>;
  if (part.status === 'error' && typeof part.error === 'string') return part as MarketPart<T>;
  if (part.status !== 'ok' || !Array.isArray(part.data)) throw new Error('辅助行情状态无效。');
  queryTime(part.queriedAt);
  const symbols = new Set<string>();
  for (const item of part.data) {
    if (!item || typeof item !== 'object') throw new Error('辅助行情记录无效。');
    const row = item as Record<string, unknown>;
    if (
      typeof row.symbol !== 'string' ||
      !/^[\p{L}\p{N}_]{1,30}USDT$/u.test(row.symbol) ||
      symbols.has(row.symbol)
    )
      throw new Error('辅助行情标的无效。');
    symbols.add(row.symbol);
    if (kind === 'last') {
      if (decimal(row.price) < 0n) throw new Error('最新成交价无效。');
    } else if (row.rate !== null) decimal(row.rate);
    for (const field of kind === 'last' ? ['updatedAt'] : ['updatedAt', 'nextFundingAt'])
      if (
        row[field] !== null &&
        (typeof row[field] !== 'string' || !Number.isFinite(Date.parse(row[field])))
      )
        throw new Error('辅助行情时间无效。');
  }
  return part as MarketPart<T>;
}

type MarketState<T> = {
  snapshot: Extract<MarketPart<T>, { status: 'ok' }> | null;
  stale: boolean;
  error: string;
  attemptedAt?: string;
};

export function useAccountPage(expectedSource: Assets['source']) {
  const snapshot = shallowRef<Assets | null>(null);
  const positions = shallowRef<{ queriedAt: string; data: Position[] } | null>(null);
  const positionsStale = ref(true);
  const positionsStatus = ref('等待首次持仓查询');
  const last = shallowRef<MarketState<LastPrice>>({ snapshot: null, stale: true, error: '' });
  const funding = shallowRef<MarketState<Funding>>({ snapshot: null, stale: true, error: '' });
  const orders = shallowRef<OrdersSnapshot | null>(null);
  const ordersStale = ref(true);
  const ordersStatus = ref('等待首次普通委托查询');
  const conditionalOrders = shallowRef<ConditionalOrdersSnapshot | null>(null);
  const conditionalOrdersStale = ref(true);
  const conditionalOrdersStatus = ref('等待首次条件委托查询');
  const attemptedAt = ref('');
  const attempts = ref({ assets: '', positions: '', orders: '', conditionalOrders: '' });
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
    let scopeInvalid = false;
    const current = () => id === sequence && !controller.signal.aborted && !scopeInvalid;
    function revokeScope(reason: string) {
      scopeInvalid = true;
      stale.value = positionsStale.value = ordersStale.value = conditionalOrdersStale.value = true;
      status.value =
        positionsStatus.value =
        ordersStatus.value =
        conditionalOrdersStatus.value =
          `${reason} ${snapshot.value ? '上次数据已过期' : '尚无成功数据'}，账户有效状态已撤销。`;
      last.value = { ...last.value, stale: true };
      funding.value = { ...funding.value, stale: true };
    }
    async function request(path: string, part: keyof typeof attempts.value): Promise<unknown> {
      attempts.value[part] = new Date().toISOString();
      if (part === 'assets') attemptedAt.value = attempts.value[part];
      const response = await fetch(path, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        cache: 'no-store',
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
        attempts.value[part] = meta.attemptedAt;
        if (part === 'assets') attemptedAt.value = meta.attemptedAt;
      }
      const retry =
        typeof meta.retryAt === 'string' && Number.isFinite(Date.parse(meta.retryAt))
          ? ` 下次允许读取：${new Date(meta.retryAt).toLocaleString('zh-CN', { hour12: false })}。`
          : '';
      if (
        meta.scopeConfirmed === false ||
        (meta.source !== undefined && meta.source !== expectedSource)
      ) {
        revokeScope(
          `${typeof meta.error === 'string' ? meta.error : '账户来源无效，无法确认。'}${retry}`,
        );
        throw new Error('账户来源或口径未确认。');
      }
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : '账户读取失败，请稍后重试。';
        throw new Error(`${message}${retry}`);
      }
      if (relogin.value) throw new Error('登录已过期，请重新登录。');
      return data;
    }
    async function assetsRead() {
      try {
        const data = await request('/api/account/assets', 'assets');
        if (!current()) return;
        const next = validateAssets(data, expectedSource);
        if (snapshot.value && Date.parse(next.queriedAt) < Date.parse(snapshot.value.queriedAt))
          throw new Error('账户响应早于上次成功查询，本次快照不可用。');
        snapshot.value = next;
        stale.value = false;
        status.value = `${expectedSource === 'demo' ? '模拟' : 'Binance '}查询成功 · 仅代表查询时点${data && typeof data === 'object' && 'reused' in data && data.reused === true ? ' · 复用 3 秒内读取，保留原查询时间' : ''}`;
      } catch (error) {
        if (!current()) return;
        stale.value = true;
        status.value = `${error instanceof Error ? error.message : '账户读取失败。'} ${snapshot.value ? '上次快照已过期，原数值与成功时间保留。' : '尚无成功数据。'}`;
      }
    }
    function updateMarket<T extends LastPrice | Funding>(
      state: ShallowRef<MarketState<T>>,
      value: unknown,
      kind: 'last' | 'funding',
    ) {
      try {
        const metadata =
          value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const attemptedAt =
          typeof metadata.attemptedAt === 'string' &&
          Number.isFinite(Date.parse(metadata.attemptedAt))
            ? metadata.attemptedAt
            : attempts.value.positions;
        state.value = { ...state.value, attemptedAt };
        const part = validateMarket<T>(value, kind);
        const previous = state.value.snapshot;
        if (part.status === 'error')
          state.value = { ...state.value, stale: true, error: part.error };
        else if (previous && Date.parse(part.queriedAt) < Date.parse(previous.queriedAt))
          state.value = { ...state.value, stale: true, error: '辅助行情响应早于上次查询。' };
        else state.value = { snapshot: part, stale: false, error: '', attemptedAt };
      } catch (error) {
        state.value = {
          ...state.value,
          stale: true,
          error: error instanceof Error ? error.message : '辅助行情无效。',
        };
      }
    }
    async function positionsRead() {
      try {
        const data = await request('/api/account/positions', 'positions');
        if (!current()) return;
        const next = validatePositions(data, expectedSource);
        if (positions.value && Date.parse(next.queriedAt) < Date.parse(positions.value.queriedAt))
          throw new Error('持仓响应早于上次成功查询。');
        positions.value = { queriedAt: next.queriedAt, data: next.positions };
        positionsStale.value = false;
        positionsStatus.value = `${expectedSource === 'demo' ? '模拟' : 'Binance '}持仓查询成功 · 仅代表查询时点${data && typeof data === 'object' && 'reused' in data && data.reused === true ? ' · 复用 3 秒内读取，保留原查询时间' : ''}`;
        updateMarket(last, next.last, 'last');
        updateMarket(funding, next.funding, 'funding');
      } catch (error) {
        if (!current()) return;
        positionsStale.value = true;
        positionsStatus.value = `${error instanceof Error ? error.message : '持仓读取失败。'} ${positions.value ? '上次持仓已过期，原数值与成功时间保留。' : '尚无成功持仓数据。'}`;
        last.value = { ...last.value, stale: true };
        funding.value = { ...funding.value, stale: true };
      }
    }
    async function ordersRead(conditional = false) {
      const name = conditional ? '条件委托' : '普通委托';
      const snapshot = conditional ? conditionalOrders : orders;
      const stale = conditional ? conditionalOrdersStale : ordersStale;
      const status = conditional ? conditionalOrdersStatus : ordersStatus;
      try {
        const data = await request(
          conditional ? '/api/account/conditional-orders' : '/api/account/orders',
          conditional ? 'conditionalOrders' : 'orders',
        );
        if (!current()) return;
        const next = conditional
          ? validateConditionalOrders(data, expectedSource)
          : validateOrders(data, expectedSource);
        if (snapshot.value && Date.parse(next.queriedAt) < Date.parse(snapshot.value.queriedAt))
          throw new Error(`${name}响应早于上次成功查询。`);
        snapshot.value = next;
        stale.value = false;
        status.value = `${expectedSource === 'demo' ? '模拟' : 'Binance '}${name}查询成功 · 仅代表查询时点${data && typeof data === 'object' && 'reused' in data && data.reused === true ? ' · 复用 3 秒内读取，保留原查询时间' : ''}`;
      } catch (error) {
        if (!current()) return;
        stale.value = true;
        status.value = `${error instanceof Error ? error.message : `${name}读取失败。`} ${snapshot.value ? `上次${name}已过期，原列表与成功时间保留。` : `尚无成功${name}数据。`}`;
      }
    }
    try {
      await Promise.all([assetsRead(), positionsRead(), ordersRead(), ordersRead(true)]);
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
    positionsStale.value = true;
    conditionalOrdersStale.value = true;
    conditionalOrdersStatus.value = `${reason} ${conditionalOrders.value ? '上次条件委托已过期。' : '尚无成功条件委托数据。'}`;
    ordersStale.value = true;
    ordersStatus.value = `${reason} ${orders.value ? '上次普通委托已过期。' : '尚无成功普通委托数据。'}`;
    last.value = { ...last.value, stale: true };
    funding.value = { ...funding.value, stale: true };
    positionsStatus.value = `${reason} ${positions.value ? '上次持仓已过期。' : '尚无成功持仓数据。'}`;
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

  return {
    snapshot,
    attemptedAt,
    attempts,
    busy,
    stale,
    relogin,
    status,
    refresh,
    positions,
    positionsStale,
    positionsStatus,
    conditionalOrders,
    conditionalOrdersStale,
    conditionalOrdersStatus,
    orders,
    ordersStale,
    ordersStatus,
    last,
    funding,
  };
}
