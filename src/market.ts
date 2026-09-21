import { AccountError, object, readAccount, readBinance, type AccountConfig } from './account.ts';
import { parseDecimal, type Snapshot } from '../public/draft.js';

type MarketConfig = AccountConfig & { mode?: 'real' | 'demo' };
const demoSymbols = ['BTCUSDT', 'ETHUSDT'];

export function demoAccount() {
  return { source: 'demo' as const, queriedAt: new Date().toISOString(), walletBalance: '1250.00000000', unrealizedProfit: '-12.35000000', equity: '1237.65000000', availableBalance: '920.12540000' };
}

function supported(contract: Record<string, unknown>) {
  return typeof contract.symbol === 'string' && /^[\p{L}\p{N}_]{1,30}USDT$/u.test(contract.symbol)
    && contract.status === 'TRADING' && contract.contractType === 'PERPETUAL'
    && contract.quoteAsset === 'USDT' && contract.marginAsset === 'USDT'
    && typeof contract.baseAsset === 'string' && contract.baseAsset.length > 0
    && Array.isArray(contract.orderTypes) && contract.orderTypes.includes('MARKET') && contract.orderTypes.includes('STOP_MARKET');
}

export async function readSymbols(config: MarketConfig) {
  const symbols = config.mode === 'demo' ? demoSymbols : list(object(await readBinance(config, 'exchange', AbortSignal.timeout(10_000))).symbols).filter(supported).map((item) => item.symbol as string).sort();
  if (!symbols.length) throw new AccountError('invalid_response', '未查询到有效的 USDT 永续合约。');
  return { source: config.mode === 'demo' ? 'demo' : 'binance', queriedAt: new Date().toISOString(), symbols };
}

function list(value: unknown) {
  if (!Array.isArray(value)) throw new AccountError('invalid_response', 'Binance 列表数据缺失，无法生成草稿。');
  return value.map(object);
}

function amount(value: unknown, label: string): string {
  try { parseDecimal(value, label); }
  catch { throw new AccountError('invalid_response', `${label}缺失或精度不支持，无法生成草稿。`); }
  return value as string;
}

function timestamp(value: unknown, requireFresh = false): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 8.64e15) throw new AccountError('invalid_response', '行情时间缺失或无效。');
  if (requireFresh && Math.abs(Date.now() - value) > 30_000) throw new AccountError('stale_market', '报价或标记价数据已过期或时钟不一致（超过 30 秒），请刷新后重试。');
  return new Date(value).toISOString();
}

function accountBrackets(value: unknown, symbol: string) {
  const rows = Array.isArray(value) ? list(value) : [object(value)];
  if (rows.length !== 1 || rows[0]!.symbol !== symbol) throw new AccountError('invalid_rules', '账户杠杆档位币种缺失或不一致。');
  const data = rows[0]!;
  if (data.notionalCoef !== undefined && data.notionalCoef !== 1) throw new AccountError('unsupported_brackets', '账户存在自定义档位系数，尚无法确认缩放语义，暂停新建议；不会使用通用档位替代。');
  const brackets = list(data.brackets).map((row, index) => {
    if (row.bracket !== index + 1 || typeof row.initialLeverage !== 'number' || !Number.isSafeInteger(row.initialLeverage) || row.initialLeverage < 1) throw new AccountError('invalid_rules', '账户杠杆档位编号或杠杆无效。');
    const numeric = (field: string) => {
      const value = row[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new AccountError('invalid_rules', '账户杠杆档位数值无效。');
      return amount(String(value), '账户杠杆档位');
    };
    return { maxLeverage: row.initialLeverage, floor: numeric('notionalFloor'), cap: numeric('notionalCap'), maintenanceRate: numeric('maintMarginRatio'), cum: numeric('cum') };
  });
  if (!brackets.length) throw new AccountError('invalid_rules', '账户杠杆档位为空。');
  for (const [index, tier] of brackets.entries()) {
    const previous = brackets[index - 1];
    const floor = parseDecimal(tier.floor, ''), cap = parseDecimal(tier.cap, ''), rate = parseDecimal(tier.maintenanceRate, ''), cum = parseDecimal(tier.cum, '');
    const previousRate = previous ? parseDecimal(previous.maintenanceRate, '') : 0n;
    const expectedCum = previous ? parseDecimal(previous.cum, '') * 100_000_000n + floor * (rate - previousRate) : 0n;
    const difference = cum * 100_000_000n - expectedCum;
    if (cap <= floor || rate <= 0n || rate >= 100_000_000n || rate < previousRate || difference < -100_000_000n || difference > 100_000_000n
      || (previous ? tier.floor !== previous.cap || tier.maxLeverage > previous.maxLeverage : floor !== 0n || cum !== 0n)) throw new AccountError('invalid_rules', '账户档位边界或维持保证金不连续，暂停新建议。');
  }
  return brackets;
}

export async function readMarket(config: MarketConfig, symbol: string): Promise<Snapshot> {
  if (!/^[\p{L}\p{N}_]{1,30}USDT$/u.test(symbol)) throw new AccountError('invalid_symbol', '请选择有效的 USDT 永续币种。', 400);
  if (config.mode === 'demo') {
    if (!demoSymbols.includes(symbol)) throw new AccountError('invalid_symbol', '请选择模拟模式提供的币种。', 400);
    const queriedAt = new Date().toISOString();
    const bitcoin = symbol === 'BTCUSDT';
    return { source: 'demo', queriedAt, symbol, baseAsset: symbol.slice(0, -4), account: demoAccount(),
      bid: bitcoin ? '99' : '19.9', ask: bitcoin ? '100' : '20', mark: bitcoin ? '100' : '20', last: bitcoin ? '100' : '20',
      bookTime: queriedAt, markTime: queriedAt, lastTime: queriedAt, takerRate: '0.001',
      brackets: [{ maxLeverage: 50, floor: '0', cap: '500', maintenanceRate: '0.01', cum: '0' }, { maxLeverage: 10, floor: '500', cap: '1000000', maintenanceRate: '0.02', cum: '5' }],
      rules: { minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1', minQty: '0.1', maxQty: '1000', stepSize: '0.1', minNotional: '5', lotSize: { minQty: '0.001', maxQty: '10000', stepSize: '0.001' }, marketTakeBound: '0.30' },
    };
  }
  const signal = AbortSignal.timeout(10_000);
  const account = await readAccount(config, symbol, signal);
  const read = (operation: Parameters<typeof readBinance>[1], target?: string) => readBinance(config, operation, signal, target);
  const [exchangeData, bookData, markData, lastData, bracketData, feeData, modeData, orders, algoOrders] = await Promise.all([
    read('exchange'), read('book', symbol), read('mark', symbol), read('last', symbol), read('brackets', symbol), read('fee', symbol), read('positionMode'), read('orders', symbol), read('algoOrders', symbol),
  ]);
  if (object(modeData).dualSidePosition !== false) throw new AccountError('unsupported_position', '账户未确认单向持仓，请在 Binance 检查后刷新。');
  if (list(orders).length || list(algoOrders).length) throw new AccountError('existing_orders', '目标币种有普通或条件挂单，请先在 Binance 清理后刷新。');
  const symbols = list(object(exchangeData).symbols).filter((item) => item.symbol === symbol);
  const contract = symbols[0];
  if (symbols.length !== 1 || !contract || !supported(contract)) throw new AccountError('unsupported_symbol', '币种不是支持市价及止损市价的有效 USDT 永续合约。');
  const filters = list(contract.filters);
  const filter = (name: string) => {
    const matches = filters.filter((item) => item.filterType === name);
    if (matches.length !== 1) throw new AccountError('invalid_rules', '合约交易规则缺失或重复。');
    return matches[0]!;
  };
  const price = filter('PRICE_FILTER');
  const lot = filter('MARKET_LOT_SIZE');
  const normalLot = filter('LOT_SIZE');
  const book = object(bookData), mark = object(markData), last = object(lastData), fee = object(feeData);
  if ([book, mark, last, fee].some((data) => data.symbol !== symbol)) throw new AccountError('invalid_response', '行情或费率币种不一致，请刷新。');
  const bid = amount(book.bidPrice, '买一价'), ask = amount(book.askPrice, '卖一价');
  const markPrice = amount(mark.markPrice, '标记价'), takerRate = amount(fee.takerCommissionRate, '账户 taker 费率');
  const lastPrice = amount(last.price, '最新成交价');
  if (parseDecimal(bid, '') <= 0n || parseDecimal(ask, '') < parseDecimal(bid, '') || parseDecimal(markPrice, '') <= 0n || parseDecimal(lastPrice, '') <= 0n || parseDecimal(takerRate, '') >= 100_000_000n) throw new AccountError('invalid_response', '报价、标记价或账户费率无效，请刷新。');
  return { source: 'binance', queriedAt: new Date().toISOString(), symbol, baseAsset: contract.baseAsset as string,
    account, bid, ask, mark: markPrice, last: lastPrice, brackets: accountBrackets(bracketData, symbol),
    bookTime: timestamp(book.time, true), markTime: timestamp(mark.time, true), lastTime: timestamp(last.time), takerRate,
    rules: {
      minPrice: amount(price.minPrice, '最小价格'), maxPrice: amount(price.maxPrice, '最大价格'), tickSize: amount(price.tickSize, '价格步长'),
      minQty: amount(lot.minQty, '市价最小数量'), maxQty: amount(lot.maxQty, '市价最大数量'), stepSize: amount(lot.stepSize, '市价数量步长'),
      minNotional: amount(filter('MIN_NOTIONAL').notional, '最小开仓名义价值'),
      lotSize: { minQty: amount(normalLot.minQty, '普通最小数量'), maxQty: amount(normalLot.maxQty, '普通最大数量'), stepSize: amount(normalLot.stepSize, '普通数量步长') },
      marketTakeBound: amount(contract.marketTakeBound, '市价成交边界'),
    },
  };
}
