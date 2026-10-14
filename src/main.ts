import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from './server.ts';

try {
  const origin = new URL(process.env.APP_ORIGIN ?? 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('APP_ORIGIN 必须是完整的本地访问源地址，不含路径、凭据或参数。');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (!loopback && origin.protocol !== 'https:') throw new Error('手机局域网访问需使用本地 HTTPS；本机测试请使用 http://127.0.0.1:3000。');
  const mode = process.env.APP_MODE ?? 'real';
  if (mode !== 'real' && mode !== 'demo') throw new Error('APP_MODE 仅支持 real 或 demo。');
  const development = process.argv.includes('--dev');
  if (development && (!loopback || origin.protocol !== 'http:')) throw new Error('APP_ORIGIN 开发热更新仅支持本机 HTTP；手机请使用构建后的 pnpm start。');
  if ((process.env.APP_PASSWORD ?? '').length < 12) throw new Error('APP_PASSWORD 至少需要 12 个字符。');
  let tls;
  if (origin.protocol === 'https:') {
    if (!process.env.TLS_CERT_FILE || !process.env.TLS_KEY_FILE) throw new Error('HTTPS 需要配置 TLS_CERT_FILE 和 TLS_KEY_FILE。');
    try { tls = { cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE) }; }
    catch { throw new Error('无法读取本地 HTTPS 证书或私钥文件。'); }
  }
  const httpServer = development ? createHttpServer() : undefined;
  const frontend = development ? await (await import('vite')).createServer({
    // Node watch must not restart when Vite deletes its bundled temporary config.
    configLoader: 'native',
    server: { middlewareMode: true, ws: { server: httpServer, host: origin.hostname, clientPort: Number(origin.port || 80) } },
  }) : undefined;
  const server = createServer({
    password: process.env.APP_PASSWORD ?? '', origin: origin.origin, tls, mode, frontend, httpServer,
    apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET,
    llm: { provider: process.env.LLM_PROVIDER ?? '', model: process.env.LLM_MODEL ?? '', effort: process.env.LLM_EFFORT ?? '', apiKey: process.env.LLM_API_KEY ?? '' },
    reviewLedgerPath: join(resolve(process.env.REVIEW_DATA_DIR ?? '.local/review'), `${mode}.sqlite`),
  });
  server.on('close', () => { void frontend?.close(); });
  server.on('error', () => { console.error('服务启动失败，请检查访问地址、端口及 HTTPS 配置。'); void frontend?.close(); process.exitCode = 1; });
  server.listen(Number(origin.port || (tls ? 443 : 80)), origin.hostname.replace(/^\[|\]$/g, ''), () => {
    console.log(`本地工作台已启动（${mode === 'demo' ? '模拟数据' : '真实只读模式'}）。${origin.origin}`);
  });
} catch (error) {
  // Only our own configuration messages are displayed; never log environment values or stacks.
  console.error(error instanceof Error && error.message.startsWith('APP_') ? error.message : '启动失败：检查密码（至少 12 字符）、本地访问地址和 HTTPS 证书配置。');
  process.exitCode = 1;
}
