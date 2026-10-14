import { AccountError, binanceTransport, signBinanceRequest, type AccountConfig, type ReadPriority, type Transport } from './account.ts';

// A subscriber owns its wait, not the shared upstream request.
export class SharedRead<T> {
  private pending?: { controller: AbortController; promise: Promise<T>; users: number; attemptedAt: string };
  private failure?: AccountError;
  private failures = 0;
  private generation = 0;
  private retry: boolean;
  private cached?: { value: T; expiresAt: number; attemptedAt: string };
  private load: (signal: AbortSignal) => Promise<T>;
  private lifetime: number;
  constructor(load: (signal: AbortSignal) => Promise<T>, lifetime = 0, retry = false) { this.load = load; this.lifetime = lifetime; this.retry = retry; }

  setLoader(load: (signal: AbortSignal) => Promise<T>) { this.load = load; }
  get active() { return this.pending !== undefined; }
  clear() { this.cached = undefined; this.generation++; }
  stop() { this.clear(); this.pending?.controller.abort(); }

  async read(signal: AbortSignal): Promise<{ value: T; attemptedAt: string; reused: boolean }> {
    signal.throwIfAborted();
    if (this.failure?.retryAt && Date.parse(this.failure.retryAt) > Date.now()) throw this.failure;
    if (this.cached && Date.now() < this.cached.expiresAt)
      return { ...this.cached, reused: true };
    let attemptedAt = new Date().toISOString();
    if (!this.pending) {
      const controller = new AbortController();
      const generation = this.generation;
      const deadline = AbortSignal.timeout(10_000);
      const timeout = () => {
        if (controller.signal.aborted) return;
        const error = new AccountError('timeout', '账户查询超时，请检查网络后重试。', 504);
        if (this.retry) {
          error.attemptedAt = attemptedAt;
          error.retryAt = new Date(Date.now() + Math.min(60_000, 3_000 * 2 ** Math.min(this.failures++, 5))).toISOString();
          this.failure = error; this.cached = undefined;
        }
        controller.abort(error);
      };
      deadline.addEventListener('abort', timeout, { once: true });
      const promise = Promise.resolve().then(() => this.load(controller.signal));
      const entry = { controller, users: 0, promise, attemptedAt };
      entry.promise = promise
        .then((value) => {
          if (!controller.signal.aborted && generation === this.generation) {
            const successfulAt = value && typeof value === 'object' && 'queriedAt' in value && typeof value.queriedAt === 'string' ? Date.parse(value.queriedAt) : Date.parse(attemptedAt);
            this.cached = { value, expiresAt: Math.min(Date.parse(attemptedAt), successfulAt) + this.lifetime, attemptedAt };
            this.failure = undefined; this.failures = 0;
          }
          return value;
        }).catch((error: unknown) => {
          if (this.retry && !controller.signal.aborted && error instanceof AccountError) {
            error.attemptedAt ??= attemptedAt;
            if (error.code !== 'rate_limited' && error !== this.failure) {
              const until = Date.now() + Math.min(60_000, 3_000 * 2 ** Math.min(this.failures++, 5));
              error.retryAt = new Date(Math.max(until, Date.parse(error.retryAt ?? '') || 0)).toISOString();
            }
            this.failure = error; this.cached = undefined;
          }
          throw error;
        }).finally(() => { deadline.removeEventListener('abort', timeout); if (this.pending === entry) this.pending = undefined; });
      this.pending = entry;
    }
    const entry = this.pending;
    attemptedAt = entry.attemptedAt;
    entry.users++;
    const value = await new Promise<T>((resolve, reject) => {
      const waiting = AbortSignal.any([signal, entry.controller.signal]);
      const abort = () => reject(waiting.reason);
      if (waiting.aborted) return abort();
      waiting.addEventListener('abort', abort, { once: true });
      entry.promise.then(resolve, reject).finally(() => waiting.removeEventListener('abort', abort));
    }).finally(() => {
      entry.users--;
      if (!entry.users && this.pending === entry) {
        this.pending = undefined;
        entry.controller.abort();
      }
    });
    return { value, attemptedAt, reused: false };
  }
}

export function coordinateAccountReads(config: AccountConfig) {
  const upstream = config.transport ?? binanceTransport;
  let blocked: AccountError | undefined;
  const budgets = new Map<string, { duration: number; limit: number; used: number; window: number }>();
  const weight = (url: URL) => {
    const single = url.searchParams.has('symbol');
    const weights: Record<string, number> = {
      '/fapi/v2/account': 5, '/fapi/v2/positionRisk': 5, '/fapi/v1/exchangeInfo': 1,
      '/fapi/v1/openOrders': single ? 1 : 40, '/fapi/v1/openAlgoOrders': single ? 1 : 40,
      '/fapi/v2/ticker/price': single ? 1 : 2, '/fapi/v1/premiumIndex': single ? 1 : 10,
      '/fapi/v1/klines': 2, '/fapi/v1/markPriceKlines': 2,
      '/fapi/v1/time': 1, '/fapi/v1/userTrades': 5, '/fapi/v1/allOrders': 5,
      '/fapi/v1/allAlgoOrders': 5, '/fapi/v1/income': 30, '/fapi/v1/forceOrders': single ? 20 : 50,
      '/fapi/v1/ticker/bookTicker': single ? 2 : 5, '/fapi/v1/leverageBracket': 1,
      '/fapi/v1/commissionRate': 20, '/fapi/v1/positionSide/dual': 30,
    };
    return weights[url.pathname] ?? 0;
  };
  const defer = (until: number, message: string, shared = true) => {
    const error = new AccountError('rate_limited', message, 429);
    error.retryAt = new Date(until).toISOString(); error.attemptedAt = new Date().toISOString();
    if (!shared) return error;
    if (!blocked?.retryAt || Date.parse(blocked.retryAt) < until) blocked = error;
    return blocked;
  };
  const check = () => { if (blocked?.retryAt && Date.parse(blocked.retryAt) > Date.now()) throw blocked; };
  const dispatch: Transport = async (url, headers, signal, priority = 'foreground') => {
    signal.throwIfAborted();
    check();
    const futures = url.hostname === 'fapi.binance.com';
    if (futures) {
      for (const budget of budgets.values()) {
        const window = Math.floor(Date.now() / budget.duration);
        if (budget.window !== window) { budget.window = window; budget.used = 0; }
        if (priority === 'archive' && budget.used + weight(url) > Math.floor(budget.limit * 0.75))
          throw defer((window + 1) * budget.duration, '后台归档读取额度暂不足，已为账户与核验保留余量，下一轮补查。', false);
        if (budget.used + weight(url) > budget.limit)
          throw defer((window + 1) * budget.duration, 'Binance 当前 IP 读取额度不足，已退避至额度窗口结束。');
      }
      for (const budget of budgets.values()) budget.used += weight(url);
    }
    // Re-sign after queueing; the original request may have waited beyond recvWindow.
    if (url.searchParams.has('signature')) signBinanceRequest(config, url);
    const response = await upstream(url, headers, signal);
    if (response.status === 429 || response.status === 418) {
      const retry = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const numeric = retry === undefined ? NaN : Number(retry);
      const retryAt = Number.isFinite(numeric) && numeric >= 0 ? Date.now() + numeric * 1000 : Date.parse(retry ?? '');
      const body = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
      const ban = typeof body.msg === 'string' ? /banned until (\d{13})/i.exec(body.msg) : null;
      const until = Math.max(Number.isFinite(retryAt) ? retryAt : ban ? Number(ban[1]) : Date.now() + (response.status === 418 ? 3 * 86_400_000 : 60_000), ban ? Number(ban[1]) : 0);
      throw defer(until, 'Binance 限流，读取已退避。');
    }
    if (futures) {
      if (url.pathname === '/fapi/v1/exchangeInfo' && response.status === 200 && response.body && typeof response.body === 'object' && 'rateLimits' in response.body && Array.isArray(response.body.rateLimits)) {
        const intervals: Record<string, [number, string]> = { SECOND: [1000, 's'], MINUTE: [60_000, 'm'], HOUR: [3_600_000, 'h'], DAY: [86_400_000, 'd'] };
        for (const value of response.body.rateLimits) {
          if (!value || typeof value !== 'object') continue;
          const row = value as Record<string, unknown>;
          const interval = typeof row.interval === 'string' ? intervals[row.interval] : undefined;
          if (row.rateLimitType !== 'REQUEST_WEIGHT' || !interval || typeof row.intervalNum !== 'number' || !Number.isSafeInteger(row.intervalNum) || row.intervalNum <= 0 || typeof row.limit !== 'number' || !Number.isSafeInteger(row.limit) || row.limit <= 0) continue;
          const key = `${row.intervalNum}${interval[1]}`, duration = row.intervalNum * interval[0];
          const previous = budgets.get(key);
          budgets.set(key, { duration, limit: row.limit, used: previous?.used ?? 0, window: Math.floor(Date.now() / duration) });
        }
      }
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        const match = /^x-mbx-used-weight-(\d+[smhd])$/i.exec(key);
        // Binance documents ticker V2's 1M usage header as inaccurate.
        if (!match || (url.pathname === '/fapi/v2/ticker/price' && match[1]!.toLowerCase() === '1m')) continue;
        const budget = budgets.get(match[1]!.toLowerCase()), used = Number(value);
        if (budget && Number.isSafeInteger(used) && used >= 0) budget.used = Math.max(budget.used, used);
      }
    }
    return response;
  };
  type Job = { run: () => void };
  const queue: Record<ReadPriority, Job[]> = { foreground: [], archive: [] };
  let active = false, nextArchiveAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pump = () => {
    if (active) return;
    clearTimeout(timer);
    let next = queue.foreground.shift();
    if (!next && queue.archive.length) {
      const until = nextArchiveAt;
      if (until > Date.now()) { timer = setTimeout(pump, until - Date.now()); return; }
      next = queue.archive.shift();
    }
    if (next) { active = true; next.run(); }
  };
  const guarded: Transport = (url, headers, signal, priority = 'foreground') => new Promise((resolve, reject) => {
    const cancel = () => {
      const index = queue[priority].indexOf(job);
      if (index >= 0) { queue[priority].splice(index, 1); reject(signal.reason); pump(); }
    };
    const job: Job = { run: () => {
      signal.removeEventListener('abort', cancel);
      void dispatch(url, headers, signal, priority).then(resolve, reject).finally(() => {
        if (priority === 'archive' && !config.transport) nextArchiveAt = Date.now() + 1000;
        active = false; pump();
      });
    } };
    queue[priority].push(job); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else pump();
  });
  const failures = new Map<string, { error: AccountError; count: number }>();
  const pending = new Map<string, SharedRead<Awaited<ReturnType<Transport>>>>();
  const transport: Transport = async (url, headers, signal, priority = 'foreground') => {
    check();
    const key = `${url.origin}${url.pathname}?${[...url.searchParams].filter(([name]) => !['timestamp', 'signature', 'recvWindow'].includes(name)).map(([name, value]) => `${name}=${value}`).join('&')}`;
    const failure = failures.get(key);
    if (failure?.error.retryAt && Date.parse(failure.error.retryAt) > Date.now()) throw failure.error;
    let slot = pending.get(key);
    if (!slot) {
      slot = new SharedRead(async (sharedSignal) => {
        try {
          const response = await guarded(url, headers, sharedSignal, priority);
          if (response.status >= 500) throw new AccountError('upstream_error', 'Binance 读取失败，分项已退避。');
          failures.delete(key);
          return response;
        } catch (error) {
          const problem = error instanceof AccountError ? error : new AccountError('connection_failed', '账户或行情连接失败，分项已退避。');
          if (!sharedSignal.aborted && problem.code !== 'rate_limited') {
            const count = failure?.count ?? 0;
            problem.attemptedAt = new Date().toISOString();
            problem.retryAt = new Date(Date.now() + Math.min(60_000, 3_000 * 2 ** Math.min(count, 5))).toISOString();
            failures.set(key, { error: problem, count: count + 1 });
          }
          throw problem;
        } finally { if (pending.get(key) === slot) pending.delete(key); }
      });
      pending.set(key, slot);
    }
    try { return (await slot.read(signal)).value; }
    finally { if (!slot.active && pending.get(key) === slot) pending.delete(key); }
  };
  return { config: { ...config, transport }, strictConfig: { ...config, transport: guarded }, check,
    stop: () => { for (const slot of pending.values()) slot.stop(); } };
}
