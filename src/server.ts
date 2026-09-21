import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { AccountError, readAccount, type AccountConfig } from './account.ts';
import { demoAccount, readMarket, readSymbols } from './market.ts';

type Config = AccountConfig & {
  password: string;
  mode?: 'real' | 'demo';
  origin?: string;
  tls?: { cert: Buffer; key: Buffer };
};

const digest = (value: string) => createHash('sha256').update(value).digest();

export function createServer(config: Config) {
  if (config.password.length < 12) throw new Error('APP_PASSWORD 至少需要 12 个字符。');
  const passwordHash = digest(config.password);
  const loginPage = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  const accountPage = readFileSync(new URL('../public/account.html', import.meta.url), 'utf8');
  const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const draftScript = readFileSync(new URL('../public/draft.js', import.meta.url), 'utf8');
  const sessions = new Map<string, number>();
  // ponytail: 单人应用共用登录限流；扩展多用户时改为分用户限流。
  let attempts = 0;
  let resetAt = 0;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    const html = (status: number, value: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(value);
    };
    const redirect = (location: string) => res.writeHead(303, { Location: location }).end();
    const origin = config.origin ?? `http://127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== new URL(origin).host) return send(403, { error: '访问地址不匹配。' });
    if (req.method === 'POST' && req.headers.origin !== origin) return send(403, { error: '请从本应用页面提交。' });
    const path = req.url;
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('session='))?.slice(8);
    const now = Date.now();
    for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
    const loggedIn = cookie !== undefined && sessions.has(cookie);
    const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${config.tls ? '; Secure' : ''}`;

    if (path === '/style.css' && req.method === 'GET') return res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }).end(style);
    if (path === '/login' && req.method === 'GET') return html(200, loginPage.replace('{{error}}', ''));
    if (path === '/login' && req.method === 'POST') {
      if (now >= resetAt) { attempts = 0; resetAt = now + 15 * 60_000; }
      if (attempts >= 10) {
        res.setHeader('Retry-After', Math.ceil((resetAt - now) / 1000));
        return html(429, loginPage.replace('{{error}}', '尝试过于频繁，请 15 分钟后重试。'));
      }
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return send(415, { error: '表单格式不支持。' });
      attempts++;
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2048) return send(413, { error: '表单过大。' });
      }
      const password = new URLSearchParams(body).get('password') ?? '';
      if (!timingSafeEqual(digest(password), passwordHash)) return html(401, loginPage.replace('{{error}}', '密码不正确。'));
      attempts = 0;
      if (cookie) sessions.delete(cookie);
      if (sessions.size >= 20) sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now + 8 * 60 * 60_000);
      res.setHeader('Set-Cookie', `session=${token}; ${cookieFlags}; Max-Age=28800`);
      return redirect('/');
    }
    if (!loggedIn) {
      if (path === '/') return redirect('/login');
      return send(401, { error: '请先登录。' });
    }
    if (path === '/logout' && req.method === 'POST') {
      sessions.delete(cookie!);
      res.setHeader('Set-Cookie', `session=; ${cookieFlags}; Max-Age=0`);
      return redirect('/login');
    }
    if (req.method !== 'GET') return send(405, { error: '仅支持读取。' });
    if (path === '/') return html(200, accountPage.replace('{{source}}', config.mode === 'demo' ? '模拟数据 · 仅用于界面与流程验证' : '真实模式 · 数据由 Binance 只读接口查询'));
    if (path === '/app.js') return res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(script);
    if (path === '/draft.js') return res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(draftScript);
    if (path === '/api/symbols') {
      try { return send(200, await readSymbols(config)); }
      catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return send(error.status, { error: error.message, code: error.code });
      }
    }
    if (path?.startsWith('/api/market?')) {
      const query = new URL(path, origin).searchParams;
      if (query.size !== 1 || !query.has('symbol')) return send(400, { error: '仅接受一个币种参数。' });
      try { return send(200, await readMarket(config, query.get('symbol')!)); }
      catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return send(error.status, { source: config.mode === 'demo' ? 'demo' : 'binance', code: error.code, error: error.message, attemptedAt: new Date().toISOString() });
      }
    }
    if (path === '/api/account') {
      if (config.mode === 'demo') return send(200, demoAccount());
      try { return send(200, await readAccount(config)); }
      catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return send(error.status, { source: 'binance', code: error.code, error: error.message, attemptedAt: new Date().toISOString() });
      }
    }
    return send(404, { error: '入口不存在。' });
  }
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请求失败，请重试。' }));
    });
  };
  const server = config.tls ? createHttpsServer(config.tls, handler) : createHttpServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.setTimeout(15_000, (socket) => socket.destroy());
  return server;
}
