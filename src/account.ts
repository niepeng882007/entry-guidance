import { createHmac } from 'node:crypto';
import { get } from 'node:https';

export type Transport = (url: URL, headers: Record<string, string>, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;
export type AccountConfig = { apiKey?: string; apiSecret?: string; transport?: Transport };

export class AccountError extends Error {
  code: string;
  status: number;
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

const transport: Transport = (url, headers, signal) => new Promise((resolve, reject) => {
  const request = get(url, { headers, signal }, (response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8_000_000) response.destroy(new Error('response too large'));
      else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => {
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reject(new AccountError('upstream_error', 'Binance 返回异常响应，请稍后重试。')); return; }
      resolve({ status: response.statusCode ?? 502, body: data });
    });
  });
  request.on('error', reject);
});

const endpoints = {
  permissions: 'https://api.binance.com/sapi/v1/account/apiRestrictions',
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
} as const;

export async function readBinance(config: AccountConfig, operation: keyof typeof endpoints, signal: AbortSignal, symbol?: string): Promise<unknown> {
  const url = new URL(endpoints[operation]);
  const isPublic = operation === 'exchange' || operation === 'book' || operation === 'mark' || operation === 'last';
  if (symbol !== undefined) {
    if (!/^[\p{L}\p{N}_]{1,30}USDT$/u.test(symbol) || !['book', 'mark', 'last', 'brackets', 'fee', 'orders', 'algoOrders'].includes(operation)) throw new AccountError('invalid_symbol', '币种参数无效。', 400);
    url.searchParams.set('symbol', symbol);
  }
  const headers: Record<string, string> = {};
  if (!isPublic) {
    if (!config.apiKey || !config.apiSecret) throw new AccountError('missing_credentials', '未连接：请在后端配置 BINANCE_API_KEY 和 BINANCE_API_SECRET。', 503);
    headers['X-MBX-APIKEY'] = config.apiKey;
    url.searchParams.set('timestamp', Date.now().toString());
    url.searchParams.set('recvWindow', '5000');
    url.searchParams.set('signature', createHmac('sha256', config.apiSecret).update(url.searchParams.toString()).digest('hex'));
  }
  try {
    const response = await (config.transport ?? transport)(url, headers, signal);
    if (operation === 'portfolio' && response.status === 400 && object(response.body).code === -21001) return response.body;
    if (response.status !== 200) {
      const data = object(response.body);
      if (data.code === -1021) throw new AccountError('clock_error', '签名时间不被接受，请同步电脑时间后重试。');
      if (data.code === -2014 || data.code === -2015 || response.status === 401 || response.status === 403) throw new AccountError('access_denied', '读取被拒绝：请检查只读凭据、IP 限制及账户模式；不要启用交易权限。');
      if (response.status === 429 || response.status === 418) throw new AccountError('rate_limited', 'Binance 限流，请稍后再试。');
      throw new AccountError('upstream_error', 'Binance 读取失败，请稍后重试或检查账户模式。');
    }
    if (operation === 'portfolio') throw new AccountError('unsupported_account', '组合保证金账户（含 Pro / SPAN）暂不支持普通 USDT 账户口径。');
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
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  return BigInt(`${whole}${fraction.padEnd(8, '0')}`) * (value.startsWith('-') ? -1n : 1n);
}

function format(value: bigint): string {
  const digits = (value < 0n ? -value : value).toString().padStart(9, '0');
  return `${value < 0n ? '-' : ''}${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

export async function readAccount(config: AccountConfig, symbol?: string, signal = AbortSignal.timeout(10_000)) {
  if (!config.apiKey || !config.apiSecret) throw new AccountError('missing_credentials', '未连接：请在后端配置 BINANCE_API_KEY 和 BINANCE_API_SECRET。', 503);
  const read = async (operation: keyof typeof endpoints) => object(await readBinance(config, operation, signal));
  try {
    const permissions = await read('permissions');
    if (permissions.enableReading !== true) throw new AccountError('reading_disabled', '凭据没有可验证的读取权限。');
    if (writePermissions.some((field) => permissions[field] === true)) throw new AccountError('unsafe_permissions', '凭据包含交易、提现或划转权限，请更换专用只读凭据。');
    if (writePermissions.some((field) => permissions[field] !== false)) throw new AccountError('unverified_permissions', '无法完整确认凭据的只读权限，已停止读取。');
    await read('portfolio');
    const account = await read('account');
    if (account.multiAssetsMargin !== false) throw new AccountError('unsupported_account', '仅支持普通 USDT 单资产口径；多资产或无法确认的账户模式暂不支持。');
    if (!Array.isArray(account.assets)) throw new AccountError('invalid_response', '账户资产列表缺失。');
    const assets = account.assets.map(object).filter((asset) => asset.asset === 'USDT');
    if (assets.length !== 1) throw new AccountError('unsupported_account', '无法确认唯一的 USDT 合约资产口径。');
    const asset = assets[0]!;
    const wallet = decimal(asset.walletBalance);
    const pnl = decimal(asset.unrealizedProfit);
    const available = decimal(asset.availableBalance);
    if (wallet + pnl !== decimal(asset.marginBalance)) throw new AccountError('invalid_response', 'USDT 权益与钱包余额、未实现盈亏不一致，请重新查询。');
    if (symbol !== undefined) {
      if (account.canTrade !== true) throw new AccountError('trading_disabled', '账户交易状态未确认可用，请在 Binance 检查后刷新；不要为本工具开启 API 交易权限。');
      if (!Array.isArray(account.positions)) throw new AccountError('invalid_response', '持仓列表缺失，无法确认空仓。');
      const positions = account.positions.map(object).filter((position) => position.symbol === symbol);
      if (positions.length !== 1 || positions[0]!.positionSide !== 'BOTH') throw new AccountError('unsupported_position', '无法确认目标币种为单向持仓，请在 Binance 检查后刷新。');
      if (decimal(positions[0]!.positionAmt) !== 0n) throw new AccountError('existing_position', '目标币种已有仓位，请先在 Binance 处理后刷新；本工具不支持加仓。');
      if (positions[0]!.isolated !== true) throw new AccountError('unsupported_margin', '目标币种未确认逐仓模式，请在 Binance 设置逐仓后刷新。');
    }
    return { source: 'binance' as const, queriedAt: new Date().toISOString(), walletBalance: format(wallet), unrealizedProfit: format(pnl), equity: format(wallet + pnl), availableBalance: format(available) };
  } catch (error) {
    if (signal.aborted) throw new AccountError('timeout', '账户查询超时，请检查网络后重试。', 504);
    if (error instanceof AccountError) throw error;
    throw new AccountError('connection_failed', '账户连接失败，请检查网络或后端代理设置。');
  }
}
