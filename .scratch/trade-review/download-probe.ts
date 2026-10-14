import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AccountError, readReviewIdentity } from '../../src/account.ts';
import { requestOrderDownload, readOrderFile } from '../../src/order-download.ts';

const path = new URL('./download-probe-state.json', import.meta.url);
const config = { apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET };
try {
  if (!existsSync(path)) {
    if (!process.argv.includes('--generate')) throw new Error('尚无任务；只有显式 --generate 才生成一份订单文件。');
    await readReviewIdentity(config, AbortSignal.timeout(10_000));
    // One fixed Shanghai calendar day; repeated runs reuse the saved task.
    const startTime = Date.parse('2026-10-13T00:00:00+08:00');
    const endTime = Date.parse('2026-10-14T00:00:00+08:00') - 1;
    writeFileSync(path, JSON.stringify({ status: 'submitting', startTime, endTime }), { mode: 0o600, flag: 'wx' });
    const result = await requestOrderDownload(config, { startTime, endTime }, AbortSignal.timeout(20_000));
    if (!('downloadId' in result)) throw new Error('生成响应无效。');
    writeFileSync(path, JSON.stringify({ ...result, startTime, endTime }), { mode: 0o600 });
  }
  const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!state || typeof state !== 'object' || !('downloadId' in state) || typeof state.downloadId !== 'string') throw new Error('上次提交结果不明，禁止再次生成；需先核实 Binance 下载任务。');
  const result = await requestOrderDownload(config, { downloadId: state.downloadId }, AbortSignal.timeout(20_000));
  if (!('status' in result)) throw new Error('查询响应无效。');
  if (result.status === 'completed' && process.argv.includes('--file')) {
    const content = await readOrderFile(config, result.url, AbortSignal.timeout(30_000));
    writeFileSync(new URL('./download-probe-sample.bin', import.meta.url), content, { mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, hostname: new URL(result.url).hostname, fileDownloaded: true, bytes: content.length, magic: content.subarray(0, 4).toString('hex') }));
  } else console.log(JSON.stringify({ status: result.status, hostname: result.status === 'completed' ? new URL(result.url).hostname : null, fileDownloaded: false }));
} catch (error) {
  console.error(error instanceof AccountError || error instanceof Error && !config.apiKey ? error.message : '核查失败；未输出上游响应、凭据或下载链接。');
  process.exitCode = 1;
}
