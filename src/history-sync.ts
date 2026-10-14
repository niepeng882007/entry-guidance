import { AccountError, object, readBinance, type AccountConfig } from './account.ts';
import { createHash } from 'node:crypto';
import { formatDecimal, parseDecimal } from '../public/draft.js';
import { ReviewLedger, type HistoryPage, type HistorySource, type RawRecord, type ReviewFill, type ReviewIdentity, type ReviewTrade, type SyncState } from './review-ledger.ts';

const day = 86_400_000;
type PositionAnchor = { positions: Partial<Record<ReviewFill['positionSide'], bigint>>; raw: RawRecord[]; at: number; stable: ReviewFill['positionSide'][] };
const sources: HistorySource[] = ['trades', 'history', 'algoHistory', 'income', 'forceOrders'];
const fail = (message: string): never => { throw new AccountError('invalid_history', message); };
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,24}$/.test(value)) return value;
  return fail('历史记录 ID 缺失或精度不可靠。');
}
function money(value: unknown, signed = true): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,24}(\.\d{1,8})?$/.test(value) || (!signed && value.startsWith('-'))) return fail('历史金额或数量缺失、无效或精度不支持。');
  return parseDecimal(value.replace('-', ''), '历史金额') * (value.startsWith('-') ? -1n : 1n);
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return fail('历史记录时间无效。');
  return value;
}
function normalize(source: HistorySource, value: unknown, symbol: string, page: HistoryPage): RawRecord[] {
  if (!Array.isArray(value)) return fail('历史列表响应无效，区间保持未完成。');
  const rows = value.map((value): RawRecord => {
    const row = object(value);
    if (row.symbol !== symbol) return fail('历史记录合约不一致。');
    const time = timestamp(source === 'algoHistory' ? row.createTime : row.time);
    if (time < page.startTime || time > page.endTime) return fail('历史记录超出查询区间。');
    const key = id(source === 'trades' ? row.id : source === 'income' ? row.tranId : source === 'algoHistory' ? row.algoId : row.orderId);
    if (source === 'trades') {
      id(row.orderId);
      if (!['BUY', 'SELL'].includes(String(row.side)) || !['BOTH', 'LONG', 'SHORT'].includes(String(row.positionSide)) || money(row.qty, false) <= 0n || money(row.price, false) <= 0n) return fail('成交证据无效。');
      if (row.realizedPnl !== undefined && row.realizedPnl !== null) money(row.realizedPnl);
      if (row.commission !== undefined && row.commission !== null) money(row.commission, false);
      if (row.commissionAsset !== undefined && row.commissionAsset !== null && (typeof row.commissionAsset !== 'string' || !row.commissionAsset)) return fail('手续费资产无效。');
    }
    if (source === 'income') {
      if (typeof row.incomeType !== 'string' || !row.incomeType) return fail('收入来源缺失。');
      if (row.asset !== undefined && row.asset !== null && (typeof row.asset !== 'string' || !row.asset)) return fail('收入资产无效。');
      if (row.income !== undefined && row.income !== null) money(row.income);
    }
    return { kind: source, id: source === 'income' ? `${row.incomeType}-${key}` : source === 'forceOrders' ? `${page.autoCloseType}-${key}` : key, time, payload: source === 'forceOrders' ? { ...row, autoCloseType: page.autoCloseType } : row };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return fail('历史页包含重复身份，区间保持未完成。');
  return rows;
}
function windows(source: HistorySource, startTime: number, endTime: number): HistoryPage[] {
  const result: HistoryPage[] = [];
  for (let start = startTime; start <= endTime; start += 7 * day) result.push({ source, startTime: start, endTime: Math.min(endTime, start + 7 * day - 1), page: 1 });
  return result;
}
function calendarStart(endTime: number) {
  const date = new Date(endTime);
  const dateOfMonth = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - 3);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dateOfMonth, lastDay));
  return date.getTime();
}
function unavailableMessage(page: HistoryPage) {
  return `${page.source} · ${new Date(page.startTime).toISOString()} 至 ${new Date(page.endTime).toISOString()} 超出上游可查期限，保留为缺口`;
}
function covered(state: SyncState, source: HistorySource, start: number, end: number): boolean {
  let cursor = start;
  for (const page of state.completed.filter((page) => page.source === source).sort((a, b) => a.startTime - b.startTime)) {
    if (page.startTime > cursor) break;
    if (page.endTime >= cursor) cursor = page.endTime + 1;
    if (cursor > end) return true;
  }
  return false;
}

export class HistorySync {
  private running = false;
  private activeSymbol: string | undefined;
  private controller = new AbortController();
  private task: Promise<void> | undefined;
  private ledger: ReviewLedger;
  private identity: ReviewIdentity;
  private config: AccountConfig;
  constructor(config: AccountConfig, ledger: ReviewLedger, identity: ReviewIdentity) {
    this.config = config; this.ledger = ledger; this.identity = identity;
  }
  state() {
    const state = this.ledger.sync(this.activeSymbol);
    return state?.status === 'running' && !this.running ? { ...state, status: 'interrupted' as const, missing: ['服务中断，点击开始同步继续补查。'] } : state;
  }
  async start(symbol: string) {
    if (this.running) throw new AccountError('sync_running', '已有同步正在运行，请查看进度。', 409);
    this.running = true;
    try {
      const endTime = timestamp(object(await readBinance(this.config, 'time', AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]))).serverTime);
      const startTime = calendarStart(endTime);
      const previous = this.ledger.sync(symbol);
      const resume = previous && previous.pending.length > 0 && previous.status !== 'complete';
      const state: SyncState = resume ? { ...previous, status: 'running', missing: (previous.unavailable ?? []).map(unavailableMessage) } : {
        symbol, startTime, endTime, status: 'running', pages: 0, records: 0,
        pending: sources.flatMap((source) => source === 'forceOrders'
          ? ['LIQUIDATION', 'ADL'].flatMap((autoCloseType) => windows(source, startTime, endTime).map((page) => ({ ...page, autoCloseType: autoCloseType as 'LIQUIDATION' | 'ADL' })))
          : windows(source, startTime, endTime)),
        completed: previous?.completed ?? [], missing: [], lastSuccessAt: previous?.lastSuccessAt ?? null,
      };
      state.attemptedAt = new Date().toISOString();
      this.ledger.saveSync(state);
      this.activeSymbol = symbol;
      this.task = this.run(state).finally(() => { this.running = false; });
      return state;
    } catch (error) { this.running = false; throw error; }
  }
  async stop() {
    this.controller.abort();
    await this.task;
  }
  private async readPage(state: SyncState) {
    const page = state.pending[0]!;
    const cutoff = ['history', 'algoHistory'].includes(page.source) ? Date.now() - 90 * day + 1 : ['trades', 'income'].includes(page.source) ? calendarStart(Date.now()) : null;
    if (cutoff !== null && page.startTime < cutoff) {
      const gap = { ...page, endTime: Math.min(page.endTime, cutoff - 1) };
      state = { ...state, pending: [...state.pending], unavailable: [...(state.unavailable ?? []), gap], missing: [...state.missing, unavailableMessage(gap)] };
      if (cutoff > page.endTime) state.pending.shift();
      else state.pending[0] = { ...page, startTime: cutoff, page: 1 };
      this.ledger.saveSync(state);
      return state;
    }
    const response = await readBinance(this.config, page.source, AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]), state.symbol,
      { startTime: page.startTime, endTime: page.endTime, ...(page.source === 'income' ? { page: page.page } : {}), ...(page.autoCloseType ? { autoCloseType: page.autoCloseType } : {}) });
    const records = normalize(page.source, response, state.symbol, page);
    const limit = page.source === 'forceOrders' ? 100 : 1000;
    if (records.length > limit) return fail('历史页超过官方条数上限。');
    state = { ...state, pending: [...state.pending], completed: [...state.completed] };
    state.pages++;
    state.records += records.length;
    if (records.length === limit) {
      if (page.source === 'income') {
        const fingerprint = createHash('sha256').update(records.map((row) => row.id).sort().join(',')).digest('hex');
        if (fingerprint === page.fingerprint) return fail('收入分页没有前进，区间保持未完成。');
        state.pending[0] = { ...page, page: page.page + 1, fingerprint };
      } else {
        // Full time pages can contain the newest rows; bisect without assuming an ID cursor implies coverage.
        if (page.startTime === page.endTime) {
          this.ledger.saveSync(state, records);
          return fail(`${page.source} 同一毫秒达到条数上限，无法证明完整，需补查。`);
        }
        const middle = Math.floor((page.startTime + page.endTime) / 2);
        state.pending.splice(0, 1, { ...page, endTime: middle }, { ...page, startTime: middle + 1 });
      }
    } else {
      state.pending.shift();
      state.completed.push(page);
    }
    this.ledger.saveSync(state, records);
    return state;
  }
  private async run(state: SyncState) {
    try {
      while (state.pending.length && !this.controller.signal.aborted) state = await this.readPage(state);
      if (this.controller.signal.aborted) throw new AccountError('interrupted', '服务中断，点击开始同步继续补查。');
      const anchor = await this.anchor(state);
      this.project(state, anchor);
      state.status = 'complete'; state.lastSuccessAt = new Date().toISOString();
      this.ledger.saveSync(state);
    } catch (error) {
      state.status = this.controller.signal.aborted ? 'interrupted' : 'failed';
      state.missing = [...(state.unavailable ?? []).map(unavailableMessage), error instanceof AccountError ? error.message : '归档读取或保存失败，已有账本保留，请再次同步。'];
      try { this.ledger.saveSync(state); this.project(state, null); }
      catch { /* Keep committed evidence and progress when the filesystem is unavailable. */ }
    }
  }
  private async anchor(state: SyncState): Promise<PositionAnchor | null> {
    const signal = () => AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]);
    const before = timestamp(object(await readBinance(this.config, 'time', signal())).serverTime);
    const response = await readBinance(this.config, 'positions', signal(), state.symbol);
    const after = timestamp(object(await readBinance(this.config, 'time', signal())).serverTime);
    if (before < state.endTime || after < before || after - state.endTime >= 7 * day) return null;
    if (!Array.isArray(response)) return fail('持仓证据无效。');
    const positions = response.map(object);
    if (positions.some((row) => row.symbol !== state.symbol)) return fail('持仓合约不一致。');
    const raw: RawRecord[] = positions.map((row) => ({ kind: 'position', id: `${after}-${String(row.positionSide)}`, time: after, payload: row }));
    this.ledger.saveSync(state, raw);
    const modes = positions.map((row) => String(row.positionSide));
    if (!(modes.length === 1 && modes[0] === 'BOTH') && !(modes.length === 2 && modes.includes('LONG') && modes.includes('SHORT'))) return null;
    const amounts: PositionAnchor['positions'] = {};
    for (const row of positions) {
      const mode = row.positionSide as ReviewFill['positionSide'];
      const amount = money(row.positionAmt);
      if ((mode === 'LONG' && amount < 0n) || (mode === 'SHORT' && amount > 0n)) return null;
      amounts[mode] = amount;
    }
    let stable = modes as ReviewFill['positionSide'][];
    if (after > state.endTime) {
      const page: HistoryPage = { source: 'trades', startTime: state.endTime + 1, endTime: after, page: 1 };
      const tail = normalize('trades', await readBinance(this.config, 'trades', signal(), state.symbol, { startTime: page.startTime, endTime: page.endTime }), state.symbol, page);
      if (tail.length >= 1000) return null;
      this.ledger.saveSync(state, tail);
      if (tail.some((row) => row.time >= before || amounts[row.payload.positionSide as ReviewFill['positionSide']] === undefined)) return null;
      stable = stable.filter((mode) => !tail.some((row) => row.payload.positionSide === mode));
      for (const row of tail) {
        const mode = row.payload.positionSide as ReviewFill['positionSide'];
        amounts[mode] = amounts[mode]! - money(row.payload.qty, false) * (row.payload.side === 'BUY' ? 1n : -1n);
      }
    }
    return { positions: amounts, raw, at: after, stable };
  }
  private project(state: SyncState, anchor: PositionAnchor | null) {
    const raw = this.ledger.raw(state.symbol);
    const selected = raw.filter((row) => row.kind === 'trades' && row.time <= state.endTime).sort((a, b) => a.time - b.time || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const fills: ReviewFill[] = selected.map(({ id: fillId, time, payload: row }) => ({ id: fillId, orderId: id(row.orderId), symbol: state.symbol,
      side: row.side as ReviewFill['side'], positionSide: row.positionSide as ReviewFill['positionSide'], quantity: String(row.qty), price: String(row.price),
      time: new Date(time).toISOString(), realizedPnl: typeof row.realizedPnl === 'string' ? row.realizedPnl : null, commission: typeof row.commission === 'string' ? row.commission : null, commissionAsset: typeof row.commissionAsset === 'string' ? row.commissionAsset : null }));
    if (!fills.length) return;
    const coverage = covered(state, 'trades', selected[0]!.time, state.endTime);
    const groups: { mode: ReviewFill['positionSide']; reliable: boolean; fills: ReviewFill[]; start: bigint | null; end: bigint | null }[] = [];
    const old = this.ledger.list().filter((trade) => trade.symbol === state.symbol && trade.status === 'closed').map((trade) => this.ledger.get(trade.id)!);
    const preserved: ReviewTrade[] = [];
    for (const mode of ['BOTH', 'LONG', 'SHORT'] as const) {
      let lane = fills.filter((fill) => fill.positionSide === mode);
      let reliable = coverage && anchor?.positions[mode] !== undefined;
      let position: bigint | null = reliable ? anchor!.positions[mode]! - lane.reduce((sum, fill) => sum + money(fill.quantity, false) * (fill.side === 'BUY' ? 1n : -1n), 0n) : null;
      if (position !== null) {
        let chain = position;
        for (const fill of lane) {
          const delta = money(fill.quantity, false) * (fill.side === 'BUY' ? 1n : -1n);
          if ((chain === 0n || chain * delta > 0n) && fill.realizedPnl !== null && money(fill.realizedPnl) !== 0n) reliable = false;
          if ((mode === 'LONG' && chain < 0n) || (mode === 'SHORT' && chain > 0n)) reliable = false;
          chain += delta;
          if ((mode === 'LONG' && chain < 0n) || (mode === 'SHORT' && chain > 0n)) reliable = false;
        }
      }
      const previous = old.filter((trade) => trade.evidence.fills[0]?.positionSide === mode);
      if (!reliable || !lane.length) {
        preserved.push(...previous);
        lane = lane.flatMap((fill) => {
          const assigned = previous.flatMap((trade) => trade.evidence.fills.filter((item) => item.id === fill.id));
          const quantity = money(fill.quantity, false) - assigned.reduce((sum, item) => sum + money(item.quantity, false), 0n);
          if (quantity <= 0n) return [];
          if (!assigned.length) return [fill];
          return [{ ...fill, allocation: 'open' as const, quantity: formatDecimal(quantity), realizedPnl: '0',
            commission: fill.commission === null || assigned.some((item) => item.commission === null) ? null : formatDecimal(money(fill.commission, false) - assigned.reduce((sum, item) => sum + money(item.commission, false), 0n)) }];
        });
      }
      if (!lane.length) continue;
      if (!reliable) position = null;
      let group = { mode, reliable, fills: [] as ReviewFill[], start: position, end: position };
      for (const fill of lane) {
        const delta = money(fill.quantity, false) * (fill.side === 'BUY' ? 1n : -1n);
        const next = position === null ? null : position + delta;
        if (position !== null && next !== null && position * next < 0n) {
          const closing = position < 0n ? -position : position;
          const quantity = money(fill.quantity, false);
          const closeFee = fill.commission === null ? null : money(fill.commission, false) * closing / quantity;
          group.fills.push({ ...fill, quantity: formatDecimal(closing), commission: closeFee === null ? null : formatDecimal(closeFee), allocation: 'close', event: 'exit' });
          group.end = 0n;
          groups.push(group);
          group = { mode, reliable, start: 0n, end: next, fills: [{ ...fill, quantity: formatDecimal(quantity - closing), realizedPnl: '0',
            commission: closeFee === null ? null : formatDecimal(money(fill.commission, false) - closeFee), allocation: 'open', event: 'entry' }] };
        } else {
          group.fills.push({ ...fill, event: position === null ? undefined : position === 0n ? 'entry' : next === 0n ? 'exit' : position * delta > 0n ? 'add' : 'reduce' });
          group.end = next;
          if (next === 0n) { groups.push(group); group = { mode, reliable, fills: [], start: 0n, end: 0n }; }
        }
        position = next;
      }
      if (group.fills.length) groups.push(group);
    }
    const trades = groups.map(({ mode, reliable, fills, start, end }): ReviewTrade => {
      const first = fills[0]!, last = fills.at(-1)!;
      const from = start === 0n ? Date.parse(first.time) : Math.min(state.startTime, Date.parse(first.time));
      const to = end === 0n ? Date.parse(last.time) : state.endTime;
      const missing = new Set<string>();
      if (!reliable) missing.add('成交链或查询时点持仓不可对账，起点待确认');
      if (start !== 0n) missing.add('缺少可靠空仓起点');
      if (!reliable && end !== 0n) missing.add('缺少完整退出或退出时点');
      const linkedOrders = [...new Set(fills.map((fill) => fill.orderId))].map((orderId) => {
        const row = raw.find((row) => row.kind === 'history' && row.id === orderId)?.payload;
        const matching = fills.filter((fill) => fill.orderId === orderId);
        const algos = raw.filter((record) => record.kind === 'algoHistory' && String(record.payload.actualOrderId) === orderId);
        const algo = algos.length === 1 ? algos[0] : undefined;
        const validAlgo = algo && algo.payload.side === matching[0]!.side && algo.payload.positionSide === matching[0]!.positionSide && algo.time <= Date.parse(matching[0]!.time);
        if (algos.length && !validAlgo) missing.add(`订单 ${orderId} 条件订单关联无法确认`);
        const type = algos.length ? validAlgo && typeof algo.payload.orderType === 'string' ? algo.payload.orderType : null : typeof row?.origType === 'string' ? row.origType : typeof row?.type === 'string' ? row.type : null;
        const original = selected.filter((fill) => String(fill.payload.orderId) === orderId);
        if (!row) missing.add(`订单 ${orderId} 元数据缺失`);
        else {
          const executed = typeof row.executedQty === 'string' && /^\d{1,24}(\.\d{1,8})?$/.test(row.executedQty) ? money(row.executedQty, false) : null;
          if (row.side !== matching[0]!.side || row.positionSide !== matching[0]!.positionSide || executed !== original.reduce((sum, fill) => sum + money(fill.payload.qty, false), 0n)) missing.add(`订单 ${orderId} 与成交无法对账`);
        }
        return { id: orderId, symbol: state.symbol, side: matching[0]!.side, type, ...(validAlgo ? { algoId: algo.id } : {}),
          quantity: formatDecimal(matching.reduce((sum, fill) => sum + money(fill.quantity, false), 0n)), time: row ? new Date(timestamp(row.time)).toISOString() : matching[0]!.time };
      });
      const income = raw.filter((row) => row.kind === 'income');
      const funding = income.filter((row) => row.payload.incomeType === 'FUNDING_FEE' && row.time >= from && row.time <= to).map((row) => {
        const candidates = groups.filter((group) => (group.start === 0n ? Date.parse(group.fills[0]!.time) : state.startTime) <= row.time && (group.end === 0n ? Date.parse(group.fills.at(-1)!.time) : state.endTime) >= row.time);
        const unseenPosition = anchor && Object.entries(anchor.positions).some(([side, amount]) => amount !== 0n && !groups.some((group) => group.mode === side));
        const confirmed = reliable && candidates.length === 1 && !unseenPosition && row.time !== from && !(end === 0n && row.time === to);
        return { id: row.id, symbol: state.symbol, time: new Date(row.time).toISOString(), amount: typeof row.payload.income === 'string' ? row.payload.income : null,
          asset: typeof row.payload.asset === 'string' ? row.payload.asset : null, attribution: confirmed ? 'confirmed' as const : 'ambiguous' as const };
      });
      const fundingComplete = covered(state, 'income', from, to);
      if (!fundingComplete) missing.add('资金费区间未确认完整');
      if (funding.some((fee) => fee.attribution === 'ambiguous')) missing.add('资金费无法唯一归属');
      const realized = fills.some((fill) => fill.realizedPnl === null) ? null : fills.reduce((sum, fill) => sum + money(fill.realizedPnl), 0n);
      const commission = fills.every((fill) => fill.commissionAsset === 'USDT' && fill.commission !== null) ? fills.reduce((sum, fill) => sum + money(fill.commission, false), 0n) : null;
      const fundingNet = reliable && start === 0n && fundingComplete && funding.every((fee) => fee.attribution === 'confirmed' && fee.asset === 'USDT' && fee.amount !== null) ? funding.reduce((sum, fee) => sum + money(fee.amount), 0n) : null;
      if (realized === null) missing.add('已实现盈亏缺失');
      if (commission === null) missing.add('手续费缺失或非 USDT，缺少可靠换算');
      if (fundingNet === null) missing.add('资金费缺失或非 USDT，归属待确认');
      for (const allocated of fills) {
        const fill = selected.find((row) => row.id === allocated.id)!.payload;
        for (const kind of ['REALIZED_PNL', 'COMMISSION']) {
          const entries = income.filter((row) => row.payload.incomeType === kind && String(row.payload.tradeId) === String(fill.id));
          if (entries.length && (entries.some((row) => row.payload.income === null || row.payload.income === undefined || row.payload.asset !== (kind === 'COMMISSION' ? fill.commissionAsset : 'USDT')) || fill.commission == null || fill.realizedPnl == null || entries.reduce((sum, row) => sum + money(row.payload.income), 0n) !== (kind === 'COMMISSION' ? -money(fill.commission, false) : money(fill.realizedPnl)))) missing.add('成交费用或已实现盈亏与收入流水不一致');
        }
      }
      const forced = raw.filter((row) => row.kind === 'forceOrders' && fills.some((fill) => (fill.event === 'reduce' || fill.event === 'exit') && fill.orderId === String(row.payload.orderId)));
      const reason = forced.map((row) => row.payload.autoCloseType);
      const snapshot = reliable && end !== 0n && anchor?.stable.includes(mode) ? anchor.raw.find((row) => row.payload.positionSide === mode) : undefined;
      const unrealized = snapshot && typeof snapshot.payload.unRealizedProfit === 'string' && /^-?\d{1,24}(\.\d{1,8})?$/.test(snapshot.payload.unRealizedProfit) ? formatDecimal(money(snapshot.payload.unRealizedProfit)) : null;
      return {
        observedAt: new Date(state.endTime).toISOString(), unrealizedPnl: unrealized, unrealizedAt: unrealized === null ? null : new Date(anchor!.at).toISOString(),
        ...this.identity, id: `binance-${createHash('sha256').update(state.symbol).digest('hex').slice(0, 32)}-${first.id}${first.allocation === 'open' ? '-open' : ''}`, groupingVersion: 2, symbol: state.symbol, baseAsset: state.symbol.slice(0, -4),
        side: mode === 'LONG' ? 'long' : mode === 'SHORT' ? 'short' : start === 0n ? (first.side === 'BUY' ? 'long' : 'short') : start !== null ? (start > 0n ? 'long' : 'short') : null,
        status: reliable && start === 0n && end !== 0n ? 'open' : missing.size ? 'incomplete' : 'closed', openedAt: start === 0n ? first.time : null, closedAt: end === 0n ? last.time : null,
        realizedPnl: realized === null ? null : formatDecimal(realized), commission: commission === null ? null : formatDecimal(commission), fundingNet: fundingNet === null ? null : formatDecimal(fundingNet),
        netPnl: missing.size || end !== 0n ? null : formatDecimal(realized! - commission! + fundingNet!), missing: [...missing],
        exitReason: reason.includes('LIQUIDATION') ? 'LIQUIDATION' : reason.includes('ADL') ? 'ADL' : 'unknown',
        evidence: { symbol: state.symbol, baseAsset: state.symbol.slice(0, -4), startPosition: start === null ? null : formatDecimal(start), endPosition: end === null ? null : formatDecimal(end),
          fillsComplete: reliable, fundingComplete, fills, orders: linkedOrders, funding,
          raw: raw.filter((row) => row.kind === 'position' || (row.kind === 'trades' ? fills.some((fill) => fill.id === row.id) : row.kind === 'history' ? linkedOrders.some((order) => order.id === row.id) : row.kind === 'algoHistory' ? linkedOrders.some((order) => order.id === String(row.payload.actualOrderId)) : row.time >= from && row.time <= to)) },
      };
    });
    this.ledger.project(state.symbol, [...preserved, ...trades]);
  }
}
