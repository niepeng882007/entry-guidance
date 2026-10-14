import { createHmac } from 'node:crypto';
import { get } from 'node:https';
import { parseDecimal, formatDecimal } from '../public/draft.js';

export type ReadPriority = 'foreground' | 'archive';
export type Transport = (url: URL, headers: Record<string, string>, signal: AbortSignal, priority?: ReadPriority) => Promise<{ status: number; body: unknown; headers?: Record<string, string | undefined> }>;
export type AccountConfig = { apiKey?: string; apiSecret?: string; transport?: Transport };
// Confirmed from a completed Binance order export on 2026-10-14; never follow arbitrary file hosts.
export const orderDownloadHost = 'd11ggcthlh2gdm.cloudfront.net';

export class AccountError extends Error {
  code: string;
  status: number;
  retryAt?: string;
  attemptedAt?: string;
  scopeConfirmed?: false;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountError('invalid_response', '账户响应格式不支持，无法确认余额。');
  return value as Record<string, unknown>;
}

const integerIdPaths = ['/api/v3/account', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders', '/fapi/v1/userTrades', '/fapi/v1/allOrders', '/fapi/v1/allAlgoOrders', '/fapi/v1/income', '/fapi/v1/forceOrders'];

export const binanceTransport: Transport = (url, headers, signal) => new Promise((resolve, reject) => {
  const request = get(url, { headers, signal }, (response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > (url.hostname === orderDownloadHost ? 64_000_000 : 8_000_000)) response.destroy(new Error('response too large'));
      else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => {
      let data: unknown;
      try {
        const body = Buffer.concat(chunks);
        if (url.hostname === orderDownloadHost) data = body;
        else {
          const text = body.toString('utf8');
          // Signed source IDs are int64; keep their JSON tokens until the read boundary.
          data = integerIdPaths.includes(url.pathname) && response.statusCode === 200 ? text : JSON.parse(text);
        }
      }
      catch {
        if (response.statusCode === 429 || response.statusCode === 418) data = null;
        else { reject(new AccountError('upstream_error', 'Binance 返回异常响应，请稍后重试。')); return; }
      }
      resolve({ status: response.statusCode ?? 502, body: data, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])) });
    });
  });
  request.on('error', reject);
});

const endpoints = {
  permissions: 'https://api.binance.com/sapi/v1/account/apiRestrictions',
  identity: 'https://api.binance.com/api/v3/account',
  portfolio: 'https://api.binance.com/sapi/v1/portfolio/account',
  account: 'https://fapi.binance.com/fapi/v2/account',
  exchange: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  book: 'https://fapi.binance.com/fapi/v1/ticker/bookTicker',
  mark: 'https://fapi.binance.com/fapi/v1/premiumIndex',
  last: 'https://fapi.binance.com/fapi/v2/ticker/price',
  brackets: 'https://fapi.binance.com/fapi/v1/leverageBracket',
  fee: 'https://fapi.binance.com/fapi/v1/commissionRate',
  positionMode: 'https://fapi.binance.com/fapi/v1/positionSide/dual',
  orders: 'https://fapi.binance.com/fapi/v1/openOrders',
  algoOrders: 'https://fapi.binance.com/fapi/v1/openAlgoOrders',
  time: 'https://fapi.binance.com/fapi/v1/time',
  positions: 'https://fapi.binance.com/fapi/v2/positionRisk',
  trades: 'https://fapi.binance.com/fapi/v1/userTrades',
  history: 'https://fapi.binance.com/fapi/v1/allOrders',
  algoHistory: 'https://fapi.binance.com/fapi/v1/allAlgoOrders',
  income: 'https://fapi.binance.com/fapi/v1/income',
  forceOrders: 'https://fapi.binance.com/fapi/v1/forceOrders',
  klines: 'https://fapi.binance.com/fapi/v1/klines',
  markKlines: 'https://fapi.binance.com/fapi/v1/markPriceKlines',
} as const;

export function signBinanceRequest(config: AccountConfig, url: URL) {
  if (!config.apiSecret) throw new AccountError('missing_credentials', '后端只读凭据缺失。', 503);
  url.searchParams.delete('signature');
  url.searchParams.set('timestamp', Date.now().toString()); url.searchParams.set('recvWindow', '5000');
  url.searchParams.set('signature', createHmac('sha256', config.apiSecret).update(url.searchParams.toString()).digest('hex'));
}

export async function readBinance(config: AccountConfig, operation: keyof typeof endpoints, signal: AbortSignal, symbol?: string, period?: { startTime: number; endTime: number; page?: number; autoCloseType?: 'LIQUIDATION' | 'ADL' }, priority: ReadPriority = 'foreground', candlePeriod?: { interval: string; startTime: number; endTime: number }): Promise<unknown> {
  const url = new URL(endpoints[operation]);
  const isPublic = ['exchange', 'book', 'mark', 'last', 'time', 'klines', 'markKlines'].includes(operation);
  if (symbol !== undefined) {
    if (!/^[\p{L}\p{N}_]{1,30}USDT$/u.test(symbol) || !['book', 'mark', 'last', 'brackets', 'fee', 'orders', 'algoOrders', 'positions', 'trades', 'history', 'algoHistory', 'income', 'forceOrders', 'klines', 'markKlines'].includes(operation)) throw new AccountError('invalid_symbol', '币种参数无效。', 400);
    url.searchParams.set('symbol', symbol);
  }
  if (operation === 'klines' || operation === 'markKlines') {
    if (!symbol || !candlePeriod || period || !['1m', '5m', '15m', '1h', '4h'].includes(candlePeriod.interval) || !Number.isSafeInteger(candlePeriod.startTime) || !Number.isSafeInteger(candlePeriod.endTime) || candlePeriod.startTime <= 0 || candlePeriod.endTime < candlePeriod.startTime) throw new AccountError('invalid_period', '行情查询参数无效。', 400);
    url.searchParams.set('interval', candlePeriod.interval);
    url.searchParams.set('startTime', String(candlePeriod.startTime));
    url.searchParams.set('endTime', String(candlePeriod.endTime));
    url.searchParams.set('limit', '499');
  } else if (candlePeriod) throw new AccountError('invalid_period', '行情查询参数无效。', 400);
  if (period) {
    if ((!symbol && operation !== 'income') || !['trades', 'history', 'algoHistory', 'income', 'forceOrders'].includes(operation) || !Number.isSafeInteger(period.startTime) || !Number.isSafeInteger(period.endTime) || period.startTime <= 0 || period.endTime < period.startTime || period.endTime - period.startTime >= 7 * 86_400_000) throw new AccountError('invalid_period', '成交查询区间无效或超过支持范围。', 400);
    url.searchParams.set('startTime', String(period.startTime));
    url.searchParams.set('endTime', String(period.endTime));
    url.searchParams.set('limit', operation === 'forceOrders' ? '100' : '1000');
    if (period.page !== undefined) {
      if (operation !== 'income' || !Number.isSafeInteger(period.page) || period.page < 1) throw new AccountError('invalid_period', '分页参数无效。', 400);
      url.searchParams.set('page', String(period.page));
    }
    if (period.autoCloseType !== undefined) {
      if (operation !== 'forceOrders' || !['LIQUIDATION', 'ADL'].includes(period.autoCloseType)) throw new AccountError('invalid_period', '强制订单类型无效。', 400);
      url.searchParams.set('autoCloseType', period.autoCloseType);
    }
  }
  const headers: Record<string, string> = {};
  if (!isPublic) {
    if (!config.apiKey || !config.apiSecret) throw new AccountError('missing_credentials', '未连接：请在后端配置 BINANCE_API_KEY 和 BINANCE_API_SECRET。', 503);
    headers['X-MBX-APIKEY'] = config.apiKey;
  }
  try {
    if (!isPublic) signBinanceRequest(config, url);
    const response = await (config.transport ?? binanceTransport)(url, headers, signal, priority);
    if (operation === 'portfolio' && response.status === 400 && object(response.body).code === -21001) return response.body;
    if (response.status !== 200) {
      const data = object(response.body);
      if (data.code === -1021) throw new AccountError('clock_error', '签名时间不被接受，请同步电脑时间后重试。');
      if (data.code === -2014 || data.code === -2015 || response.status === 401 || response.status === 403) throw new AccountError('access_denied', '读取被拒绝：请检查只读凭据、IP 限制及账户模式；不要启用交易权限。');
      if (response.status === 429 || response.status === 418) throw new AccountError('rate_limited', 'Binance 限流，请稍后再试。');
      throw new AccountError('upstream_error', 'Binance 读取失败，请稍后重试或检查账户模式。');
    }
    if (operation === 'portfolio') throw new AccountError('unsupported_account', '组合保证金账户（含 Pro / SPAN）暂不支持普通 USDT 账户口径。');
    if (integerIdPaths.includes(url.pathname) && typeof response.body === 'string') {
      try {
        return JSON.parse(response.body, (key: string, value: unknown, context?: { source?: string }) =>
          ['uid', 'id', 'orderId', 'actualOrderId', 'algoId', 'tranId', 'tradeId'].includes(key) && typeof value === 'number' ? context?.source ?? value : value);
      } catch { throw new AccountError('invalid_response', operation === 'orders' ? '普通委托响应格式无效，本次列表不可用。' : '账户或委托响应格式无效，本次读取不可用。'); }
    }
    return response.body;
  } catch (error) {
    if (signal.aborted) throw new AccountError('timeout', '查询超时，请检查网络后重试。', 504);
    if (error instanceof AccountError) throw error;
    throw new AccountError('connection_failed', '账户或行情连接失败，请检查网络或后端代理设置。');
  }
}

const writePermissions = [
  'enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures',
  'permitsUniversalTransfer', 'enableVanillaOptions', 'enableFixApiTrade',
  'enableSpotAndMarginTrading', 'enablePortfolioMarginTrading',
] as const;

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,24}(\.\d{1,8})?$/.test(value)) throw new AccountError('invalid_response', 'USDT 金额缺失或精度不支持，无法确认余额。');
  return parseDecimal(value.replace('-', ''), 'USDT 金额') * (value.startsWith('-') ? -1n : 1n);
}

function format(value: bigint): string {
  const [whole, fraction = ''] = formatDecimal(value).split('.');
  return `${whole}.${fraction.padEnd(8, '0')}`;
}

export async function readAccountScope(config: AccountConfig, signal: AbortSignal) {
  // Shared timeout waiters must also know that scope was still unconfirmed.
  const tagAbort = () => { if (signal.reason instanceof AccountError) signal.reason.scopeConfirmed = false; };
  signal.addEventListener('abort', tagAbort, { once: true });
  const read = async (operation: keyof typeof endpoints) => object(await readBinance(config, operation, signal));
  try {
    if (!config.apiKey || !config.apiSecret) throw new AccountError('missing_credentials', '未连接：请在后端配置 BINANCE_API_KEY 和 BINANCE_API_SECRET。', 503);
    signal.throwIfAborted();
    await verifyReadPermissions(config, signal);
    await read('portfolio');
    const account = await read('account');
    if (account.multiAssetsMargin !== false) throw new AccountError('unsupported_account', '仅支持普通 USDT 单资产口径；多资产或无法确认的账户模式暂不支持。');
    if (!Array.isArray(account.assets)) throw new AccountError('invalid_response', '账户资产列表缺失。');
    const assets = account.assets.map(object).filter((asset) => asset.asset === 'USDT');
    if (assets.length !== 1) throw new AccountError('unsupported_account', '无法确认唯一的 USDT 合约资产口径。');
    const asset = assets[0]!;
    return { account, asset };
  } catch (error) {
    if (signal.aborted) {
      const failure = signal.reason instanceof AccountError ? signal.reason : new AccountError('timeout', '账户查询超时，请检查网络后重试。', 504);
      failure.scopeConfirmed = false;
      throw failure;
    }
    if (error instanceof AccountError) { error.scopeConfirmed = false; throw error; }
    const failure = new AccountError('connection_failed', '账户连接失败，请检查网络或后端代理设置。');
    failure.scopeConfirmed = false;
    throw failure;
  } finally { signal.removeEventListener('abort', tagAbort); }
}

async function verifyReadPermissions(config: AccountConfig, signal: AbortSignal, priority: ReadPriority = 'foreground') {
  try {
    const permissions = object(await readBinance(config, 'permissions', signal, undefined, undefined, priority));
    if (permissions.enableReading !== true) throw new AccountError('reading_disabled', '凭据没有可验证的读取权限。');
    if (writePermissions.some((field) => permissions[field] === true)) throw new AccountError('unsafe_permissions', '凭据包含交易、提现或划转权限，请更换专用只读凭据。');
    if (writePermissions.some((field) => permissions[field] !== false)) throw new AccountError('unverified_permissions', '无法完整确认凭据的只读权限，已停止读取。');
  } catch (error) {
    if (error instanceof AccountError) error.scopeConfirmed = false;
    throw error;
  }
}

export async function readReviewIdentity(config: AccountConfig, signal: AbortSignal, priority: ReadPriority = 'foreground') {
  await verifyReadPermissions(config, signal, priority);
  const { uid } = object(await readBinance(config, 'identity', signal, undefined, undefined, priority));
  if (!(typeof uid === 'number' && Number.isSafeInteger(uid) && uid > 0) && !(typeof uid === 'string' && /^[1-9]\d{0,23}$/.test(uid))) throw new AccountError('unverified_identity', '账户身份无法确认，已暂停新增归档；已有账本保留。');
  return String(uid);
}

export async function readAccountData(config: AccountConfig, signal: AbortSignal) {
  const { account, asset } = await readAccountScope(config, signal);
  const wallet = decimal(asset.walletBalance);
  const pnl = decimal(asset.unrealizedProfit);
  const available = decimal(asset.availableBalance);
  if (wallet + pnl !== decimal(asset.marginBalance)) throw new AccountError('invalid_response', 'USDT 权益与钱包余额、未实现盈亏不一致，请重新查询。');
  const snapshot = { source: 'binance' as const, queriedAt: new Date().toISOString(), walletBalance: format(wallet), unrealizedProfit: format(pnl), equity: format(wallet + pnl), availableBalance: format(available) };
  return { account, asset, snapshot };
}

export async function readAccount(config: AccountConfig, symbol?: string, signal = AbortSignal.timeout(10_000)) {
  const { account, snapshot } = await readAccountData(config, signal);
  if (symbol !== undefined) {
    if (account.canTrade !== true) throw new AccountError('trading_disabled', '账户交易状态未确认可用，请在 Binance 检查后刷新；不要为本工具开启 API 交易权限。');
    if (!Array.isArray(account.positions)) throw new AccountError('invalid_response', '持仓列表缺失，无法确认空仓。');
    const positions = account.positions.map(object).filter((position) => position.symbol === symbol);
    if (positions.length !== 1 || positions[0]!.positionSide !== 'BOTH') throw new AccountError('unsupported_position', '无法确认目标币种为单向持仓，请在 Binance 检查后刷新。');
    if (decimal(positions[0]!.positionAmt) !== 0n) throw new AccountError('existing_position', '目标币种已有仓位，请先在 Binance 处理后刷新；本工具不支持加仓。');
    if (positions[0]!.isolated === false) throw new AccountError('unsupported_margin', `${symbol} 当前为全仓模式，本工具仅支持逐仓开仓方案。请在 Binance 将该合约切换为逐仓后刷新，或选择其他币种。`, 409);
    if (positions[0]!.isolated !== true) throw new AccountError('unsupported_margin', `${symbol} 的保证金模式数据缺失或无效，无法确认逐仓，请刷新后重试。`);
  }
  return snapshot;
}

export function accountAssetDetails(asset: Record<string, unknown>) {
  const amount = (field: string) => asset[field] === undefined ? null : format(decimal(asset[field]));
  return { positionInitialMargin: amount('positionInitialMargin'),
    openOrderInitialMargin: amount('openOrderInitialMargin'), maintMargin: amount('maintMargin'),
    maxWithdrawAmount: amount('maxWithdrawAmount') };
}

export async function readAccountAssets(config: AccountConfig, signal = AbortSignal.timeout(10_000)) {
  const { asset, snapshot } = await readAccountData(config, signal);
  return { ...snapshot, ...accountAssetDetails(asset) };
}
