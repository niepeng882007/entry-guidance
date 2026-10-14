import { randomUUID } from 'node:crypto';
import { AccountError, object, readAccount, readBinance, readReviewIdentity, type AccountConfig } from './account.ts';
import { readMarket } from './market.ts';
import { generateEntryPlan, recheckEntryPlan, parseDecimal, formatDecimal, splitStopQuantity, type EntryInput, type Snapshot } from '../public/draft.js';

import type { ReviewFill } from './review-ledger.ts';

type Config = AccountConfig & { mode?: 'real' | 'demo' };
const SCALE = 100_000_000n;
const PERCENT = 100n * SCALE;
const abs = (value: bigint) => value < 0n ? -value : value;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const ceil = (value: bigint, denominator: bigint) => (value + denominator - 1n) / denominator;
const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
export type Plan = ReturnType<typeof generateEntryPlan> & { id: string; startedAt: string; account: Snapshot['account']; reviewAccountId?: string; takerRate?: string };
export type RecordedStop = {
  id: string; algo: boolean; status: string; type: string; side: string; positionSide: string;
  quantity: string; executedQuantity: string; triggerPrice: string; workingType: string;
  closePosition: boolean; reduceOnly: boolean; priceProtect: boolean; updateTime: number;
  timeInForce: string; goodTillDate: number; actualOrderId: string | null; triggerTime: number;
};
export type VerificationEvidence = {
  startTime: number; endTime: number; entryOrderId: string | null; snapshotConsistent: boolean;
  fills: ReviewFill[]; stops: RecordedStop[]; historicalStops: RecordedStop[];
};
export type Verification = {
  status: 'waiting' | 'ended' | 'incomplete' | 'needs-action' | 'verified';
  source: 'demo' | 'binance'; queriedAt: string; issues: string[];
  reviewRetention?: 'saved' | 'legacy-unbound';
  quantity?: string; entryPrice?: string; liquidationPrice?: string; leverage?: string;
  side?: 'long' | 'short' | 'flat';
  orderId?: string; plannedLoss?: string; excess?: string; liquidationBuffer?: string;
  entryStatus?: string; filledQuantity?: string;
  pendingEntries?: { orderId: string; filledQuantity: string; remainingQuantity: string }[];
  paidCommission?: string; paidFunding?: string; remainingFunding?: string; exitFee?: string; coverage?: string;
  nearQuantity?: string; nearActualPercent?: string; nearStatus?: string; realizedPnl?: string;
  account?: Snapshot['account'];
  reviewEvidence?: VerificationEvidence;
  entryCheck?: {
    status: 'ready' | 'needs-action' | 'incomplete'; queriedAt: string; issue: string;
    liquidationPrice?: string; liquidationBuffer?: string; plannedLoss?: string; fundingRequired?: string;
  };
};

function rows(value: unknown) {
  if (!Array.isArray(value)) throw new AccountError('invalid_response', '核验所需的列表数据缺失，无法完整核验。');
  return value.map(object);
}

function amount(value: unknown, label: string, signed = false): bigint {
  try {
    const negative = signed && typeof value === 'string' && value.startsWith('-');
    return parseDecimal(negative ? value.slice(1) : value, label) * (negative ? -1n : 1n);
  } catch { throw new AccountError('invalid_response', `${label}缺失或精度不支持，无法完整核验。`); }
}

function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value;
  throw new AccountError('invalid_response', '订单或成交标识缺失或精度不可靠，无法完整核验。');
}

function stamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AccountError('invalid_response', '交易数据时间缺失，无法完整核验。');
  return value;
}

function flag(value: unknown): boolean {
  if (value === true || value === 'true' || value === 'TRUE') return true;
  if (value === false || value === 'false' || value === 'FALSE') return false;
  throw new AccountError('invalid_response', '平仓语义或价格保护字段缺失，无法完整核验。');
}

function normalizeOrders(value: unknown, symbol: string, algo: boolean) {
  return rows(value).map((row) => {
    if (row.symbol !== symbol) throw new AccountError('invalid_response', '挂单币种不一致，无法完整核验。');
    const triggerTime = algo ? stamp(row.triggerTime) : 0;
    const actualOrderId = algo && row.actualOrderId !== '' && row.actualOrderId !== '0' ? id(row.actualOrderId) : null;
    return { id: id(algo ? row.algoId : row.orderId), algo, status: algo ? row.algoStatus : row.status,
      type: algo ? row.orderType : row.type, side: row.side, positionSide: row.positionSide,
      quantity: amount(algo ? row.quantity : row.origQty, '挂单数量'), executed: algo ? 0n : amount(row.executedQty, '挂单已成交数量'),
      price: row.type === 'LIMIT' && !algo ? amount(row.price, '限价挂单价格') : 0n,
      stop: amount(algo ? row.triggerPrice : row.stopPrice, '挂单触发价'), workingType: row.workingType,
      close: flag(row.closePosition), reduce: flag(row.reduceOnly), protect: flag(row.priceProtect),
      actualOrderId, triggerTime, triggered: triggerTime !== 0 || actualOrderId !== null,
      updateTime: stamp(row.updateTime), timeInForce: row.timeInForce, goodTillDate: stamp(row.goodTillDate),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

async function serverTime(config: Config, signal: AbortSignal) {
  const value = object(await readBinance(config, 'time', signal)).serverTime;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || Math.abs(value - Date.now()) > 30_000) throw new AccountError('clock_error', '交易所与本机时间无法对齐，请同步时钟后刷新。');
  return value;
}

async function readState(config: Config, symbol: string, signal: AbortSignal) {
  const [positions, orders, algoOrders, mode] = await Promise.all([
    readBinance(config, 'positions', signal, symbol), readBinance(config, 'orders', signal, symbol),
    readBinance(config, 'algoOrders', signal, symbol), readBinance(config, 'positionMode', signal),
  ]);
  const matches = rows(positions);
  if (matches.length !== 1 || matches[0]!.symbol !== symbol || matches[0]!.positionSide !== 'BOTH' || object(mode).dualSidePosition !== false) throw new AccountError('unsupported_position', '未能确认目标币种的单向持仓，无法完整核验。');
  const raw = matches[0]!;
  const position = { quantity: amount(raw.positionAmt, '实际数量', true), entry: amount(raw.entryPrice, '实际均价'), liquidation: amount(raw.liquidationPrice, '当前强平价'), leverage: amount(raw.leverage, '实际杠杆'), isolated: raw.marginType === 'isolated', wallet: amount(raw.isolatedWallet, '逐仓钱包', true), updateTime: stamp(raw.updateTime) };
  return { position, orders: normalizeOrders(orders, symbol, false), algoOrders: normalizeOrders(algoOrders, symbol, true) };
}

export async function createPlan(config: Config, value: unknown): Promise<Plan> {
  const data = object(value);
  const keys = ['symbol', 'side', 'budgetMode', 'budget', 'stopMode', 'stop', 'slippage', 'funding', 'leverage', 'minimumBuffer', 'fundingCap'] as const;
  const optional = ['entryType', 'limitPrice', 'stopLevels', 'nearStopMode', 'nearStop', 'nearPercent'];
  if (Object.keys(data).some((key) => ![...keys, ...optional].includes(key)) || keys.some((key) => typeof data[key] !== 'string' || data[key].length > 34)
    || optional.some((key) => data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > 34))) throw new AccountError('invalid_input', '本次计划输入缺失或格式无效。', 400);
  const input = data as EntryInput;
  const signal = AbortSignal.timeout(10_000);
  const reviewAccountId = config.mode === 'demo' ? 'demo-account' : await readReviewIdentity(config, signal);
  const start = config.mode === 'demo' ? Date.now() : await serverTime(config, signal);
  const snapshot = await readMarket(config, input.symbol, signal);
  if (config.mode !== 'demo') {
    const state = await readState(config, input.symbol, signal);
    const end = await serverTime(config, signal);
    const trades = rows(await readBinance(config, 'trades', signal, input.symbol, { startTime: start, endTime: end }));
    if (state.position.quantity !== 0n || !state.position.isolated || state.orders.length || state.algoOrders.length || trades.length) throw new AccountError('unconfirmed_start', '生成期间持仓、成交或挂单发生变化，无法确认本单空仓起点，请处理后重新生成。');
  }
  if (config.mode !== 'demo' && await readReviewIdentity(config, signal) !== reviewAccountId) throw new AccountError('unverified_identity', '生成期间账户身份改变，未保存新方案；已有本单与归档保留。', 409);
  try { return { ...generateEntryPlan(input, snapshot), reviewAccountId, takerRate: snapshot.takerRate, id: randomUUID(), startedAt: new Date(start).toISOString(), account: snapshot.account }; }
  catch (error) { throw new AccountError('invalid_plan', error instanceof Error ? error.message : '无法生成正式方案。', 400); }
}

export async function verifyPosition(config: Config, plan: Plan, demo = 'missing-stop'): Promise<Verification> {
  if (config.mode === 'demo') return verifyDemo(config, plan, demo);
  const signal = AbortSignal.timeout(10_000);
  const uid = await readReviewIdentity(config, signal);
  if (plan.reviewAccountId && uid !== plan.reviewAccountId) throw new AccountError('unverified_identity', '账户身份与原方案不一致，已停止核验和新增归档。', 409);
  const account = await readAccount(config, undefined, signal);
  const before = await readState(config, plan.symbol, signal);
  const end = await serverTime(config, signal);
  const period = { startTime: Date.parse(plan.startedAt), endTime: end };
  const [tradeData, historyData, incomeData, exchangeData, feeData, markData, algoHistory] = await Promise.all([
    readBinance(config, 'trades', signal, plan.symbol, period), readBinance(config, 'history', signal, plan.symbol, period),
    readBinance(config, 'income', signal, plan.symbol, period), readBinance(config, 'exchange', signal),
    readBinance(config, 'fee', signal, plan.symbol), readBinance(config, 'mark', signal, plan.symbol),
    plan.nearStop ? readBinance(config, 'algoHistory', signal, plan.symbol, period) : [],
  ]);
  const after = await readState(config, plan.symbol, signal);
  if (serialize(before) !== serialize(after)) throw new AccountError('inconsistent_snapshot', '查询期间持仓或挂单发生变化，本次快照不一致，请重新刷新核验。');
  if (await readReviewIdentity(config, signal) !== uid) throw new AccountError('unverified_identity', '查询期间账户身份改变，已停止核验和新增归档。', 409);
  return recheckBeforeEntry(config, plan, { ...evaluate(plan, after, { trades: rows(tradeData), history: rows(historyData), algoHistory: rows(algoHistory), income: rows(incomeData), exchange: object(exchangeData), fee: object(feeData), mark: object(markData), start: period.startTime, end }), account }, signal);
}

async function recheckBeforeEntry(config: Config, plan: Plan, result: Verification, signal = AbortSignal.timeout(10_000)): Promise<Verification> {
  if (result.status !== 'waiting' || result.orderId || result.quantity !== '0' || result.pendingEntries?.length !== 0) return result;
  let snapshot: Snapshot;
  try {
    snapshot = await readMarket(config, plan.symbol, signal);
    if (config.mode !== 'demo') {
      const state = await readState(config, plan.symbol, signal);
      const end = await serverTime(config, signal);
      const trades = rows(await readBinance(config, 'trades', signal, plan.symbol, { startTime: Date.parse(plan.startedAt), endTime: end }));
      if (state.position.quantity !== 0n || !state.position.isolated || state.orders.length || state.algoOrders.length || trades.length)
        throw new AccountError('inconsistent_snapshot', '原卡检查期间持仓、挂单或成交发生变化，请刷新核验；不能继续按未开仓处理。');
    }
  }
  catch (error) {
    return { ...result, entryCheck: { status: 'incomplete', queriedAt: new Date().toISOString(), issue: error instanceof Error ? error.message : '当前账户与行情查询失败。' } };
  }
  try {
    const checked = recheckEntryPlan(plan, snapshot);
    return { ...result, entryCheck: { status: checked.liquidationIssue ? 'needs-action' : 'ready', queriedAt: snapshot.queriedAt,
      issue: checked.liquidationIssue, liquidationPrice: checked.liquidationPrice, liquidationBuffer: checked.liquidationBuffer,
      plannedLoss: checked.plannedLoss, fundingRequired: checked.fundingRequired } };
  } catch (error) {
    return { ...result, entryCheck: { status: 'needs-action', queriedAt: snapshot.queriedAt, issue: error instanceof Error ? error.message : '原卡已不适用，请重新生成。' } };
  }
}

async function verifyDemo(config: Config, plan: Plan, scenario: string): Promise<Verification> {
  const partial = ['partial', 'partial-more', 'canceled-remainder', 'stop-first'].includes(scenario);
  const nearFilled = ['near-filled', 'final-canceled', 'missing-attribution'].includes(scenario);
  const twoOnly = nearFilled || scenario === 'final-only';
  const limit = plan.execution.entryType === 'LIMIT';
  if ((!partial && !twoOnly && !['waiting', 'missing-stop', 'protected', 'failure'].includes(scenario)) || (partial && !limit) || (twoOnly && !plan.nearStop)) throw new AccountError('invalid_demo', '此入场方式或止损结构不支持该模拟场景。', 400);
  if (scenario === 'failure') throw new AccountError('demo_failure', '模拟查询失败：原方案与上次时间保留，通过状态已撤销。', 503);
  const snapshot = await readMarket(config, plan.symbol);
  const now = Date.now(), waiting = scenario === 'waiting', stopped = scenario === 'stop-first';
  const flat = waiting || stopped, total = amount(plan.quantity, '模拟数量'), entry = amount(plan.referencePrice, '模拟均价');
  const step = amount(snapshot.rules.lotSize.stepSize, '模拟数量步长');
  const half = total / 2n / step * step;
  let q = waiting ? 0n : total;
  if (partial) q = scenario === 'partial' ? half : total * 3n / 4n / step * step;
  if (partial && (half <= 0n || q <= 0n || q >= total)) throw new AccountError('invalid_demo', '模拟数量过小，无法展示部分成交；请调整模拟方案。', 400);
  const trade = (quantity: bigint, tradeId: number) => ({ symbol: plan.symbol, id: tradeId, orderId: 10, side: plan.execution.entrySide, positionSide: 'BOTH', time: now, price: plan.referencePrice, qty: formatDecimal(quantity), commission: formatDecimal(ceil(quantity * entry * amount(snapshot.takerRate, ''), SCALE * SCALE)), commissionAsset: 'USDT', realizedPnl: '0' });
  const trades = waiting ? [] : partial && q > half ? [trade(half, 1), trade(q - half, 2)] : [trade(q, 1)];
  let entryStatus = waiting ? 'NEW' : 'FILLED';
  if (partial) entryStatus = scenario === 'canceled-remainder' ? 'CANCELED' : 'PARTIALLY_FILLED';
  const order = { symbol: plan.symbol, orderId: 10, side: plan.execution.entrySide, positionSide: 'BOTH', type: plan.execution.entryType, origType: plan.execution.entryType, status: entryStatus,
    time: now, updateTime: now, price: plan.limitPrice || '0', origQty: plan.quantity, executedQty: formatDecimal(q), closePosition: false, reduceOnly: false, stopPrice: '0', workingType: 'CONTRACT_PRICE', priceProtect: false, timeInForce: 'GTC', goodTillDate: 0 };
  const history = waiting && !limit ? [] : [order];
  const split = plan.nearStop && q > 0n ? splitStopQuantity(q, plan.nearStop.percent, snapshot.rules) : null;
  const closed = stopped ? q : nearFilled && split ? split.near : 0n;
  const income: Record<string, unknown>[] = [];
  if (closed > 0n) {
    const triggerPrice = nearFilled && plan.nearStop ? plan.nearStop.price : plan.stopPrice;
    const stopPrice = amount(triggerPrice, '模拟止损价');
    const realizedPnl = formatDecimal((stopPrice - entry) * closed * (plan.side === 'long' ? 1n : -1n) / SCALE);
    trades.push({ ...trade(closed, 3), orderId: 11, side: plan.execution.stopSide, price: triggerPrice, commission: formatDecimal(ceil(closed * stopPrice * amount(snapshot.takerRate, ''), SCALE * SCALE)), realizedPnl });
    history.push({ ...order, orderId: 11, side: plan.execution.stopSide, type: 'MARKET', origType: 'STOP_MARKET', status: 'FILLED', origQty: formatDecimal(closed), executedQty: formatDecimal(closed), reduceOnly: true });
    if (scenario !== 'missing-attribution') income.push({ symbol: plan.symbol, incomeType: 'REALIZED_PNL', income: realizedPnl, tradeId: '3', asset: 'USDT', time: now });
  }
  const stop = { symbol: plan.symbol, algoId: 20, algoStatus: scenario === 'final-canceled' ? 'CANCELED' : 'NEW', orderType: 'STOP_MARKET', side: plan.execution.stopSide, positionSide: 'BOTH', quantity: '0', triggerPrice: plan.stopPrice, workingType: 'MARK_PRICE', closePosition: true, reduceOnly: false, priceProtect: false, actualOrderId: '', triggerTime: 0, createTime: now, updateTime: now, timeInForce: 'GTC', goodTillDate: 0 };
  const near = plan.nearStop && split ? { ...stop, algoId: 21, algoStatus: nearFilled ? 'FINISHED' : 'NEW', quantity: formatDecimal(split.near), triggerPrice: plan.nearStop.price, closePosition: false, reduceOnly: true, actualOrderId: nearFilled ? '11' : '', triggerTime: nearFilled ? now : 0 } : null;
  const protectedScenario = scenario === 'protected' || twoOnly || (partial && !stopped);
  const state: State = { position: { quantity: flat ? 0n : (q - closed) * (plan.side === 'long' ? 1n : -1n), entry: flat ? 0n : entry, liquidation: flat ? 0n : amount(plan.liquidationPrice, '模拟强平价'), leverage: amount(plan.leverage, '模拟杠杆'), isolated: true, wallet: 0n, updateTime: now },
    orders: normalizeOrders(limit && (waiting || (partial && scenario !== 'canceled-remainder')) ? [order] : [], plan.symbol, false),
    algoOrders: normalizeOrders(protectedScenario ? [stop, ...(near && !twoOnly ? [near] : [])] : [], plan.symbol, true) };
  const rules = snapshot.rules;
  const exchange = { symbols: [{ symbol: plan.symbol, status: 'TRADING', contractType: 'PERPETUAL', marginAsset: 'USDT', filters: [
    { filterType: 'PRICE_FILTER', minPrice: rules.minPrice, maxPrice: rules.maxPrice, tickSize: rules.tickSize },
    { filterType: 'LOT_SIZE', ...rules.lotSize }, { filterType: 'MARKET_LOT_SIZE', minQty: rules.minQty, maxQty: rules.maxQty, stepSize: rules.stepSize },
  ] }] };
  const algoHistory = plan.nearStop && protectedScenario ? [stop, ...(near && scenario !== 'final-only' ? [near] : [])] : [];
  return recheckBeforeEntry(config, plan, { ...evaluate(plan, state, { trades, history, algoHistory, income, exchange, fee: { symbol: plan.symbol, takerCommissionRate: snapshot.takerRate }, mark: { symbol: plan.symbol, markPrice: snapshot.mark, time: now }, start: Date.parse(plan.startedAt), end: now }), account: snapshot.account });
}

type State = Awaited<ReturnType<typeof readState>>;
type Records = { trades: Record<string, unknown>[]; history: Record<string, unknown>[]; algoHistory: Record<string, unknown>[]; income: Record<string, unknown>[]; exchange: Record<string, unknown>; fee: Record<string, unknown>; mark: Record<string, unknown>; start: number; end: number };

function recordStop(order: State['orders'][number]): RecordedStop {
  return {
    id: order.id, algo: order.algo, status: String(order.status), type: String(order.type), side: String(order.side), positionSide: String(order.positionSide),
    quantity: formatDecimal(order.quantity), executedQuantity: formatDecimal(order.executed), triggerPrice: formatDecimal(order.stop), workingType: String(order.workingType),
    closePosition: order.close, reduceOnly: order.reduce, priceProtect: order.protect, updateTime: order.updateTime,
    timeInForce: String(order.timeInForce), goodTillDate: order.goodTillDate, actualOrderId: order.actualOrderId, triggerTime: order.triggerTime,
  };
}

function recordedAmount(value: unknown, signed = false): string | null {
  try { return formatDecimal(amount(value, '历史金额', signed)); }
  catch { return null; }
}

// Identity depends on the flat baseline, fill/order chain and current position, not costs or compliance.
function confirmedEntryOrder(plan: Plan, state: State, data: Records, evidence: VerificationEvidence): string | null {
  try {
    const fills = [...evidence.fills].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (!evidence.snapshotConsistent || !fills.length || fills.length !== data.trades.length || fills.length >= 1000 || data.history.length >= 1000 || new Set(fills.map((fill) => fill.id)).size !== fills.length) return null;
    const direction = plan.side === 'long' ? 1n : -1n;
    let position = 0n;
    const entryOrders = new Set<string>();
    const quantities = new Map<string, bigint>();
    for (const [index, fill] of fills.entries()) {
      if (fill.symbol !== plan.symbol || fill.positionSide !== 'BOTH' || !['BUY', 'SELL'].includes(fill.side) || Date.parse(fill.time) < data.start || Date.parse(fill.time) > data.end) return null;
      const quantity = amount(fill.quantity, '成交数量');
      if (quantity <= 0n || amount(fill.price, '成交价') <= 0n) return null;
      if (fill.side === plan.execution.entrySide) entryOrders.add(fill.orderId);
      position += quantity * (fill.side === 'BUY' ? 1n : -1n);
      if (position * direction < 0n || (position === 0n && index < fills.length - 1)) return null;
      quantities.set(fill.orderId, (quantities.get(fill.orderId) ?? 0n) + quantity);
    }
    if (entryOrders.size !== 1 || fills[0]!.side !== plan.execution.entrySide || position !== state.position.quantity) return null;
    for (const order of data.history) {
      if (order.symbol !== plan.symbol || stamp(order.time) < data.start || stamp(order.time) > data.end || stamp(order.updateTime) > data.end) return null;
      if (!quantities.has(id(order.orderId)) && amount(order.executedQty, '订单成交量') > 0n) return null;
    }
    for (const [orderId, quantity] of quantities) {
      const matching = data.history.filter((order) => id(order.orderId) === orderId);
      if (matching.length !== 1 || amount(matching[0]!.executedQty, '订单成交量') !== quantity || fills.some((fill) => fill.orderId === orderId && (matching[0]!.side !== fill.side || matching[0]!.positionSide !== fill.positionSide))) return null;
    }
    const orderId = [...entryOrders][0]!;
    const order = data.history.find((order) => id(order.orderId) === orderId)!;
    return !flag(order.reduceOnly) && !flag(order.closePosition) ? orderId : null;
  } catch { return null; }
}

function evaluate(plan: Plan, state: State, data: Records): Verification {
  const { position } = state;
  const quantity = abs(position.quantity);
  const result: Verification = { status: 'incomplete', source: plan.source, queriedAt: new Date().toISOString(), issues: [], quantity: formatDecimal(quantity), side: position.quantity === 0n ? 'flat' : position.quantity > 0n ? 'long' : 'short', entryPrice: formatDecimal(position.entry), liquidationPrice: formatDecimal(position.liquidation), leverage: formatDecimal(position.leverage) };
  result.reviewEvidence = { startTime: data.start, endTime: data.end, entryOrderId: null,
    snapshotConsistent: position.updateTime <= data.end && (quantity === 0n || position.updateTime > 0) && [...state.orders, ...state.algoOrders].every((order) => order.updateTime <= data.end),
    fills: [], stops: [...state.orders, ...state.algoOrders].filter((order) => order.type === 'STOP_MARKET' || order.type === 'STOP').map(recordStop), historicalStops: [] };
  try { result.reviewEvidence.historicalStops = normalizeOrders(data.algoHistory, plan.symbol, true).map(recordStop); }
  catch { /* The verifier below reports malformed historical data; no trustworthy settings can be recorded. */ }

  try {
    result.reviewEvidence.fills = data.trades.map((row) => ({
      id: id(row.id), orderId: id(row.orderId), symbol: String(row.symbol), side: row.side as ReviewFill['side'], positionSide: row.positionSide as ReviewFill['positionSide'],
      quantity: formatDecimal(amount(row.qty, '成交数量')), price: formatDecimal(amount(row.price, '成交价格')), time: new Date(stamp(row.time)).toISOString(),
      realizedPnl: recordedAmount(row.realizedPnl, true), commission: recordedAmount(row.commission), commissionAsset: typeof row.commissionAsset === 'string' ? row.commissionAsset : null,
    }));
  } catch { result.reviewEvidence.fills = []; }
  result.reviewEvidence.entryOrderId = confirmedEntryOrder(plan, state, data, result.reviewEvidence);
  const incomplete = (message: string) => { result.issues.push(message); return result; };
  if (position.updateTime > data.end || (quantity > 0n && position.updateTime === 0) || [...state.orders, ...state.algoOrders].some((order) => order.updateTime > data.end)) return incomplete('持仓或挂单时间与本次查询不一致，请重新刷新。');
  // ponytail: one bounded history window; refuse a full page instead of silently truncating. Add pagination for longer/multi-order workflows.
  if ([data.trades, data.history, data.income, data.algoHistory].some((items) => items.length >= 1000)) return incomplete('历史记录达到查询上限，无法证明本单数据完整。');
  for (const items of [data.trades, data.history, data.income]) {
    if (items.some((row) => row.symbol !== plan.symbol || stamp(row.time) < data.start || stamp(row.time) > data.end)) return incomplete('历史记录币种或时间区间不一致，无法关联本单。');
  }
  if (data.algoHistory.some((row) => row.symbol !== plan.symbol || stamp(row.createTime) < data.start || stamp(row.createTime) > data.end || stamp(row.updateTime) > data.end)) return incomplete('条件单历史时间或币种不一致，无法关联本单。');
  if (new Set(data.algoHistory.map((row) => id(row.algoId))).size !== data.algoHistory.length) return incomplete('条件单历史重复，无法完整核验。');
  const isPending = (order: State['orders'][number]) => !['CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'FILLED', 'FINISHED', 'REJECTED'].includes(String(order.status));
  if (plan.nearStop) {
    const historical = normalizeOrders(data.algoHistory, plan.symbol, true);
    for (const current of state.algoOrders) {
      const recorded = historical.find((order) => order.id === current.id);
      if ((!recorded && isPending(current)) || (recorded && serialize(recorded) !== serialize(current))) return incomplete('当前条件单与历史记录不一致或缺失，请重新刷新核验。');
    }
    if (historical.some((order) => order.status === 'NEW' && !state.algoOrders.some((current) => current.id === order.id))) return incomplete('条件单历史仍有效但当前挂单缺失，两份快照不一致，请重新刷新核验。');
    for (const algo of historical.filter((order) => order.triggered)) {
      const actual = data.history.filter((order) => id(order.orderId) === algo.actualOrderId);
      if (actual.length !== 1 || !['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(String(actual[0]!.status))) return incomplete('已触发条件单的实际退出订单尚未结束或缺失，无法完整核验。');
    }
  }
  const pending = [...state.orders, ...state.algoOrders].filter(isPending);
  const entries = pending.filter((order) => !order.close && !order.reduce);
  if (entries.some((order) => order.quantity <= 0n || order.executed > order.quantity)) return incomplete('入场挂单数量无效，无法完整核验。');
  result.pendingEntries = entries.map((order) => ({ orderId: order.algo ? `条件单 ${order.id}` : order.id, filledQuantity: formatDecimal(order.executed), remainingQuantity: formatDecimal(order.quantity - order.executed) }));
  if (!position.isolated) result.issues.push('实际仓位不是逐仓模式，请在 Binance 检查；工具不改变账户模式。');
  if (entries.length && (data.trades.length || quantity > 0n || plan.execution.entryType !== 'LIMIT')) result.issues.push('存在未成交入场余单，请先在 Binance 撤销后刷新；止损或平仓后余单仍可能继续成交并重新形成仓位，不假定保护单会自动撤余单。');
  let limitOrder: Record<string, unknown> | undefined;
  if (plan.execution.entryType === 'LIMIT') {
    const candidates = data.history.filter((order) => order.side === plan.execution.entrySide && !flag(order.reduceOnly) && !flag(order.closePosition));
    if (candidates.length > 1) return incomplete('无法确认唯一限价开仓订单；多张开仓单或撤单重挂无法完整核验。');
    limitOrder = candidates[0];
    if (limitOrder) {
      const orderId = id(limitOrder.orderId);
      const original = amount(limitOrder.origQty, '原委托数量'), executed = amount(limitOrder.executedQty, '限价已成交数量');
      const price = amount(limitOrder.price, '限价委托价');
      const active = limitOrder.status === 'NEW' || limitOrder.status === 'PARTIALLY_FILLED';
      if (limitOrder.type !== 'LIMIT' || limitOrder.origType !== 'LIMIT' || limitOrder.positionSide !== 'BOTH' || limitOrder.timeInForce !== 'GTC' || price !== amount(plan.limitPrice, '原限价')) return incomplete('实际开仓不是原价格的普通 GTC 限价单，无法完整核验。');
      const validStatus = (limitOrder.status === 'NEW' && executed === 0n)
        || (limitOrder.status === 'PARTIALLY_FILLED' && executed > 0n && executed < original)
        || (limitOrder.status === 'FILLED' && executed === original)
        || (['CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(String(limitOrder.status)) && executed < original)
        || (limitOrder.status === 'REJECTED' && executed === 0n);
      if (original <= 0n || executed > original || stamp(limitOrder.updateTime) > data.end || !validStatus) return incomplete('限价订单状态或成交数量不一致，无法完整核验。');
      const open = entries.filter((order) => !order.algo && order.id === orderId);
      const current = open[0];
      const matchesCurrent = open.length === 1 && current && current.status === limitOrder.status && current.type === 'LIMIT'
        && current.side === plan.execution.entrySide && current.positionSide === 'BOTH' && current.timeInForce === 'GTC'
        && current.price === price && current.quantity === original && current.executed === executed;
      if ((active && !matchesCurrent) || (!active && open.length !== 0)) return incomplete('限价历史与当前余单无法对账，请刷新确认是否已撤销。');
      if (entries.some((order) => order.algo || order.id !== orderId)) return incomplete('存在其他可开仓委托，无法可靠关联唯一限价订单。');
      result.orderId = orderId;
      result.entryStatus = String(limitOrder.status);
      result.filledQuantity = formatDecimal(executed);
    } else if (entries.length) return incomplete('入场挂单缺少对应历史，无法关联本单。');
  }
  if (!data.trades.length) {
    if (quantity !== 0n || data.history.some((order) => amount(order.executedQty, '历史成交数量') !== 0n)) return incomplete('实际仓位与本单成交记录无法对账，无法可靠关联。');
    if (data.income.some((income) => amount(income.income, '账户收支', true) !== 0n)) return incomplete('尚无成交但存在本单区间收支，无法可靠归属，无法完整核验。');
    if (limitOrder && !['NEW', 'PARTIALLY_FILLED'].includes(String(limitOrder.status))) {
      if (pending.length) result.issues.push('入场已结束但仍有挂单，请在 Binance 处理后刷新。');
      result.status = result.issues.length ? 'needs-action' : 'ended';
      if (!result.issues.length) result.issues.push(limitOrder.status === 'CANCELED' ? '已结束 · 未成交已撤销；这不是止损核验通过。' : '已结束 · 入场未成交且已失效；这不是止损核验通过。');
      return result;
    }
    result.status = result.issues.length ? 'needs-action' : 'waiting';
    if (!result.issues.length) result.issues.push(limitOrder ? '挂单待成交：尚无实际持仓，不能核验止损通过。' : '待成交：本单起点后尚无成交，空仓不表示止损通过。');
    return result;
  }
  const direction = plan.side === 'long' ? 1n : -1n;
  const entrySide = plan.execution.entrySide;
  const tradeIds = new Set<string>();
  let total = 0n, closed = 0n, cost = 0n, commission = 0n, realizedPnl = 0n;
  const executedByOrder = new Map<string, bigint>();
  const sortedTrades = [...data.trades].sort((a, b) => stamp(a.time) - stamp(b.time) || (BigInt(id(a.id)) < BigInt(id(b.id)) ? -1 : 1));
  for (const trade of sortedTrades) {
    const tradeId = id(trade.id);
    if (tradeIds.has(tradeId)) return incomplete('成交记录重复，无法确认本单成本。');
    tradeIds.add(tradeId);
    const realized = amount(trade.realizedPnl, '已实现损益', true);
    if (trade.positionSide !== 'BOTH' || (trade.side !== 'BUY' && trade.side !== 'SELL')) return incomplete('成交方向或持仓模式不明，无法完整核验。');
    if (trade.commissionAsset !== 'USDT') return incomplete('成交手续费不是 USDT，缺少可靠换算，无法完整核验。');
    const q = amount(trade.qty, '成交数量'), price = amount(trade.price, '成交价格');
    if (q <= 0n || price <= 0n) return incomplete('成交价格或数量无效，无法完整核验。');
    if (trade.side === entrySide) {
      if (closed > 0n || realized !== 0n) return incomplete('存在重新开仓或开仓成交包含已实现损益，无法关联原单。');
      if (plan.execution.entryType === 'LIMIT' && direction * (price - amount(plan.limitPrice, '原限价')) > 0n) return incomplete('实际入场成交突破原限价，记录与方案不一致，无法完整核验。');
      total += q;
      cost += q * price;
    } else {
      closed += q;
      if (closed > total) return incomplete('存在反向开仓，无法关联原单。');
      if (plan.nearStop && abs(realized * SCALE * total - direction * (price * total - cost) * q) > SCALE * total) return incomplete('已实现损益与可归属成交价格不一致，无法完整核验。');
      realizedPnl += realized;
    }
    const orderId = id(trade.orderId);
    executedByOrder.set(orderId, (executedByOrder.get(orderId) ?? 0n) + q);
    commission += amount(trade.commission, '已付手续费');
  }
  for (const [orderId, executed] of executedByOrder) {
    const matches = data.history.filter((item) => id(item.orderId) === orderId);
    if (matches.length !== 1 || amount(matches[0]!.executedQty, '订单已成交量') !== executed) return incomplete('订单历史与成交明细不完整或无法对账。');
    if (data.trades.some((trade) => id(trade.orderId) === orderId && (trade.side !== matches[0]!.side || trade.positionSide !== matches[0]!.positionSide))) return incomplete('成交方向与对应订单不一致，无法完整核验。');
  }
  if (data.history.some((item) => !executedByOrder.has(id(item.orderId)) && amount(item.executedQty, '历史成交数量') > 0n)) return incomplete('还有其他已成交订单，无法完整关联本单。');
  const orderIds = new Set(data.trades.filter((trade) => trade.side === entrySide).map((trade) => id(trade.orderId)));
  const entry = data.history.filter((order) => orderIds.has(id(order.orderId)));
  if (orderIds.size !== 1 || entry.length !== 1) return incomplete('本单起点后无法确认唯一开仓订单，不猜测多笔订单的归属。');
  const order = entry[0]!;
  const matchesEntry = plan.execution.entryType === 'LIMIT' ? order === limitOrder
    : order.type === 'MARKET' && order.origType === 'MARKET' && order.side === entrySide && order.positionSide === 'BOTH' && !flag(order.reduceOnly) && !flag(order.closePosition) && order.status === 'FILLED';
  if (!matchesEntry) return incomplete('未确认本单的唯一同方向开仓订单，无法完整核验。');
  if (position.quantity !== direction * (total - closed)) return incomplete('实际方向、数量与本单成交记录不一致，可能存在加仓或部分平仓。');
  result.orderId = id(order.orderId);
  result.filledQuantity = formatDecimal(total);
  let funding = 0n;
  const fundingIds = new Set<string>();
  const pnlIds = new Set<string>();
  const commissionIds = new Set<string>();
  const firstTrade = Math.min(...data.trades.map((trade) => stamp(trade.time)));
  for (const income of data.income) {
    if (income.incomeType !== 'FUNDING_FEE') {
      if (plan.nearStop && income.incomeType === 'COMMISSION') {
        const tradeId = id(income.tradeId);
        const trade = data.trades.find((item) => id(item.id) === tradeId);
        if (commissionIds.has(tradeId) || income.asset !== 'USDT' || !trade || amount(income.income, '手续费收支', true) !== -amount(trade.commission, '成交手续费')) return incomplete('手续费收支无法与本单成交对应，无法完整核验。');
        commissionIds.add(tradeId);
      }
      if (closed === 0n && income.incomeType === 'REALIZED_PNL' && amount(income.income, '已实现损益', true) !== 0n) return incomplete('收支记录包含已实现损益，与未平仓的成交链不一致。');
      if (closed > 0n && income.incomeType === 'REALIZED_PNL') {
        const tradeId = id(income.tradeId);
        const trade = data.trades.find((item) => id(item.id) === tradeId);
        if (pnlIds.has(tradeId) || income.asset !== 'USDT' || !trade || trade.side === entrySide || amount(income.income, '已实现损益', true) !== amount(trade.realizedPnl, '成交损益', true)) return incomplete('已实现损益无法与本单平仓成交对应，无法完整核验。');
        pnlIds.add(tradeId);
      }
      if (!['COMMISSION', 'REALIZED_PNL'].includes(String(income.incomeType)) && amount(income.income, '账户收支', true) < 0n) return incomplete('存在尚无法归属的其他费用支出，无法完整核验。');
      continue;
    }
    if (income.asset !== 'USDT' || stamp(income.time) < firstTrade) return incomplete('资金费资产或发生时间无法关联本单。');
    const fundingId = id(income.tranId);
    if (fundingIds.has(fundingId)) return incomplete('资金费记录重复，无法完整核验。');
    fundingIds.add(fundingId);
    funding += max(0n, -amount(income.income, '已付资金费', true));
  }
  result.paidCommission = formatDecimal(commission);
  result.paidFunding = formatDecimal(funding);
  if (plan.nearStop && closed > 0n && data.trades.some((trade) => trade.side !== entrySide && amount(trade.realizedPnl, '成交损益', true) !== 0n && !pnlIds.has(id(trade.id)))) return incomplete('本单已实现损益收支缺失，无法完整核验。');
  if (closed > 0n) {
    if (quantity === 0n) {
      if (pending.length) result.issues.push('当前已平仓，但仍有挂单，请在 Binance 处理后刷新。');
      result.status = result.issues.length ? 'needs-action' : 'ended';
      if (!result.issues.length) result.issues.push('已结束：本单开平仓成交与空仓对账一致；这不是止损核验通过。');
      return result;
    }
    if (!plan.nearStop) return incomplete('已发生部分平仓，本期单层方案无法完整核验本单损益与剩余敞口，请在 Binance 检查。');
    const closingIds = new Set(data.trades.filter((trade) => trade.side !== entrySide).map((trade) => id(trade.orderId)));
    for (const orderId of closingIds) {
      const matches = data.algoHistory.filter((row) => row.actualOrderId !== '' && row.actualOrderId !== '0' && id(row.actualOrderId) === orderId);
      if (matches.length !== 1) return incomplete('近端成交缺少唯一历史条件单关联，无法完整核验。');
      const raw = matches[0]!;
      const algo = normalizeOrders([raw], plan.symbol, true)[0]!;
      const executed = executedByOrder.get(orderId)!;
      const fills = data.trades.filter((trade) => id(trade.orderId) === orderId);
      const order = data.history.find((item) => id(item.orderId) === orderId)!;
      if (!['TRIGGERED', 'FINISHED'].includes(String(algo.status)) || !algo.triggered || algo.type !== 'STOP_MARKET'
        || algo.side !== plan.execution.stopSide || algo.positionSide !== 'BOTH' || algo.close || !algo.reduce || algo.protect
        || algo.workingType !== 'MARK_PRICE' || algo.stop !== amount(plan.nearStop.price, '原近端止损')
        || algo.quantity < executed || algo.quantity !== amount(order.origQty, '近端委托数量')
        || order.type !== 'MARKET' || !flag(order.reduceOnly) || flag(order.closePosition)
        || !['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(String(order.status))
        || (order.status === 'FILLED' && executed !== algo.quantity) || stamp(order.updateTime) > data.end
        || stamp(raw.triggerTime) < stamp(raw.createTime) || fills.some((trade) => stamp(trade.time) < stamp(raw.triggerTime))
        || (algo.timeInForce !== 'GTC' && (algo.timeInForce !== 'GTD' || algo.goodTillDate <= stamp(raw.triggerTime)))) return incomplete('部分退出无法归属于原近端止损及成交链，无法完整核验。');
    }
  }
  result.realizedPnl = formatDecimal(realizedPnl);
  // Binance reports a rounded average; tolerate at most one 8-decimal price unit, never a quantity difference.
  if (position.entry <= 0n || abs(cost - position.entry * total) > total) return incomplete('实际均价与成交记录不一致，无法完整核验。');
  const fee = amount(data.fee.takerCommissionRate, '当前退出费率');
  const mark = amount(data.mark.markPrice, '当前标记价');
  if (data.fee.symbol !== plan.symbol || data.mark.symbol !== plan.symbol || fee >= SCALE || mark <= 0n || Math.abs(stamp(data.mark.time) - data.end) > 30_000) return incomplete('当前费率或标记价缺失、过期或币种不一致。');
  const stop = amount(plan.stopPrice, '原绝对止损价');
  const budget = amount(plan.budget, '原预算');
  const remainingFunding = max(0n, amount(plan.funding, '原资金费预留') - funding);
  const exit = stop * (PERCENT - direction * amount(plan.slippagePercent, '原滑点'));
  // Allocate remaining cost using the exact original average cost/total; never round that average.
  // A common denominator combines the remaining price loss, signed realized PnL and all costs.
  const denominator = 10n ** 26n * total;
  const loss = max(0n, direction * (cost * quantity * PERCENT - exit * quantity * total) * SCALE - realizedPnl * denominator)
    + quantity * exit * fee * total + (commission + funding + remainingFunding) * denominator;
  result.plannedLoss = formatDecimal(ceil(loss, denominator));
  result.excess = formatDecimal(ceil(max(0n, loss - budget * denominator), denominator));
  result.remainingFunding = formatDecimal(remainingFunding);
  result.exitFee = formatDecimal(ceil(quantity * exit * fee, 10n ** 26n));
  if (loss > budget * denominator) result.issues.push(`按原止损 ${plan.stopPrice} 计算的亏损 ${result.plannedLoss} USDT 超过原预算 ${plan.budget} USDT，超额 ${result.excess} USDT。请在 Binance 处理风险敞口；具体减仓量需包含减仓成交成本，本期不提供无法可靠复核的减仓数量。`);
  if (position.leverage <= 0n || position.leverage % SCALE !== 0n) return incomplete('实际杠杆数据无效。');
  if (position.leverage > amount(plan.leverage, '原杠杆')) result.issues.push(`实际杠杆 ${result.leverage} 倍高于原方案 ${plan.leverage} 倍，请在 Binance 调整后刷新。`);
  const gap = direction * (stop - position.liquidation);
  const minimum = amount(plan.minimumBuffer, '最低强平缓冲');
  if (position.liquidation <= 0n || minimum <= 0n) return incomplete('当前强平价或最低缓冲缺失，无法完整核验。');
  result.liquidationBuffer = formatDecimal(gap * PERCENT * total / cost);
  if (gap <= 0n || gap * PERCENT * total < minimum * cost) result.issues.push(`当前强平缓冲 ${result.liquidationBuffer}% 低于要求 ${plan.minimumBuffer}%，差 ${formatDecimal(ceil(minimum * cost - gap * PERCENT * total, cost))} 个百分点；请在 Binance 降低杠杆或增加逐仓保证金后刷新，不改动原止损。`);
  if (direction * (mark - stop) <= 0n) result.issues.push('当前标记价已达到原止损条件，尚有持仓；请立即在 Binance 检查实际执行状态。');
  const contracts = rows(data.exchange.symbols).filter((contract) => contract.symbol === plan.symbol);
  if (contracts.length !== 1 || contracts[0]!.status !== 'TRADING' || (contracts[0]!.contractType !== 'PERPETUAL' && contracts[0]!.contractType !== 'TRADIFI_PERPETUAL') || contracts[0]!.marginAsset !== 'USDT') return incomplete('当前合约状态或规则无法确认。');
  const filters = rows(contracts[0]!.filters);
  const filter = (name: string) => {
    const matches = filters.filter((item) => item.filterType === name);
    if (matches.length !== 1) throw new AccountError('invalid_rules', '当前退出规则缺失或重复，无法完整核验。');
    return matches[0]!;
  };
  const price = filter('PRICE_FILTER');
  const tick = amount(price.tickSize, '价格步长'), minPrice = amount(price.minPrice, '最小价格'), maxPrice = amount(price.maxPrice, '最大价格');
  if (tick <= 0n) return incomplete('当前价格步长不支持，无法完整核验。');
  const checkProtection = (protection: State['orders'][number], stop: bigint, expected: bigint, partial = false) => {
    if (protection.status !== 'NEW' || protection.triggered || protection.executed !== 0n) result.issues.push('止损已触发、执行或失效，不能作为有效保护。');
    if (protection.side !== plan.execution.stopSide || protection.positionSide !== 'BOTH') result.issues.push(`止损平仓方向不符，应为单向持仓 ${plan.execution.stopSide}。`);
    if (protection.type !== 'STOP_MARKET') result.issues.push('止损类型不符，应为止损市价 STOP_MARKET。');
    if (protection.stop !== stop) result.issues.push(`止损触发价 ${formatDecimal(protection.stop)} 不符，应保持原绝对止损 ${formatDecimal(stop)} USDT。`);
    if (protection.workingType !== 'MARK_PRICE') result.issues.push('触发依据不符，应使用标记价 MARK_PRICE。');
    if (protection.protect) result.issues.push('价格保护已开启，请在 Binance 关闭价格保护后刷新。');
    if (protection.timeInForce !== 'GTC' && (protection.timeInForce !== 'GTD' || protection.goodTillDate <= data.end)) result.issues.push('止损有效期无效或已经到期，请在 Binance 重新设置。');
    if (stop < minPrice || (maxPrice > 0n && stop > maxPrice) || (stop - minPrice) % tick !== 0n) result.issues.push('原止损不符合当前价格规则，请在 Binance 检查，工具不会移动原止损。');
    if (partial && protection.close) result.issues.push('近端须按分配数量只减仓，不能整仓退出。');
    if (!protection.close) {
      if (!protection.reduce) result.issues.push('固定数量退出必须具有只减仓语义。');
      if (protection.quantity !== expected) result.issues.push(`固定止损数量 ${formatDecimal(protection.quantity)} ${plan.baseAsset} 与${partial ? '近端应退出' : '实际'} ${formatDecimal(expected)} 不符${protection.quantity < expected ? `，覆盖缺口 ${formatDecimal(expected - protection.quantity)} ${plan.baseAsset}` : '，不得超量'}；请在 Binance 修正退出数量。`);
      for (const name of ['LOT_SIZE', 'MARKET_LOT_SIZE']) {
        const lot = filter(name);
        const minimum = amount(lot.minQty, '退出最小数量'), maximum = amount(lot.maxQty, '退出最大数量'), step = amount(lot.stepSize, '退出数量步长');
        if (maximum <= 0n || maximum < minimum || step <= 0n) throw new AccountError('invalid_rules', '当前退出数量规则无效或不支持。');
        if (protection.quantity < minimum || protection.quantity > maximum || (protection.quantity - minimum) % step !== 0n) result.issues.push(`固定止损不符合 ${name} 数量规则：范围 ${formatDecimal(minimum)}–${formatDecimal(maximum)}，步长 ${formatDecimal(step)}；只减仓不豁免数量规则，可在 Binance 检查整仓退出方式。`);
      }
      if (!partial) result.coverage = `固定数量 ${formatDecimal(protection.quantity)} ${plan.baseAsset} · 只减仓，仅覆盖当前数量`;
    }
    else if (protection.quantity !== 0n) result.issues.push('整仓止损同时包含固定数量，平仓语义无法确认。');
    else if (!partial) result.coverage = '整仓退出';
  };
  const protections = pending.filter((item) => item.close || item.reduce || item.type === 'STOP_MARKET');
  if (plan.nearStop) {
    const lot = (name: string) => {
      const row = filter(name);
      return { minQty: formatDecimal(amount(row.minQty, '退出最小数量')), maxQty: formatDecimal(amount(row.maxQty, '退出最大数量')), stepSize: formatDecimal(amount(row.stepSize, '退出数量步长')) };
    };
    let split;
    try { split = splitStopQuantity(total, plan.nearStop.percent, { ...lot('MARKET_LOT_SIZE'), lotSize: lot('LOT_SIZE') }); }
    catch (error) {
      result.issues.push(error instanceof Error ? error.message : '当前数量无法按原比例分层。');
      result.status = 'needs-action';
      return result;
    }
    const remainingNear = max(0n, split.near - closed);
    result.nearQuantity = formatDecimal(remainingNear);
    result.nearActualPercent = split.actualPercent;
    result.nearStatus = closed === 0n ? '待核验' : closed === split.near ? '已执行' : '执行量偏差，需处理';
    const nearPrice = amount(plan.nearStop.price, '原近端止损');
    const final = protections.filter((item) => item.stop === stop);
    const near = protections.filter((item) => item.stop === nearPrice);
    if (final.length !== 1) result.issues.push('最终止损缺失或重复，请先确保整仓有原最终止损保护。');
    else {
      checkProtection(final[0]!, stop, quantity);
      if (!final[0]!.close) result.issues.push('双层最终止损须为整仓退出，保护触发时全部剩余仓位。');
    }
    if (closed > split.near) result.issues.push('近端累计退出超过原比例分配量，请核对实际执行；不会改变原预算或止损。');
    if (remainingNear === 0n) {
      if (near.length) result.issues.push('近端已执行，仍存在近端退出委托，请在 Binance 清理后刷新。');
    } else if (near.length !== 1) result.issues.push('近端计划仍待补齐或存在重复，请按原近端触发价和当前分配数量设置只减仓止损。');
    else {
      const previousIssues = result.issues.length;
      checkProtection(near[0]!, nearPrice, remainingNear, true);
      if (result.issues.length === previousIssues) result.nearStatus = closed > 0n ? '部分执行，剩余近端有效待触发' : '有效待触发';
    }
    if (remainingNear > 0n && direction * (mark - nearPrice) <= 0n) result.issues.push('当前标记价已达到原近端止损条件，请在 Binance 检查执行状态。');
    if (protections.some((item) => item.stop !== stop && item.stop !== nearPrice)) result.issues.push('存在原双层方案之外的退出委托，请在 Binance 整理后刷新。');
  } else if (protections.length !== 1) {
    result.issues.push(`需要一张有效单层止损，目前找到 ${protections.length} 张候选；请在 Binance 设置或整理 ${plan.execution.stopSide} 止损市价、标记价 ${plan.stopPrice}、关闭价格保护、整仓退出。`);
  } else {
    checkProtection(protections[0]!, stop, quantity);
  }
  result.status = result.issues.length ? 'needs-action' : 'verified';
  return result;
}
