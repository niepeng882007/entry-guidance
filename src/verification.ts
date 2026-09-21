import { randomUUID } from 'node:crypto';
import { AccountError, object, readAccount, readBinance, type AccountConfig } from './account.ts';
import { readMarket } from './market.ts';
import { generateEntryPlan, parseDecimal, formatDecimal, type EntryInput, type Snapshot } from '../public/draft.js';

type Config = AccountConfig & { mode?: 'real' | 'demo' };
const SCALE = 100_000_000n;
const PERCENT = 100n * SCALE;
const abs = (value: bigint) => value < 0n ? -value : value;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const ceil = (value: bigint, denominator: bigint) => (value + denominator - 1n) / denominator;
export type Plan = ReturnType<typeof generateEntryPlan> & { id: string; startedAt: string; account: Snapshot['account'] };
export type Verification = {
  status: 'waiting' | 'ended' | 'incomplete' | 'needs-action' | 'verified';
  source: 'demo' | 'binance'; queriedAt: string; issues: string[];
  quantity?: string; entryPrice?: string; liquidationPrice?: string; leverage?: string;
  side?: 'long' | 'short' | 'flat';
  orderId?: string; plannedLoss?: string; excess?: string; liquidationBuffer?: string;
  paidCommission?: string; paidFunding?: string; remainingFunding?: string; exitFee?: string; coverage?: string;
  account?: Snapshot['account'];
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
    return { id: id(algo ? row.algoId : row.orderId), algo, status: algo ? row.algoStatus : row.status,
      type: algo ? row.orderType : row.type, side: row.side, positionSide: row.positionSide,
      quantity: amount(algo ? row.quantity : row.origQty, '挂单数量'), executed: algo ? 0n : amount(row.executedQty, '挂单已成交数量'),
      stop: amount(algo ? row.triggerPrice : row.stopPrice, '挂单触发价'), workingType: row.workingType,
      close: flag(row.closePosition), reduce: flag(row.reduceOnly), protect: flag(row.priceProtect),
      triggered: algo && (stamp(row.triggerTime) !== 0 || (row.actualOrderId !== '' && row.actualOrderId !== '0')),
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
  if (Object.keys(data).length !== keys.length || keys.some((key) => typeof data[key] !== 'string' || data[key].length > 34)) throw new AccountError('invalid_input', '本次计划输入缺失或格式无效。', 400);
  const input = data as EntryInput;
  const signal = AbortSignal.timeout(10_000);
  const start = config.mode === 'demo' ? Date.now() : await serverTime(config, signal);
  const snapshot = await readMarket(config, input.symbol, signal);
  if (config.mode !== 'demo') {
    const state = await readState(config, input.symbol, signal);
    const end = await serverTime(config, signal);
    const trades = rows(await readBinance(config, 'trades', signal, input.symbol, { startTime: start, endTime: end }));
    if (state.position.quantity !== 0n || !state.position.isolated || state.orders.length || state.algoOrders.length || trades.length) throw new AccountError('unconfirmed_start', '生成期间持仓、成交或挂单发生变化，无法确认本单空仓起点，请处理后重新生成。');
  }
  try { return { ...generateEntryPlan(input, snapshot), id: randomUUID(), startedAt: new Date(start).toISOString(), account: snapshot.account }; }
  catch (error) { throw new AccountError('invalid_plan', error instanceof Error ? error.message : '无法生成正式方案。', 400); }
}

export async function verifyPosition(config: Config, plan: Plan, demo = 'missing-stop'): Promise<Verification> {
  if (config.mode === 'demo') return verifyDemo(config, plan, demo);
  const signal = AbortSignal.timeout(10_000);
  const account = await readAccount(config, undefined, signal);
  const before = await readState(config, plan.symbol, signal);
  const end = await serverTime(config, signal);
  const period = { startTime: Date.parse(plan.startedAt), endTime: end };
  const [tradeData, historyData, incomeData, exchangeData, feeData, markData] = await Promise.all([
    readBinance(config, 'trades', signal, plan.symbol, period), readBinance(config, 'history', signal, plan.symbol, period),
    readBinance(config, 'income', signal, plan.symbol, period), readBinance(config, 'exchange', signal),
    readBinance(config, 'fee', signal, plan.symbol), readBinance(config, 'mark', signal, plan.symbol),
  ]);
  const after = await readState(config, plan.symbol, signal);
  const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  if (serialize(before) !== serialize(after)) throw new AccountError('inconsistent_snapshot', '查询期间持仓或挂单发生变化，本次快照不一致，请重新刷新核验。');
  return { ...evaluate(plan, after, { trades: rows(tradeData), history: rows(historyData), income: rows(incomeData), exchange: object(exchangeData), fee: object(feeData), mark: object(markData), start: period.startTime, end }), account };
}

async function verifyDemo(config: Config, plan: Plan, scenario: string): Promise<Verification> {
  if (!['waiting', 'missing-stop', 'protected', 'failure'].includes(scenario)) throw new AccountError('invalid_demo', '模拟场景无效。', 400);
  if (scenario === 'failure') throw new AccountError('demo_failure', '模拟查询失败：原方案与上次时间保留，通过状态已撤销。', 503);
  const snapshot = await readMarket(config, plan.symbol);
  const now = Date.now(), flat = scenario === 'waiting', q = amount(plan.quantity, '模拟数量'), entry = amount(plan.referencePrice, '模拟均价');
  const trade = { symbol: plan.symbol, id: 1, orderId: 10, side: plan.execution.entrySide, positionSide: 'BOTH', time: now, price: plan.referencePrice, qty: plan.quantity, commission: formatDecimal(ceil(q * entry * amount(snapshot.takerRate, ''), SCALE * SCALE)), commissionAsset: 'USDT', realizedPnl: '0' };
  const history = { symbol: plan.symbol, orderId: 10, side: plan.execution.entrySide, positionSide: 'BOTH', type: 'MARKET', origType: 'MARKET', status: 'FILLED', time: now, executedQty: plan.quantity, closePosition: false, reduceOnly: false };
  const stop = { symbol: plan.symbol, algoId: 20, algoStatus: 'NEW', orderType: 'STOP_MARKET', side: plan.execution.stopSide, positionSide: 'BOTH', quantity: '0', triggerPrice: plan.stopPrice, workingType: 'MARK_PRICE', closePosition: true, reduceOnly: false, priceProtect: false, actualOrderId: '', triggerTime: 0, updateTime: now, timeInForce: 'GTC', goodTillDate: 0 };
  const state: State = { position: { quantity: flat ? 0n : q * (plan.side === 'long' ? 1n : -1n), entry: flat ? 0n : entry, liquidation: flat ? 0n : amount(plan.liquidationPrice, '模拟强平价'), leverage: amount(plan.leverage, '模拟杠杆'), isolated: true, wallet: 0n, updateTime: now }, orders: [], algoOrders: normalizeOrders(scenario === 'protected' ? [stop] : [], plan.symbol, true) };
  const rules = snapshot.rules;
  const exchange = { symbols: [{ symbol: plan.symbol, status: 'TRADING', contractType: 'PERPETUAL', marginAsset: 'USDT', filters: [
    { filterType: 'PRICE_FILTER', minPrice: rules.minPrice, maxPrice: rules.maxPrice, tickSize: rules.tickSize },
    { filterType: 'LOT_SIZE', ...rules.lotSize }, { filterType: 'MARKET_LOT_SIZE', minQty: rules.minQty, maxQty: rules.maxQty, stepSize: rules.stepSize },
  ] }] };
  return { ...evaluate(plan, state, { trades: flat ? [] : [trade], history: flat ? [] : [history], income: [], exchange, fee: { symbol: plan.symbol, takerCommissionRate: snapshot.takerRate }, mark: { symbol: plan.symbol, markPrice: snapshot.mark, time: now }, start: Date.parse(plan.startedAt), end: now }), account: snapshot.account };
}

type State = Awaited<ReturnType<typeof readState>>;
type Records = { trades: Record<string, unknown>[]; history: Record<string, unknown>[]; income: Record<string, unknown>[]; exchange: Record<string, unknown>; fee: Record<string, unknown>; mark: Record<string, unknown>; start: number; end: number };

function evaluate(plan: Plan, state: State, data: Records): Verification {
  const { position } = state;
  const quantity = abs(position.quantity);
  const result: Verification = { status: 'incomplete', source: plan.source, queriedAt: new Date().toISOString(), issues: [], quantity: formatDecimal(quantity), side: position.quantity === 0n ? 'flat' : position.quantity > 0n ? 'long' : 'short', entryPrice: formatDecimal(position.entry), liquidationPrice: formatDecimal(position.liquidation), leverage: formatDecimal(position.leverage) };
  const incomplete = (message: string) => { result.issues.push(message); return result; };
  if (position.updateTime > data.end || (quantity > 0n && position.updateTime === 0) || [...state.orders, ...state.algoOrders].some((order) => order.updateTime > data.end)) return incomplete('持仓或挂单时间与本次查询不一致，请重新刷新。');
  // ponytail: one bounded history window; refuse a full page instead of silently truncating. Add pagination for longer/multi-order workflows.
  if ([data.trades, data.history, data.income].some((items) => items.length >= 1000)) return incomplete('历史记录达到查询上限，无法证明本单数据完整。');
  for (const items of [data.trades, data.history, data.income]) {
    if (items.some((row) => row.symbol !== plan.symbol || stamp(row.time) < data.start || stamp(row.time) > data.end)) return incomplete('历史记录币种或时间区间不一致，无法关联本单。');
  }
  const pending = [...state.orders, ...state.algoOrders].filter((order) => !['CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'FILLED', 'FINISHED', 'REJECTED'].includes(String(order.status)));
  if (!position.isolated) result.issues.push('实际仓位不是逐仓模式，请在 Binance 检查；工具不改变账户模式。');
  if (pending.some((order) => !order.close && !order.reduce)) result.issues.push('存在未成交入场余单或可增加仓位的委托，请先在 Binance 处理后刷新。');
  if (!data.trades.length) {
    if (quantity !== 0n || data.history.some((order) => amount(order.executedQty, '历史成交数量') !== 0n)) return incomplete('实际仓位与本单成交记录无法对账，无法可靠关联。');
    result.status = result.issues.length ? 'needs-action' : 'waiting';
    if (!result.issues.length) result.issues.push('待成交：本单起点后尚无成交，空仓不表示止损通过。');
    return result;
  }
  const direction = plan.side === 'long' ? 1n : -1n;
  const entrySide = plan.execution.entrySide;
  const tradeIds = new Set<string>();
  let total = 0n, closed = 0n, cost = 0n, commission = 0n;
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
      total += q;
      cost += q * price;
    } else {
      closed += q;
      if (closed > total) return incomplete('存在反向开仓，无法关联原单。');
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
  if (order.type !== 'MARKET' || order.origType !== 'MARKET' || order.side !== entrySide || order.positionSide !== 'BOTH' || flag(order.reduceOnly) || flag(order.closePosition) || order.status !== 'FILLED') return incomplete('未确认单笔已完成的同方向市价开仓，无法完整核验。');
  if (position.quantity !== direction * (total - closed)) return incomplete('实际方向、数量与本单成交记录不一致，可能存在加仓或部分平仓。');
  result.orderId = id(order.orderId);
  if (closed > 0n) {
    if (quantity > 0n) return incomplete('已发生部分平仓，本期无法完整核验本单损益与剩余敞口，请在 Binance 检查。');
    if (pending.length) result.issues.push('实际仓位已结束，但仍有挂单，请在 Binance 处理后刷新。');
    result.status = result.issues.length ? 'needs-action' : 'ended';
    if (!result.issues.length) result.issues.push('已结束：本单开平仓成交与空仓对账一致；这不是止损核验通过。');
    return result;
  }
  // Binance reports a rounded average; tolerate at most one 8-decimal price unit, never a quantity difference.
  if (position.entry <= 0n || abs(cost - position.entry * quantity) > quantity) return incomplete('实际均价与成交记录不一致，无法完整核验。');
  let funding = 0n;
  const fundingIds = new Set<string>();
  const firstTrade = Math.min(...data.trades.map((trade) => stamp(trade.time)));
  for (const income of data.income) {
    if (income.incomeType !== 'FUNDING_FEE') {
      if (income.incomeType === 'REALIZED_PNL' && amount(income.income, '已实现损益', true) !== 0n) return incomplete('收支记录包含已实现损益，与未平仓的成交链不一致。');
      if (!['COMMISSION', 'REALIZED_PNL'].includes(String(income.incomeType)) && amount(income.income, '账户收支', true) < 0n) return incomplete('存在尚无法归属的其他费用支出，无法完整核验。');
      continue;
    }
    if (income.asset !== 'USDT' || stamp(income.time) < firstTrade) return incomplete('资金费资产或发生时间无法关联本单。');
    const fundingId = id(income.tranId);
    if (fundingIds.has(fundingId)) return incomplete('资金费记录重复，无法完整核验。');
    fundingIds.add(fundingId);
    funding += max(0n, -amount(income.income, '已付资金费', true));
  }
  const fee = amount(data.fee.takerCommissionRate, '当前退出费率');
  const mark = amount(data.mark.markPrice, '当前标记价');
  if (data.fee.symbol !== plan.symbol || data.mark.symbol !== plan.symbol || fee >= SCALE || mark <= 0n || Math.abs(stamp(data.mark.time) - data.end) > 30_000) return incomplete('当前费率或标记价缺失、过期或币种不一致。');
  const stop = amount(plan.stopPrice, '原绝对止损价');
  const budget = amount(plan.budget, '原预算');
  const remainingFunding = max(0n, amount(plan.funding, '原资金费预留') - funding);
  const exit = stop * (PERCENT - direction * amount(plan.slippagePercent, '原滑点'));
  // Use exact fills for comparisons; the exchange's displayed average may hide a material cost at large quantities.
  const loss = max(0n, direction * (cost * PERCENT - exit * quantity)) * SCALE + quantity * exit * fee + (commission + funding + remainingFunding) * 10n ** 26n;
  result.plannedLoss = formatDecimal(ceil(loss, 10n ** 26n));
  result.excess = formatDecimal(ceil(max(0n, loss - budget * 10n ** 26n), 10n ** 26n));
  result.paidCommission = formatDecimal(commission);
  result.paidFunding = formatDecimal(funding);
  result.remainingFunding = formatDecimal(remainingFunding);
  result.exitFee = formatDecimal(ceil(quantity * exit * fee, 10n ** 26n));
  if (loss > budget * 10n ** 26n) result.issues.push(`按原止损 ${plan.stopPrice} 计算的亏损 ${result.plannedLoss} USDT 超过原预算 ${plan.budget} USDT，超额 ${result.excess} USDT。请在 Binance 处理风险敞口；具体减仓量需包含减仓成交成本，本期不提供无法可靠复核的减仓数量。`);
  if (position.leverage <= 0n || position.leverage % SCALE !== 0n) return incomplete('实际杠杆数据无效。');
  if (position.leverage > amount(plan.leverage, '原杠杆')) result.issues.push(`实际杠杆 ${result.leverage} 倍高于原方案 ${plan.leverage} 倍，请在 Binance 调整后刷新。`);
  const gap = direction * (stop - position.liquidation);
  const minimum = amount(plan.minimumBuffer, '最低强平缓冲');
  if (position.liquidation <= 0n || minimum <= 0n) return incomplete('当前强平价或最低缓冲缺失，无法完整核验。');
  result.liquidationBuffer = formatDecimal(gap * PERCENT * quantity / cost);
  if (gap <= 0n || gap * PERCENT * quantity < minimum * cost) result.issues.push(`当前强平缓冲 ${result.liquidationBuffer}% 低于要求 ${plan.minimumBuffer}%，差 ${formatDecimal(ceil(minimum * cost - gap * PERCENT * quantity, cost))} 个百分点；请在 Binance 降低杠杆或增加逐仓保证金后刷新，不改动原止损。`);
  if (direction * (mark - stop) <= 0n) result.issues.push('当前标记价已达到原止损条件，尚有持仓；请立即在 Binance 检查实际执行状态。');
  const protections = pending.filter((item) => item.close || item.reduce || item.type === 'STOP_MARKET');
  if (protections.length !== 1) result.issues.push(`需要一张有效单层止损，目前找到 ${protections.length} 张候选；请在 Binance 设置或整理 ${plan.execution.stopSide} 止损市价、标记价 ${plan.stopPrice}、关闭价格保护、整仓退出。`);
  else {
    const protection = protections[0]!;
    if (protection.status !== 'NEW' || protection.triggered || protection.executed !== 0n) result.issues.push('止损已触发、执行或失效，不能作为有效保护。');
    if (protection.side !== plan.execution.stopSide || protection.positionSide !== 'BOTH') result.issues.push(`止损平仓方向不符，应为单向持仓 ${plan.execution.stopSide}。`);
    if (protection.type !== 'STOP_MARKET') result.issues.push('止损类型不符，应为止损市价 STOP_MARKET。');
    if (protection.stop !== stop) result.issues.push(`止损触发价 ${formatDecimal(protection.stop)} 不符，应保持原绝对止损 ${plan.stopPrice} USDT。`);
    if (protection.workingType !== 'MARK_PRICE') result.issues.push('触发依据不符，应使用标记价 MARK_PRICE。');
    if (protection.protect) result.issues.push('价格保护已开启，请在 Binance 关闭价格保护后刷新。');
    if (protection.timeInForce !== 'GTC' && (protection.timeInForce !== 'GTD' || protection.goodTillDate <= data.end)) result.issues.push('止损有效期无效或已经到期，请在 Binance 重新设置。');
    const contracts = rows(data.exchange.symbols).filter((contract) => contract.symbol === plan.symbol);
    if (contracts.length !== 1 || contracts[0]!.status !== 'TRADING' || contracts[0]!.contractType !== 'PERPETUAL' || contracts[0]!.marginAsset !== 'USDT') return incomplete('当前合约状态或规则无法确认。');
    const filters = rows(contracts[0]!.filters);
    const filter = (name: string) => {
      const matches = filters.filter((item) => item.filterType === name);
      if (matches.length !== 1) throw new AccountError('invalid_rules', '当前退出规则缺失或重复，无法完整核验。');
      return matches[0]!;
    };
    const price = filter('PRICE_FILTER');
    const tick = amount(price.tickSize, '价格步长'), minPrice = amount(price.minPrice, '最小价格'), maxPrice = amount(price.maxPrice, '最大价格');
    if (tick <= 0n) return incomplete('当前价格步长不支持，无法完整核验。');
    if (stop < minPrice || (maxPrice > 0n && stop > maxPrice) || (stop - minPrice) % tick !== 0n) result.issues.push('原止损不符合当前价格规则，请在 Binance 检查，工具不会移动原止损。');
    if (!protection.close) {
      if (!protection.reduce) result.issues.push('固定数量退出必须具有只减仓语义。');
      if (protection.quantity !== quantity) result.issues.push(`固定止损数量 ${formatDecimal(protection.quantity)} ${plan.baseAsset} 与实际 ${result.quantity} 不符${protection.quantity < quantity ? `，覆盖缺口 ${formatDecimal(quantity - protection.quantity)} ${plan.baseAsset}` : '，不得超量'}；请在 Binance 调整为当前实际数量或整仓退出。`);
      for (const name of ['LOT_SIZE', 'MARKET_LOT_SIZE']) {
        const lot = filter(name);
        const minimum = amount(lot.minQty, '退出最小数量'), maximum = amount(lot.maxQty, '退出最大数量'), step = amount(lot.stepSize, '退出数量步长');
        if (maximum <= 0n || maximum < minimum || step <= 0n) return incomplete('当前退出数量规则无效或不支持。');
        if (protection.quantity < minimum || protection.quantity > maximum || (protection.quantity - minimum) % step !== 0n) result.issues.push(`固定止损不符合 ${name} 数量规则：范围 ${formatDecimal(minimum)}–${formatDecimal(maximum)}，步长 ${formatDecimal(step)}；只减仓不豁免数量规则，可在 Binance 检查整仓退出方式。`);
      }
      result.coverage = `固定数量 ${formatDecimal(protection.quantity)} ${plan.baseAsset} · 只减仓，仅覆盖当前数量`;
    }
    else if (protection.quantity !== 0n) result.issues.push('整仓止损同时包含固定数量，平仓语义无法确认。');
    else result.coverage = '整仓退出';
  }
  result.status = result.issues.length ? 'needs-action' : 'verified';
  return result;
}
