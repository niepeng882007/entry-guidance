import { AccountError, object, readAccountScope, readBinance, type AccountConfig } from './account.ts';
import { parseDecimal, formatDecimal } from '../public/draft.js';

export type OrdinaryOrder = {
  symbol: string; orderId: string; side: 'BUY' | 'SELL'; positionSide: 'BOTH' | 'LONG' | 'SHORT';
  type: 'LIMIT' | 'MARKET'; status: 'NEW' | 'PARTIALLY_FILLED'; price: string | null;
  origQty: string; executedQty: string; remainingQty: string; avgPrice: string | null;
  reduceOnly: boolean | null; timeInForce: string | null; createdAt: string | null; updatedAt: string | null;
};
export type OrdersSnapshot = { source: 'binance' | 'demo'; queriedAt: string; orders: OrdinaryOrder[] };

function invalid(): never { throw new AccountError('invalid_response', '活跃委托字段或数量无效，本次列表不可用。'); }
function amount(value: unknown): string {
  try {
    const [whole, fraction = ''] = formatDecimal(parseDecimal(value, '委托数值')).split('.');
    return `${whole}.${fraction.padEnd(8, '0')}`;
  }
  catch { invalid(); }
}
function time(value: unknown): string | null {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) invalid();
  return new Date(value).toISOString();
}

function inScope(symbol: string, instruments: Record<string, unknown>[]): boolean {
  const contract = instruments.find((c) => c.symbol === symbol);
  if (!contract || typeof contract.quoteAsset !== 'string' || !/^[\p{L}\p{N}_]{1,30}$/u.test(contract.quoteAsset) ||
    typeof contract.marginAsset !== 'string' || !/^[\p{L}\p{N}_]{1,30}$/u.test(contract.marginAsset) ||
    typeof contract.contractType !== 'string' || !['PERPETUAL', 'TRADIFI_PERPETUAL', 'CURRENT_MONTH', 'NEXT_MONTH', 'CURRENT_QUARTER', 'NEXT_QUARTER', 'PERPETUAL_DELIVERING'].includes(contract.contractType)) invalid();
  if (contract.quoteAsset !== 'USDT' || contract.marginAsset !== 'USDT' ||
    (contract.contractType !== 'PERPETUAL' && contract.contractType !== 'TRADIFI_PERPETUAL')) return false;
  if (!/^[\p{L}\p{N}_]{1,30}USDT$/u.test(symbol)) invalid();
  return true;
}

export async function readAccountOrders(config: AccountConfig, signal = AbortSignal.timeout(10_000)): Promise<OrdersSnapshot> {
  await readAccountScope(config, signal);
  const [orderRead, exchange] = await Promise.all([
    readBinance(config, 'orders', signal).then((raw) => ({ raw, queriedAt: new Date().toISOString() })),
    readBinance(config, 'exchange', signal),
  ]);
  const { raw, queriedAt } = orderRead;
  const symbols = object(exchange).symbols;
  if (!Array.isArray(raw) || !Array.isArray(symbols)) invalid();
  const instruments = symbols.map(object);
  const keys = new Set<string>();
  const orders: OrdinaryOrder[] = [];
  for (const value of raw) {
    const o = object(value);
    if (typeof o.symbol !== 'string') invalid();
    if (!inScope(o.symbol, instruments)) continue;
    const orderId = typeof o.orderId === 'number' && Number.isSafeInteger(o.orderId) && o.orderId > 0 ? String(o.orderId) : o.orderId;
    if (typeof orderId !== 'string' || !/^\d{1,20}$/.test(orderId) || BigInt(orderId) <= 0n) invalid();
    const key = `${o.symbol}:${orderId}`;
    if (keys.has(key)) invalid();
    keys.add(key);
    if (o.side !== 'BUY' && o.side !== 'SELL') invalid();
    if (o.positionSide !== 'BOTH' && o.positionSide !== 'LONG' && o.positionSide !== 'SHORT') invalid();
    if (o.type !== 'LIMIT' && o.type !== 'MARKET') invalid();
    if (o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED') invalid();
    const origQty = amount(o.origQty), executedQty = amount(o.executedQty);
    const original = parseDecimal(origQty, '原数量'), executed = parseDecimal(executedQty, '已成交量');
    if (original <= 0n || executed > original) invalid();
    if (o.reduceOnly !== undefined && o.reduceOnly !== null && typeof o.reduceOnly !== 'boolean') invalid();
    if (o.timeInForce !== undefined && o.timeInForce !== null && (typeof o.timeInForce !== 'string' || !['GTC', 'IOC', 'FOK', 'GTX', 'GTD', 'RPI'].includes(o.timeInForce))) invalid();
    orders.push({ symbol: o.symbol, orderId, side: o.side, positionSide: o.positionSide, type: o.type, status: o.status,
      price: o.type === 'MARKET' || o.price === undefined || o.price === null ? null : amount(o.price),
      origQty, executedQty, remainingQty: amount(formatDecimal(original - executed)),
      avgPrice: executed === 0n || o.avgPrice === undefined || o.avgPrice === null ? null : amount(o.avgPrice),
      reduceOnly: typeof o.reduceOnly === 'boolean' ? o.reduceOnly : null,
      timeInForce: o.type === 'MARKET' || typeof o.timeInForce !== 'string' ? null : o.timeInForce,
      createdAt: time(o.time), updatedAt: time(o.updateTime) });
  }
  orders.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.positionSide.localeCompare(b.positionSide) || (BigInt(a.orderId) < BigInt(b.orderId) ? -1 : BigInt(a.orderId) > BigInt(b.orderId) ? 1 : 0));
  return { source: 'binance', queriedAt, orders };
}

export function demoAccountOrders(): OrdersSnapshot {
  const queriedAt = new Date().toISOString();
  return { source: 'demo', queriedAt, orders: [
    { symbol: 'BTCUSDT', orderId: '9007199254740993123', side: 'BUY', positionSide: 'LONG', type: 'LIMIT', status: 'PARTIALLY_FILLED', price: '60000.12345678', origQty: '0.12345678', executedQty: '0.00000001', remainingQty: '0.12345677', avgPrice: '59999.12345678', reduceOnly: false, timeInForce: 'GTC', createdAt: queriedAt, updatedAt: queriedAt },
    { symbol: 'ETHUSDT', orderId: '2', side: 'SELL', positionSide: 'SHORT', type: 'LIMIT', status: 'NEW', price: '2100.00000001', origQty: '1.00000000', executedQty: '0.00000000', remainingQty: '1.00000000', avgPrice: null, reduceOnly: null, timeInForce: null, createdAt: null, updatedAt: null },
  ] };
}

export type ConditionalOrder = {
  symbol: string; algoId: string; side: 'BUY' | 'SELL'; positionSide: 'BOTH' | 'LONG' | 'SHORT';
  type: 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET'; status: string;
  price: string | null; triggerPrice: string | null; quantity: string | null;
  executedQty: string | null; remainingQty: string | null;
  workingType: string | null; reduceOnly: boolean | null; closePosition: boolean | null; priceProtect: boolean | null;
  timeInForce: string | null; createdAt: string | null; updatedAt: string | null;
  activatePrice: string | null; callbackRate: string | null;
};
export type ConditionalOrdersSnapshot = { source: 'binance' | 'demo'; queriedAt: string; orders: ConditionalOrder[] };
function flag(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') invalid();
  return value;
}
function token(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(value)) invalid();
  return value;
}
function optionalAmount(value: unknown): string | null {
  return value === undefined || value === null ? null : amount(value);
}

export async function readAccountConditionalOrders(config: AccountConfig, signal = AbortSignal.timeout(10_000)): Promise<ConditionalOrdersSnapshot> {
  await readAccountScope(config, signal);
  const [orderRead, exchange] = await Promise.all([
    readBinance(config, 'algoOrders', signal).then((raw) => ({ raw, queriedAt: new Date().toISOString() })),
    readBinance(config, 'exchange', signal),
  ]);
  const { raw, queriedAt } = orderRead;
  const symbols = object(exchange).symbols;
  if (!Array.isArray(raw) || !Array.isArray(symbols)) invalid();
  const instruments = symbols.map(object), keys = new Set<string>();
  const orders: ConditionalOrder[] = [];
  for (const value of raw) {
    const o = object(value);
    if (typeof o.symbol !== 'string') invalid();
    if (!inScope(o.symbol, instruments)) continue;
    const algoId = typeof o.algoId === 'number' && Number.isSafeInteger(o.algoId) && o.algoId > 0 ? String(o.algoId) : o.algoId;
    if (typeof algoId !== 'string' || !/^\d{1,20}$/.test(algoId) || BigInt(algoId) <= 0n) invalid();
    const key = `${o.symbol}:${algoId}`;
    if (keys.has(key)) invalid();
    keys.add(key);
    if (o.algoType !== 'CONDITIONAL' || (o.side !== 'BUY' && o.side !== 'SELL') ||
        (o.positionSide !== 'BOTH' && o.positionSide !== 'LONG' && o.positionSide !== 'SHORT')) invalid();
    const type = o.orderType;
    if (type !== 'STOP' && type !== 'STOP_MARKET' && type !== 'TAKE_PROFIT' && type !== 'TAKE_PROFIT_MARKET' && type !== 'TRAILING_STOP_MARKET') invalid();
    const status = token(o.algoStatus);
    if (status === null) invalid();
    const closePosition = flag(o.closePosition), reduceOnly = flag(o.reduceOnly), priceProtect = flag(o.priceProtect);
    const suppliedQuantity = optionalAmount(o.quantity);
    // Close-all quantity is not a fixed amount, even when the endpoint returns "0".
    const quantity = closePosition === true || suppliedQuantity === null || parseDecimal(suppliedQuantity, '数量') === 0n ? null : suppliedQuantity;
    if (closePosition === false && quantity === null) invalid();
    const executedQty = optionalAmount(o.executedQty);
    let remainingQty = optionalAmount(o.remainingQty);
    if (quantity !== null && executedQty !== null) {
      const remaining = parseDecimal(quantity, '数量') - parseDecimal(executedQty, '已执行量');
      if (remaining < 0n || (remainingQty !== null && parseDecimal(remainingQty, '剩余量') !== remaining)) invalid();
      remainingQty = amount(formatDecimal(remaining));
    }
    if (quantity !== null && remainingQty !== null && parseDecimal(remainingQty, '剩余量') > parseDecimal(quantity, '数量')) invalid();
    orders.push({ symbol: o.symbol, algoId, side: o.side, positionSide: o.positionSide, type, status,
      price: type === 'STOP' || type === 'TAKE_PROFIT' ? optionalAmount(o.price) : null,
      triggerPrice: type === 'TRAILING_STOP_MARKET' ? null : optionalAmount(o.triggerPrice),
      quantity, executedQty, remainingQty, workingType: token(o.workingType), reduceOnly, closePosition, priceProtect,
      timeInForce: type === 'STOP' || type === 'TAKE_PROFIT' ? token(o.timeInForce) : null,
      createdAt: time(o.createTime), updatedAt: time(o.updateTime),
      activatePrice: type === 'TRAILING_STOP_MARKET' ? optionalAmount(o.activatePrice) : null,
      callbackRate: type === 'TRAILING_STOP_MARKET' ? optionalAmount(o.callbackRate) : null });
  }
  orders.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.positionSide.localeCompare(b.positionSide) || (BigInt(a.algoId) < BigInt(b.algoId) ? -1 : BigInt(a.algoId) > BigInt(b.algoId) ? 1 : 0));
  return { source: 'binance', queriedAt, orders };
}

export function demoAccountConditionalOrders(): ConditionalOrdersSnapshot {
  const queriedAt = new Date().toISOString();
  const fixed: ConditionalOrder = { symbol: 'BTCUSDT', algoId: '9007199254740993123', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', status: 'NEW', price: null, triggerPrice: '58000.12345678', quantity: '0.12345678', executedQty: null, remainingQty: null, workingType: 'MARK_PRICE', reduceOnly: true, closePosition: false, priceProtect: true, timeInForce: null, createdAt: queriedAt, updatedAt: queriedAt, activatePrice: null, callbackRate: null };
  return { source: 'demo', queriedAt, orders: [fixed,
    { ...fixed, algoId: '2', side: 'BUY', positionSide: 'SHORT', type: 'TAKE_PROFIT_MARKET', triggerPrice: '55000.00000001', closePosition: true, quantity: null, workingType: 'CONTRACT_PRICE', reduceOnly: null, priceProtect: false },
    { ...fixed, symbol: 'ETHUSDT', algoId: '3', type: 'TAKE_PROFIT', price: '2200.00000001', triggerPrice: '2190.00000001', quantity: '1.00000001', executedQty: '1.00000000', remainingQty: '0.00000001', timeInForce: 'GTC' },
    { ...fixed, symbol: 'SOLUSDT', algoId: '4', positionSide: 'BOTH', type: 'TRAILING_STOP_MARKET', triggerPrice: null, workingType: null, activatePrice: '150.00000001', callbackRate: '0.30000000', reduceOnly: null, closePosition: null, priceProtect: null, createdAt: null, updatedAt: null },
  ] };
}
