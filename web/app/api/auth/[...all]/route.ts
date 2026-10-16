import { connection } from 'next/server';
import { currentIdentity, getAuth } from '../../../../../src/identity/auth.ts';
import { requestAllowed } from '../../../../../src/identity/config.ts';

async function handle(request: Request) {
  await connection();
  const path = new URL(request.url).pathname;
  if (!requestAllowed(request))
    return Response.json({ error: '访问来源不受支持。' }, { status: 403 });
  if (!(
    (request.method === 'POST' &&
      ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path)) ||
    (request.method === 'GET' && path === '/api/auth/get-session')
  ))
    return Response.json({ error: '此入口尚未开放。' }, { status: 404 });
  try {
    if (request.method === 'GET') {
      const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
      const identity = await currentIdentity(request.headers, responseHeaders);
      return Response.json(identity, {
        status: identity ? 200 : 401,
        headers: responseHeaders,
      });
    }
    const response = await getAuth().handler(request);
    response.headers.set('Cache-Control', 'no-store');
    const retryAfter = response.headers.get('X-Retry-After');
    if (response.status === 429 && retryAfter) response.headers.set('Retry-After', retryAfter);
    return response;
  } catch {
    return Response.json({ error: '登录服务暂时不可用。' }, { status: 503 });
  }
}
export { handle as GET, handle as POST };
