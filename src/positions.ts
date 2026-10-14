import { AccountError, object, readAccountScope, readBinance, type AccountConfig } from './account.ts';
import { parseDecimal, formatDecimal } from '../public/draft.js';

export type Position = {
  symbol: string; positionSide: 'BOTH' | 'LONG' | 'SHORT'; direction: 'LONG' | 'SHORT';
  marginType: 'cross' | 'isolated'; leverage: string; quantity: string;
  entryPrice: string; markPrice: string; unrealizedProfit: string;
  notional: string | null; liquidationPrice: string | null; breakEvenPrice: string | null;
  isolatedWallet: string | null; updatedAt: string | null;
};
export type LastPrice = { symbol: string; price: string; updatedAt: string | null };
export type Funding = { symbol: string; rate: string | null; nextFundingAt: string | null; updatedAt: string | null };
export type MarketPart<T> = ({ status: 'ok'; queriedAt: string; data: T[] } | { status: 'error'; error: string }) & { attemptedAt?: string; retryAt?: string };
export type PositionsSnapshot = {
  source: 'binance' | 'demo'; queriedAt: string; positions: Position[];
  last: MarketPart<LastPrice>; funding: MarketPart<Funding>;
};

function invalid(): never { throw new AccountError('invalid_response', '持仓或辅助行情字段无效，本次分项不可用。'); }
function decimal(value: unknown, signed = false): string {
  if (typeof value !== 'string' || !/^-?\d{1,24}(\.\d{1,8})?$/.test(value) || (!signed && value.startsWith('-'))) invalid();
  const amount = parseDecimal(value.replace('-', ''), '持仓数值') * (value.startsWith('-') ? -1n : 1n);
  const [whole, fraction = ''] = formatDecimal(amount).split('.');
  return `${whole}.${fraction.padEnd(8, '0')}`;
}
function timestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) invalid();
  return new Date(value).toISOString();
}
function list(value: unknown) {
  if (!Array.isArray(value)) invalid();
  return value.map(object);
}

export async function readAccountPositions(config: AccountConfig, signal = AbortSignal.timeout(10_000)): Promise<PositionsSnapshot> {
  // Account observation checks permissions and scope without the entry-plan empty-position checks.
  await readAccountScope(config, signal);
  const [positionRead, exchange] = await Promise.all([
    readBinance(config, 'positions', signal).then((raw) => ({ raw, queriedAt: new Date().toISOString() })),
    readBinance(config, 'exchange', signal),
  ]);
  const contracts = new Set(list(object(exchange).symbols).filter((c) =>
    c.quoteAsset === 'USDT' && c.marginAsset === 'USDT' && (c.contractType === 'PERPETUAL' || c.contractType === 'TRADIFI_PERPETUAL')
  ).map((c) => c.symbol));
  const keys = new Set<string>();
  const positions: Position[] = [];
  for (const p of list(positionRead.raw)) {
    const quantity = decimal(p.positionAmt, true);
    if (parseDecimal(quantity.replace('-', ''), '持仓数量') === 0n) continue;
    if (typeof p.symbol !== 'string' || !/^[\p{L}\p{N}_]{1,30}USDT$/u.test(p.symbol)) {
      if (typeof p.symbol === 'string' && !p.symbol.endsWith('USDT')) continue;
      invalid();
    }
    if (!contracts.has(p.symbol)) invalid();
    if (p.positionSide !== 'BOTH' && p.positionSide !== 'LONG' && p.positionSide !== 'SHORT') invalid();
    if (p.marginType !== 'cross' && p.marginType !== 'isolated') invalid();
    if (typeof p.leverage !== 'string' || !/^[1-9]\d{0,2}$/.test(p.leverage)) invalid();
    const direction = quantity.startsWith('-') ? 'SHORT' : 'LONG';
    if (p.positionSide !== 'BOTH' && p.positionSide !== direction) invalid();
    const key = `${p.symbol}:${p.positionSide}`;
    if (keys.has(key)) invalid();
    keys.add(key);
    const optional = (field: string, signed = false) => p[field] === undefined || p[field] === null ? null : decimal(p[field], signed);
    positions.push({ symbol: p.symbol, positionSide: p.positionSide, direction, marginType: p.marginType,
      leverage: p.leverage, quantity: quantity.replace('-', ''), entryPrice: decimal(p.entryPrice),
      markPrice: decimal(p.markPrice), unrealizedProfit: decimal(p.unRealizedProfit, true),
      notional: optional('notional', true), liquidationPrice: optional('liquidationPrice'), breakEvenPrice: optional('breakEvenPrice'),
      isolatedWallet: p.marginType === 'cross' ? null : optional('isolatedWallet'), updatedAt: timestamp(p.updateTime) });
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.direction.localeCompare(b.direction));
  const queriedAt = positionRead.queriedAt;
  const symbols = new Set(positions.map((p) => p.symbol));
  async function market<T>(operation: 'last' | 'mark', parse: (p: Record<string, unknown>) => T): Promise<MarketPart<T>> {
    const attemptedAt = new Date().toISOString();
    try {
      if (!symbols.size) return { status: 'ok', attemptedAt, queriedAt: new Date().toISOString(), data: [] };
      const rows = list(await readBinance(config, operation, signal)).filter((p) => symbols.has(p.symbol as string));
      const seen = new Set<unknown>();
      const data = rows.map((p) => { if (seen.has(p.symbol)) invalid(); seen.add(p.symbol); return parse(p); });
      return { status: 'ok', attemptedAt, queriedAt: new Date().toISOString(), data };
    } catch (error) {
      return { status: 'error', attemptedAt: error instanceof AccountError ? error.attemptedAt ?? attemptedAt : attemptedAt, retryAt: error instanceof AccountError ? error.retryAt : undefined, error: error instanceof AccountError ? `${error.message}${error.retryAt ? ` 下次允许读取：${error.retryAt}。` : ''}` : '辅助行情读取失败。' };
    }
  }
  const [last, funding] = await Promise.all([
    market('last', (p): LastPrice => ({ symbol: p.symbol as string, price: decimal(p.price), updatedAt: timestamp(p.time) })),
    market('mark', (p): Funding => ({ symbol: p.symbol as string, rate: p.lastFundingRate === undefined || p.lastFundingRate === '' ? null : decimal(p.lastFundingRate, true),
      nextFundingAt: timestamp(p.nextFundingTime), updatedAt: timestamp(p.time) })),
  ]);
  return { source: 'binance', queriedAt, positions, last, funding };
}

export function demoAccountPositions(): PositionsSnapshot {
  const queriedAt = new Date().toISOString();
  return { source: 'demo', queriedAt, positions: [
    { symbol: 'BTCUSDT', positionSide: 'LONG', direction: 'LONG', marginType: 'cross', leverage: '5', quantity: '0.01000000', entryPrice: '60000.00000000', markPrice: '60100.00000000', unrealizedProfit: '1.00000000', notional: '601.00000000', liquidationPrice: '50000.00000000', breakEvenPrice: '60024.00000000', isolatedWallet: null, updatedAt: queriedAt },
    { symbol: 'BTCUSDT', positionSide: 'SHORT', direction: 'SHORT', marginType: 'isolated', leverage: '10', quantity: '0.02000000', entryPrice: '60000.00000000', markPrice: '60100.00000000', unrealizedProfit: '-2.00000000', notional: '-1202.00000000', liquidationPrice: '65000.00000000', breakEvenPrice: '59976.00000000', isolatedWallet: '120.00000000', updatedAt: queriedAt },
    { symbol: 'ETHUSDT', positionSide: 'BOTH', direction: 'LONG', marginType: 'isolated', leverage: '3', quantity: '0.12345678', entryPrice: '2000.00000000', markPrice: '1990.00000000', unrealizedProfit: '-1.23456780', notional: '245.67901220', liquidationPrice: null, breakEvenPrice: null, isolatedWallet: null, updatedAt: null },
  ], last: { status: 'ok', queriedAt, data: [{ symbol: 'BTCUSDT', price: '60101.00000000', updatedAt: queriedAt }, { symbol: 'ETHUSDT', price: '1991.00000000', updatedAt: queriedAt }] },
  funding: { status: 'ok', queriedAt, data: [{ symbol: 'BTCUSDT', rate: '0.00010000', nextFundingAt: new Date(Date.now() + 3600000).toISOString(), updatedAt: queriedAt }] } };
}
