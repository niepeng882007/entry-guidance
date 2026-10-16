import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PrismaClient } from './generated/prisma/client.ts';
import { verifyDelegation } from './identity/delegation.ts';
import { AccountError, binanceTransport, signBinanceRequest, type Transport } from './account.ts';
import { createBinanceEgress } from './binance-egress.ts';
import { credentialMasterKey } from './bindings/credential.ts';
import { createBoundAccountReader, type AccountResource } from './bindings/account.ts';
import {
  BindingError,
  bindingMetadata,
  bindingSubmission,
  requireBusinessIdentity,
  saveBinding,
} from './bindings/binding.ts';

export function createBusinessServer(options: {
  database: PrismaClient;
  authOrigin: string;
  businessOrigin: string;
  publicKey: string;
  credentialMaster?: { key: Buffer; version: number };
  transport?: Transport;
  simulation?: boolean;
}) {
  const egress = createBinanceEgress(options.database, options.transport);
  const accounts = createBoundAccountReader({
    database: options.database,
    master: () => options.credentialMaster ?? credentialMasterKey(),
    transport: options.transport,
    egress,
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Vary', 'Origin');
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (request.headers.host !== new URL(options.businessOrigin).host)
      return reply(403, { error: '访问来源不受支持。' });
    if (request.headers.origin && request.headers.origin !== options.authOrigin)
      return reply(403, { error: '访问来源不受支持。' });
    if (request.headers.origin)
      response.setHeader('Access-Control-Allow-Origin', options.authOrigin);
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Account-Refresh',
      );
      response.writeHead(204).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', options.businessOrigin);
    } catch {
      return reply(400, { error: '请求地址无效。' });
    }
    const match =
      /^\/v1\/users\/([^/]+)\/(profile|binding|account\/(summary|assets|positions|orders|conditional-orders))$/.exec(
        url.pathname,
      );
    const writing = request.method === 'POST' && match?.[2] === 'binding';
    if (!match || (request.method !== 'GET' && !writing) || url.search)
      return reply(404, { error: '此入口不可用。' });
    if (writing && request.headers.origin !== options.authOrigin)
      return reply(403, { error: '访问来源不受支持。' });
    const authorization = request.headers.authorization ?? '';
    const claims = authorization.startsWith('Bearer ')
      ? verifyDelegation(
          authorization.slice(7),
          options.publicKey,
          options.authOrigin,
          options.businessOrigin,
        )
      : null;
    if (!claims) return reply(401, { error: '请重新登录。' });
    const expectedScope = `${match[3] ? 'account' : match[2]}:${writing ? 'write' : 'read'}`;
    if (claims.scope !== expectedScope) return reply(403, { error: '操作未授权。' });
    if (match[1] !== claims.sub) return reply(403, { error: '无权访问此资料。' });
    try {
      const session = await requireBusinessIdentity(options.database, claims, writing);
      if (match[3]) {
        const controller = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once('close', cancel);
        try {
          const result = await accounts.read(
            claims,
            match[3] as AccountResource,
            request.headers['x-account-refresh'] === 'automatic',
            controller.signal,
          );
          return reply(200, { ...result, ...(options.simulation ? { source: 'demo' } : {}) });
        } finally {
          response.off('close', cancel);
        }
      }
      if (match[2] === 'profile')
        return reply(200, {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          ...(options.simulation ? { simulation: true } : {}),
        });
      if (!writing) {
        const binding = await options.database.binanceBinding.findFirst({
          where: { userId: session.userId, state: 'active', source: 'binance-live' },
          select: bindingMetadata,
        });
        return reply(200, { binding });
      }
      if (request.headers['content-type']?.split(';')[0] !== 'application/json')
        return reply(415, { error: '请求格式不受支持。' });
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 4096) return reply(413, { error: '请求过大。' });
        chunks.push(bytes);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(422, { error: '请求格式无效。' });
      }
      const submission = bindingSubmission(body);
      const result = await saveBinding({
        database: options.database,
        claims,
        submission,
        master: options.credentialMaster ?? credentialMasterKey(),
        transport: (url, headers, signal, priority = 'foreground') =>
          egress.run(url, signal, priority, async (bounded) => {
            await requireBusinessIdentity(options.database, claims, true);
            bounded.throwIfAborted();
            if (url.searchParams.has('signature')) signBinanceRequest(submission, url);
            return (options.transport ?? binanceTransport)(url, headers, bounded, priority);
          }),
        signal: AbortSignal.timeout(10000),
      });
      return reply(200, result);
    } catch (cause) {
      let error = cause;
      if (writing && error instanceof AccountError) {
        try {
          await requireBusinessIdentity(options.database, claims, true);
        } catch (identityError) {
          error = identityError;
        }
      }
      if (error instanceof BindingError) return reply(error.status, { error: error.message });
      if (error instanceof AccountError && match[3]) {
        if (error.retryAt)
          response.setHeader(
            'Retry-After',
            Math.max(0, Math.ceil((Date.parse(error.retryAt) - Date.now()) / 1000)),
          );
        return reply(error.status, {
          source: 'binance',
          code: error.code,
          error: error.message,
          attemptedAt: error.attemptedAt ?? new Date().toISOString(),
          retryAt: error.retryAt,
          scopeConfirmed: error.scopeConfirmed,
        });
      }
      if (error instanceof AccountError)
        return reply(
          error.code === 'unsafe_permissions' ||
            error.code === 'reading_disabled' ||
            error.code === 'unverified_permissions' ||
            error.code === 'unverified_identity'
            ? 422
            : 503,
          { error: '无法确认凭据的只读权限或账户身份；原有数据已保留。' },
        );
      return reply(503, { error: '业务服务暂时不可用，请稍后重试。' });
    }
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  server.requestTimeout = 15000;
  server.once('close', () => accounts.stop());
  return server;
}
