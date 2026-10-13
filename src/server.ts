import { readAccountPositions, demoAccountPositions } from './positions.ts';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { AccountError, readAccount, readAccountAssets, type AccountConfig } from './account.ts';
import { demoAccount, demoAccountAssets, readMarket, readSymbols } from './market.ts';
import { createPlan, verifyPosition, type Plan } from './verification.ts';
import { ReviewLedger, demoTrade, type ReviewList } from './review-ledger.ts';
import type { EntryInput } from '../public/draft.js';
import type { ViteDevServer } from 'vite';

export type SavedPlan = Plan & { input: EntryInput; recovery: string };

type Config = AccountConfig & {
  password: string;
  mode?: 'real' | 'demo';
  origin?: string;
  tls?: { cert: Buffer; key: Buffer };
  frontend?: ViteDevServer;
  reviewLedgerPath?: string;
};

const digest = (value: string) => createHash('sha256').update(value).digest();

export function createServer(config: Config) {
  if (config.password.length < 12) throw new Error('APP_PASSWORD 至少需要 12 个字符。');
  const passwordHash = digest(config.password);
  const source = config.mode === 'demo' ? 'demo' : 'binance';
  // Bind restored plans to this installation's password, data mode and account credentials.
  const recoveryKey = scryptSync(config.password, JSON.stringify(['entry-guidance.recovery.v1', source, config.apiKey ?? '', config.apiSecret ?? '']), 32);
  const signature = (payload: string) => createHmac('sha256', recoveryKey).update(payload).digest('base64url');
  const loginPage = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  const frontendPage = config.frontend ? '' : readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // Only built JS/CSS filenames are published; request paths never reach the filesystem.
  const assets = new Map<string, { body: Buffer; type: string }>();
  if (!config.frontend) {
    const directory = new URL('../dist/assets/', import.meta.url);
    for (const name of readdirSync(directory)) {
      if (!/^[\w-]+\.(js|css)$/.test(name)) continue;
      assets.set(`/assets/${name}`, { body: readFileSync(new URL(name, directory)), type: name.endsWith('.css') ? 'text/css' : 'text/javascript' });
    }
  }
  let reviewLedger: ReviewLedger | undefined;
  function getReviewLedger() {
    if (!reviewLedger) {
      const ledger = new ReviewLedger(config.reviewLedgerPath ?? ':memory:', { source: 'demo', accountId: 'demo-account' });
      try { ledger.archive(demoTrade()); }
      catch (error) { ledger.close(); throw error; }
      reviewLedger = ledger;
    }
    return reviewLedger;
  }
  const sessions = new Map<string, { expiresAt: number; generation: number; plans: Map<string, Plan> }>();
  // ponytail: 单人应用共用登录限流；扩展多用户时改为分用户限流。
  let attempts = 0;
  let resetAt = 0;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', config.frontend
      ? "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:24678; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
      : "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
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
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
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
      sessions.set(token, { expiresAt: now + 8 * 60 * 60_000, generation: 0, plans: new Map() });
      res.setHeader('Set-Cookie', `session=${token}; ${cookieFlags}; Max-Age=28800`);
      return redirect('/');
    }
    if (!loggedIn) {
      if (path === '/' || path === '/account' || path === '/review') return redirect('/login');
      return send(401, { error: '请先登录。' });
    }
    if (path === '/logout' && req.method === 'POST') {
      sessions.delete(cookie!);
      res.setHeader('Set-Cookie', `session=; ${cookieFlags}; Max-Age=0`);
      return redirect('/login');
    }
    if ((path === '/api/plan' || path === '/api/plan/recover') && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(415, { error: '方案输入格式不支持。' });
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > (path === '/api/plan/recover' ? 16_384 : 4096)) return send(413, { error: '方案输入过大。' });
      }
      let input: unknown;
      try { input = JSON.parse(body); }
      catch { return send(400, { error: '方案输入格式无效。' }); }
      try {
        const existing = sessions.get(cookie!);
        if (!existing || existing.expiresAt <= Date.now()) return send(401, { error: '登录已过期，请重新登录。' });
        if (path === '/api/plan/recover') {
          const recovery = input && typeof input === 'object' && 'recovery' in input ? input.recovery : undefined;
          if (typeof recovery !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(recovery) || Object.keys(input!).length !== 1) return send(400, { error: '恢复凭证缺失或格式无效，原参数仍可查看。' });
          const [payload, mac] = recovery.split('.') as [string, string];
          if (!timingSafeEqual(Buffer.from(mac), Buffer.from(signature(payload)))) return send(409, { error: '无法完整核验：原方案凭证损坏，或密码、账户配置、数据模式已改变。请保留原参数，不要为已有仓位重新扩大预算。' });
          const saved = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { version: number; plan: Plan; input: EntryInput };
          if (saved.version !== 1 || saved.plan.source !== source) return send(409, { error: '原方案版本或数据来源不匹配，无法完整核验。' });
          if (!existing.plans.has(saved.plan.id) && existing.plans.size >= 20) return send(409, { error: '当前会话方案数量已达上限，请重新登录后恢复本单。' });
          existing.plans.set(saved.plan.id, saved.plan);
          return send(200, { ...saved.plan, input: saved.input, recovery } satisfies SavedPlan);
        }
        // ponytail: cap in-memory plans at 20; browser-held signed plans survive relogin without a history database.
        if (existing.plans.size >= 20) return send(409, { error: '当前会话已保存 20 个方案，暂停生成；原方案仍可核验，请完成本单后再重新登录。' });
        const generation = ++existing.generation;
        const plan = await createPlan(config, input);
        const session = sessions.get(cookie!);
        if (!session || session.expiresAt <= Date.now()) return send(401, { error: '登录已过期，请重新登录。' });
        if (generation !== session.generation) return send(409, { error: '已有更新的方案请求，本次结果已作废。' });
        session.plans.set(plan.id, plan);
        const payload = Buffer.from(JSON.stringify({ version: 1, plan, input })).toString('base64url');
        return send(200, { ...plan, input: input as EntryInput, recovery: `${payload}.${signature(payload)}` } satisfies SavedPlan);
      } catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return send(error.status, { error: error.message, code: error.code, attemptedAt: new Date().toISOString() });
      }
    }
    if (req.method !== 'GET') return send(405, { error: '仅支持读取。' });
    if (path?.startsWith('/api/verification?')) {
      const query = new URL(path, origin).searchParams;
      const plan = sessions.get(cookie!)?.plans.get(query.get('planId') ?? '');
      if (!query.has('planId') || query.getAll('planId').length !== 1 || [...query.keys()].some((key) => key !== 'planId' && !(config.mode === 'demo' && key === 'demo')) || query.getAll('demo').length > 1) return send(400, { error: '核验仅接受本次方案 ID；模拟场景仅在模拟模式可用。' });
      if (!plan || query.get('planId') !== plan.id) return send(409, { error: '无法关联原方案，请保留原参数；需要重新确认空仓起点。' });
      try { return send(200, await verifyPosition(config, plan, query.get('demo') ?? undefined)); }
      catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return send(error.status, { error: error.message, code: error.code, source: plan.source, attemptedAt: new Date().toISOString() });
      }
    }
    if (path === '/api/review/trades' || path?.startsWith('/api/review/trades/')) {
      try {
        if (path === '/api/review/trades') {
          return send(200, {
            source, accountId: source === 'demo' ? 'demo-account' : null,
            syncStatus: source === 'demo' ? 'demo' : 'not-synced',
            trades: source === 'demo' ? getReviewLedger().list() : [],
          } satisfies ReviewList);
        }
        const id = path.slice('/api/review/trades/'.length);
        if (!/^[A-Za-z0-9-]{1,160}$/.test(id)) return send(400, { error: '交易身份无效。' });
        const trade = source === 'demo' ? getReviewLedger().get(id) : null;
        return trade ? send(200, trade) : send(404, { error: '未找到该来源的归档交易。' });
      } catch { return send(503, { error: '复盘账本暂不可用，已有归档保留，请重试。' }); }
    }
    if (path === '/' || path === '/account' || path === '/review') {
      let pageKind = 'workbench';
      let pageTitle = '开仓卡 · 开仓前';
      if (path === '/account') { pageKind = 'account'; pageTitle = '账户快照 · USDT'; }
      else if (path === '/review') { pageKind = 'review'; pageTitle = '交易复盘'; }
      const page = config.frontend
        ? await config.frontend.transformIndexHtml(path, readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8'))
        : frontendPage;
      return html(200, page.replace('{{source}}', config.mode === 'demo' ? '模拟数据 · 仅用于界面与流程验证' : '真实模式 · 数据由 Binance 只读接口查询')
        .replace('{{page}}', pageKind).replace('{{mode}}', source)
        .replace('开仓卡 · 开仓前', pageTitle));
    }
    const asset = assets.get(path ?? '');
    if (asset) return res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` }).end(asset.body);
    if (config.frontend && path && !path.startsWith('/api/')) {
      return config.frontend.middlewares(req, res, () => send(404, { error: '入口不存在。' }));
    }
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
    if (path === '/api/account/assets' || path === '/api/account/positions') {
      try {
        const data = path === '/api/account/positions'
          ? config.mode === 'demo' ? demoAccountPositions() : await readAccountPositions(config)
          : config.mode === 'demo' ? demoAccountAssets() : await readAccountAssets(config);
        const session = sessions.get(cookie!);
        if (!session || session.expiresAt <= Date.now()) return send(401, { error: '登录已过期，请重新登录。' });
        return send(200, data);
      } catch (error) {
        if (!(error instanceof AccountError)) throw error;
        return send(error.status, { source, code: error.code, error: error.message, attemptedAt: new Date().toISOString() });
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
  server.on('close', () => reviewLedger?.close());
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.setTimeout(15_000, (socket) => socket.destroy());
  return server;
}
