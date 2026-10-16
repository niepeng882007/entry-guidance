import {
  AccountError,
  binanceTransport,
  object,
  orderDownloadHost,
  readReviewIdentity,
  signBinanceRequest,
  type AccountConfig,
} from './account.ts';
import { setTimeout } from 'node:timers/promises';
import { orderCsvFiles, parseOrderCsv } from './order-file.ts';
import type { ArchiveState, ReviewLedger } from './review-ledger.ts';

export type OrderDownloadRequest = { startTime: number; endTime: number } | { downloadId: string };
export type OrderDownloadResult =
  { downloadId: string } | { status: 'processing' | 'completed'; url: string };

export async function readOrderFile(
  config: AccountConfig,
  address: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = new URL(address);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== orderDownloadHost ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new AccountError(
      'invalid_download_host',
      '下载地址不在已验证的 Binance 文件主机白名单中，停止本次下载。',
    );
  try {
    const response = await (config.transport ?? binanceTransport)(url, {}, signal, 'archive');
    if (response.status === 403 || response.status === 404)
      throw new AccountError(
        'download_link_unavailable',
        '文件链接已不可用；下次手动更新将重新生成，可能使用一次额度。',
      );
    if (
      response.status !== 200 ||
      !(response.body instanceof Uint8Array) ||
      response.body.byteLength > 64_000_000
    )
      throw new AccountError('download_failed', '文件下载失败或文件超过大小限制，保留原任务。');
    return Buffer.from(response.body);
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError('download_failed', '文件下载中断，请手动继续已有任务。');
  }
}

export async function requestOrderDownload(
  config: AccountConfig,
  input: OrderDownloadRequest,
  signal: AbortSignal,
): Promise<OrderDownloadResult> {
  const query = 'downloadId' in input;
  const url = new URL(
    query
      ? 'https://fapi.binance.com/fapi/v1/order/asyn/id'
      : 'https://fapi.binance.com/fapi/v1/order/asyn',
  );
  if (!config.apiKey || !config.apiSecret)
    throw new AccountError('missing_credentials', '后端只读凭据缺失。', 503);
  if (query) {
    if (!/^\d{1,30}$/.test(input.downloadId))
      throw new AccountError('invalid_download', '下载任务身份无效。', 400);
    url.searchParams.set('downloadId', input.downloadId);
  } else {
    if (
      !Number.isSafeInteger(input.startTime) ||
      !Number.isSafeInteger(input.endTime) ||
      input.startTime <= 0 ||
      input.endTime < input.startTime ||
      input.endTime - input.startTime >= 365 * 86_400_000
    )
      throw new AccountError('invalid_download', '下载时间范围无效。', 400);
    url.searchParams.set('startTime', String(input.startTime));
    url.searchParams.set('endTime', String(input.endTime));
  }
  signBinanceRequest(config, url);
  let response;
  try {
    response = await (config.transport ?? binanceTransport)(
      url,
      { 'X-MBX-APIKEY': config.apiKey },
      signal,
      'archive',
    );
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError(
      'download_unknown',
      '下载请求未得到确认；请查询已有任务，不要重复生成。',
    );
  }
  if (response.status !== 200) {
    let code = 'download_failed';
    if (response.status >= 500) code = 'download_unknown';
    if (response.status === 429 || response.status === 418) code = 'rate_limited';
    throw new AccountError(code, '下载接口拒绝本次请求；请检查额度或稍后手动重试。');
  }
  const data = object(response.body);
  if (!query) {
    if (typeof data.downloadId !== 'string' || !/^\d{1,30}$/.test(data.downloadId))
      throw new AccountError(
        'download_unknown',
        '下载任务响应无效；不能确认是否已占用额度，请勿自动重新生成。',
      );
    return { downloadId: data.downloadId };
  }
  if (!['processing', 'completed'].includes(String(data.status)) || typeof data.url !== 'string')
    throw new AccountError('invalid_download', '下载状态响应无效。');
  if (data.status === 'completed') {
    let target: URL;
    try {
      target = new URL(data.url);
    } catch {
      throw new AccountError('invalid_download', '下载地址无效。');
    }
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      target.hash
    )
      throw new AccountError('invalid_download', '下载地址不符合 HTTPS 文件读取要求。');
  }
  return { status: data.status as 'processing' | 'completed', url: data.url };
}

export async function updateOrderHistory(
  config: AccountConfig,
  ledger: ReviewLedger,
  state: ArchiveState,
  signal: AbortSignal,
  range?: { startTime: number; endTime: number },
) {
  const previous = state.orderDownload;
  if (previous?.status === 'unknown' || previous?.status === 'submitting') {
    state.orderDownload = {
      ...previous,
      status: 'unknown',
      message: '上次生成结果不明，未再次消耗下载额度；本次使用普通历史接口补查。',
    };
    state.scopeMissing.push(state.orderDownload.message);
    ledger.saveArchive(state);
    return;
  }
  const pending = previous?.downloadId && previous.status !== 'complete' ? previous : null;
  state.orderDownload = pending ?? {
    status: 'submitting',
    downloadId: null,
    startTime: range?.startTime ?? Math.max(state.startTime, state.endTime - 365 * 86_400_000 + 1),
    endTime: range?.endTime ?? state.endTime,
    records: 0,
    message: '正在生成订单文件；同一任务不会重复提交。',
  };
  const download = state.orderDownload;
  ledger.saveArchive(state);
  try {
    if (!download.downloadId) {
      const result = await requestOrderDownload(
        config,
        { startTime: download.startTime, endTime: download.endTime },
        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      );
      if (!('downloadId' in result))
        throw new AccountError('download_unknown', '生成结果不明，未重新提交。');
      download.downloadId = result.downloadId;
      download.status = 'processing';
      download.message = 'Binance 正在生成订单文件，等待同一任务完成。';
      ledger.saveArchive(state);
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await requestOrderDownload(
        config,
        { downloadId: download.downloadId },
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
      if (!('status' in result)) throw new AccountError('invalid_download', '下载状态响应无效。');
      if (result.status === 'processing') {
        await setTimeout(5000, undefined, { signal });
        continue;
      }
      const file = await readOrderFile(
        config,
        result.url,
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      );
      const records = orderCsvFiles(file).flatMap((text) =>
        parseOrderCsv(text, ledger.scope().accountId, download.startTime, download.endTime),
      );
      if (
        (await readReviewIdentity(
          config,
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          'archive',
        )) !== ledger.scope().accountId
      )
        throw new AccountError('identity_changed', '账户身份已变化，未写入下载文件。');
      if (
        new Set(records.map((record) => `${String(record.payload.symbol)}:${record.id}`)).size !==
        records.length
      )
        throw new AccountError('invalid_order_file', '文件包含重复订单身份，未写入账本。');
      download.status = 'complete';
      download.records = records.length;
      download.message = `订单文件已保存：${records.length} 张；继续补齐成交盈亏与复盘证据。`;
      state.symbols = [
        ...new Set([...state.symbols, ...records.map((record) => String(record.payload.symbol))]),
      ].sort();
      ledger.saveArchive(state, records);
      return;
    }
    download.status = 'processing';
    download.message = '文件仍在生成；本次已停止等待，下次手动更新将查询同一任务。';
    state.scopeMissing.push(download.message);
    ledger.saveArchive(state);
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof AccountError &&
        ['rate_limited', 'unsafe_permissions', 'access_denied', 'identity_changed'].includes(
          error.code,
        ))
    )
      throw error;
    download.status =
      error instanceof AccountError && error.code === 'download_unknown' && !download.downloadId
        ? 'unknown'
        : 'failed';
    download.message =
      error instanceof AccountError ? error.message : '订单文件未能确认；保留已有记录。';
    if (error instanceof AccountError && error.code === 'download_link_unavailable')
      download.downloadId = null;
    state.scopeMissing.push(
      `订单下载：${download.message} 普通接口仅补充其可查询的近期数据，更早区间仍可能缺失。`,
    );
    ledger.saveArchive(state);
  }
}
