import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { AccountError, binanceTransport, type ReadPriority, type Transport } from './account.ts';
import { binanceRequestWeight, SharedRead } from './account-refresh.ts';
import type { PrismaClient } from './generated/prisma/client.ts';

type Budget = { duration: number; limit: number; used: number; window: number };
type Budgets = Record<string, Budget>;
type Reply = Awaited<ReturnType<Transport>>;
const epoch = new Date(0);
const egressId = 'binance';
function cooling(until: Date, archive = false) {
  const error = new AccountError(
    'rate_limited',
    archive ? '后台归档读取额度暂不足，已为账户与核验保留余量。' : 'Binance 限流，读取已退避。',
    429,
  );
  error.retryAt = until.toISOString();
  error.attemptedAt = new Date().toISOString();
  return error;
}
function responseCooldown(response: Reply) {
  if (response.status !== 429 && response.status !== 418) return epoch;
  const retry = Object.entries(response.headers ?? {}).find(
    ([key]) => key.toLowerCase() === 'retry-after',
  )?.[1];
  const seconds = retry === undefined ? NaN : Number(retry);
  const retryAt =
    Number.isFinite(seconds) && seconds >= 0
      ? Date.now() + seconds * 1000
      : Date.parse(retry ?? '');
  const message =
    response.body &&
    typeof response.body === 'object' &&
    'msg' in response.body &&
    typeof response.body.msg === 'string'
      ? response.body.msg
      : '';
  const ban = /banned until (\d{13})/i.exec(message);
  return new Date(
    Math.max(
      Number.isFinite(retryAt)
        ? retryAt
        : ban
          ? Number(ban[1])
          : Date.now() + (response.status === 418 ? 3 * 86400000 : 60000),
      ban ? Number(ban[1]) : 0,
    ),
  );
}
function observe(budgets: Budgets, url: URL, response: Reply, now: number) {
  if (url.hostname !== 'fapi.binance.com') return;
  for (const budget of Object.values(budgets)) {
    const window = Math.floor(now / budget.duration);
    if (budget.window !== window) {
      budget.window = window;
      budget.used = binanceRequestWeight(url);
    }
  }
  if (url.pathname === '/fapi/v1/exchangeInfo' && response.status === 200) {
    const body = response.body as { rateLimits?: unknown[] } | null;
    let confirmed = false;
    const intervals: Record<string, [number, string]> = {
      SECOND: [1000, 's'],
      MINUTE: [60000, 'm'],
      HOUR: [3600000, 'h'],
      DAY: [86400000, 'd'],
    };
    for (const value of Array.isArray(body?.rateLimits) ? body.rateLimits : []) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      const interval = typeof row.interval === 'string' ? intervals[row.interval] : undefined;
      if (
        row.rateLimitType !== 'REQUEST_WEIGHT' ||
        !interval ||
        typeof row.intervalNum !== 'number' ||
        !Number.isSafeInteger(row.intervalNum) ||
        row.intervalNum <= 0 ||
        typeof row.limit !== 'number' ||
        !Number.isSafeInteger(row.limit) ||
        row.limit <= 0
      )
        continue;
      const key = `${row.intervalNum}${interval[1]}`;
      const duration = row.intervalNum * interval[0];
      if (!Number.isSafeInteger(duration)) continue;
      confirmed = true;
      const window = Math.floor(now / duration);
      budgets[key] = {
        duration,
        limit: row.limit,
        used: budgets[key]?.window === window ? budgets[key]!.used : 1,
        window,
      };
    }
    if (!confirmed)
      throw new AccountError('invalid_response', '无法确认 Binance 读取额度，已停止读取。');
  }
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    const match = /^x-mbx-used-weight-(\d+[smhd])$/i.exec(key);
    if (!match || (url.pathname === '/fapi/v2/ticker/price' && match[1]!.toLowerCase() === '1m'))
      continue;
    const budget = budgets[match[1]!.toLowerCase()];
    const used = Number(value);
    if (budget && Number.isSafeInteger(used) && used >= 0)
      budget.used = Math.max(budget.used, used);
  }
}

// One conservative bucket per installation also covers replicas sharing an outbound IP.
export function createBinanceEgress(
  database: PrismaClient,
  upstream: Transport = binanceTransport,
) {
  const init = () =>
    database.binanceEgress.upsert({
      where: { id: egressId },
      create: { id: egressId },
      update: {},
    });
  async function check() {
    const state = await init();
    if (state.blockedUntil.getTime() > Date.now()) throw cooling(state.blockedUntil);
  }
  const limits = new SharedRead(async (signal) => {
    const state = await init();
    if (state.limitsAt.getTime() > Date.now() - 60000) return;
    const url = new URL('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const response = await dispatch(url, signal, 'foreground', (next) => upstream(url, {}, next));
    if (response.status !== 200)
      throw new AccountError('upstream_error', 'Binance 额度信息读取失败。');
  }, 2900);
  async function dispatch(
    url: URL,
    signal: AbortSignal,
    priority: ReadPriority,
    send: (signal: AbortSignal) => Promise<Reply>,
  ): Promise<Reply> {
    signal.throwIfAborted();
    await check();
    const id = randomUUID();
    await database.binanceReadRequest.create({
      data: { id, priority, expiresAt: new Date(Date.now() + 15000) },
    });
    let acquired = false;
    try {
      while (!acquired) {
        signal.throwIfAborted();
        const result = await database.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM binance_egress WHERE id = ${egressId} FOR UPDATE`;
          const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          const now = clock[0]!.now;
          const state = await tx.binanceEgress.findUniqueOrThrow({ where: { id: egressId } });
          await tx.binanceReadRequest.deleteMany({ where: { expiresAt: { lte: now } } });
          if (state.blockedUntil > now) return { blocked: state.blockedUntil };
          if (!(await tx.binanceReadRequest.findUnique({ where: { id } })))
            throw new AccountError('timeout', '账户查询排队超时。', 504);
          if (state.activeUntil > now) return {};
          const first = await tx.binanceReadRequest.findFirst({
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          });
          if (first?.id !== id || (priority === 'archive' && state.nextArchiveAt > now)) return {};
          const budgets = state.budgets as Budgets;
          if (url.hostname === 'fapi.binance.com') {
            for (const budget of Object.values(budgets)) {
              const window = Math.floor(now.getTime() / budget.duration);
              if (window !== budget.window) {
                budget.window = window;
                budget.used = 0;
              }
              const ceiling =
                priority === 'archive' ? Math.floor(budget.limit * 0.75) : budget.limit;
              if (budget.used + binanceRequestWeight(url) > ceiling)
                return {
                  blocked: new Date((window + 1) * budget.duration),
                  archive: priority === 'archive',
                };
            }
            for (const budget of Object.values(budgets)) budget.used += binanceRequestWeight(url);
          }
          await tx.binanceEgress.update({
            where: { id: egressId },
            data: { activeId: id, activeUntil: new Date(now.getTime() + 15000), budgets },
          });
          await tx.binanceReadRequest.delete({ where: { id } });
          return { acquired: true };
        });
        if (result.blocked) throw cooling(result.blocked, result.archive);
        acquired = result.acquired === true;
        if (!acquired) await setTimeout(50, undefined, { signal });
      }
      signal.throwIfAborted();
      // The lease outlives this bounded call; late completion cannot release a newer owner.
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const response = await send(bounded);
      const cooldown = responseCooldown(response);
      await database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM binance_egress WHERE id = ${egressId} FOR UPDATE`;
        const state = await tx.binanceEgress.findUniqueOrThrow({ where: { id: egressId } });
        const budgets = state.budgets as Budgets;
        if (state.activeId === id) observe(budgets, url, response, Date.now());
        await tx.binanceEgress.update({
          where: { id: egressId },
          data: {
            budgets,
            blockedUntil: new Date(Math.max(state.blockedUntil.getTime(), cooldown.getTime())),
            ...(state.activeId === id &&
            url.pathname === '/fapi/v1/exchangeInfo' &&
            response.status === 200
              ? { limitsAt: new Date() }
              : {}),
          },
        });
      });
      if (cooldown > epoch) throw cooling(cooldown);
      bounded.throwIfAborted();
      return response;
    } finally {
      await database.binanceReadRequest.deleteMany({ where: { id } });
      if (acquired)
        await database.binanceEgress.updateMany({
          where: { id: egressId, activeId: id },
          data: {
            activeId: null,
            activeUntil: epoch,
            ...(priority === 'archive' ? { nextArchiveAt: new Date(Date.now() + 1000) } : {}),
          },
        });
    }
  }
  return {
    check,
    async run(
      url: URL,
      signal: AbortSignal,
      priority: ReadPriority,
      send: (signal: AbortSignal) => Promise<Reply>,
    ) {
      await check();
      if (url.hostname === 'fapi.binance.com' && url.pathname !== '/fapi/v1/exchangeInfo')
        await limits.read(signal);
      return dispatch(url, signal, priority, send);
    },
  };
}
