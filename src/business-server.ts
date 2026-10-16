import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PrismaClient } from './generated/prisma/client.ts';
import { verifyDelegation } from './identity/delegation.ts';
import { AccountError, type Transport } from './account.ts';
import { credentialMasterKey } from './bindings/credential.ts';
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
}) {
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
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.writeHead(204).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', options.businessOrigin);
    } catch {
      return reply(400, { error: '请求地址无效。' });
    }
    const match = /^\/v1\/users\/([^/]+)\/(profile|binding)$/.exec(url.pathname);
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
    const expectedScope = `${match[2]}:${writing ? 'write' : 'read'}`;
    if (claims.scope !== expectedScope) return reply(403, { error: '操作未授权。' });
    if (match[1] !== claims.sub) return reply(403, { error: '无权访问此资料。' });
    try {
      const session = await requireBusinessIdentity(options.database, claims, writing);
      if (match[2] === 'profile')
        return reply(200, {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
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
        transport: options.transport,
        signal: AbortSignal.timeout(10000),
      });
      return reply(200, result);
    } catch (error) {
      if (error instanceof BindingError) return reply(error.status, { error: error.message });
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
  return server;
}
