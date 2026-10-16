import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PrismaClient } from './generated/prisma/client.ts';
import { verifyDelegation } from './identity/delegation.ts';

export function createBusinessServer(options: {
  database: PrismaClient;
  authOrigin: string;
  businessOrigin: string;
  publicKey: string;
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
      response.setHeader('Access-Control-Allow-Methods', 'GET');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization');
      response.writeHead(204).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', options.businessOrigin);
    } catch {
      return reply(400, { error: '请求地址无效。' });
    }
    const match = /^\/v1\/users\/([^/]+)\/profile$/.exec(url.pathname);
    if (!match || request.method !== 'GET' || url.search)
      return reply(404, { error: '此入口不可用。' });
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
    if (match[1] !== claims.sub) return reply(403, { error: '无权读取此资料。' });
    try {
      // A signed claim never replaces the current database session and user status.
      const session = await options.database.session.findUnique({
        where: { id: claims.sid },
        include: { user: true },
      });
      if (
        !session ||
        session.userId !== claims.sub ||
        session.expiresAt.getTime() <= Date.now() ||
        session.user.disabled ||
        !session.user.emailVerified ||
        session.user.authorizationVersion !== claims.version
      )
        return reply(401, { error: '请重新登录。' });
      return reply(200, {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      });
    } catch {
      return reply(503, { error: '资料服务暂时不可用，请稍后重试。' });
    }
  }
  return createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
}
