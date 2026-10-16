import { connection } from 'next/server';
import { getIP } from 'better-auth/api';
import { currentIdentity, getAuth } from '../../../../../src/identity/auth.ts';
import {
  authIpAddressOptions,
  authOrigin,
  requestAllowed,
} from '../../../../../src/identity/config.ts';
import { consumeQuota } from '../../../../../src/identity/rate-limit.ts';
import { manageSessions } from '../../../../../src/identity/sessions.ts';

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
const callbackPath = '/verify-email?verified=1';
const resetPath = '/reset-password';
function limited(retryAfter: number | null) {
  return Response.json(
    { error: '尝试过于频繁，请稍后重试。' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}
async function handle(request: Request) {
  await connection();
  const url = new URL(request.url);
  const path = url.pathname;
  if (!requestAllowed(request))
    return Response.json({ error: '访问来源不受支持。' }, { status: 403 });
  const registration = path === '/api/auth/sign-up/email';
  const resend = path === '/api/auth/send-verification-email';
  const verification = path === '/api/auth/verify-email';
  const recovery = path === '/api/auth/request-password-reset';
  const reset = path === '/api/auth/reset-password';
  const resetCallback = /^\/api\/auth\/reset-password\/[a-zA-Z0-9_-]{1,128}$/.test(path);
  const sessionList = path === '/api/auth/list-sessions';
  const sessionWrite = ['/api/auth/revoke-session', '/api/auth/revoke-other-sessions'].includes(
    path,
  );
  if (!(
    (request.method === 'POST' &&
      (registration ||
        resend ||
        recovery ||
        reset ||
        sessionWrite ||
        ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path))) ||
    (request.method === 'GET' &&
      (verification || resetCallback || sessionList || path === '/api/auth/get-session'))
  ))
    return Response.json({ error: '此入口尚未开放。' }, { status: 404 });
  let registrationEmail = '';
  try {
    if (sessionList || sessionWrite)
      return await manageSessions(request, sessionWrite ? await readBody(request) : undefined);
    if (registration || resend || recovery) {
      const ip = getIP(request, { advanced: { ipAddress: authIpAddressOptions() } }) ?? 'shared';
      const quota = await consumeQuota(
        `request-ip:${registration ? 'registration' : recovery ? 'recovery' : 'verification'}:${ip}`,
        { window: registration ? 3600 : 60, max: registration ? 10 : 30 },
      );
      if (!quota.allowed) return limited(quota.retryAfter);
    }
    if (request.method === 'GET' && !verification && !resetCallback) {
      const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
      const identity = await currentIdentity(request.headers, responseHeaders);
      return Response.json(identity ? { authenticated: true } : null, {
        status: identity ? 200 : 401,
        headers: responseHeaders,
      });
    }
    if (verification || resetCallback) {
      const destination = resetCallback ? resetPath : callbackPath;
      const callback = url.searchParams.get('callbackURL');
      if (
        (request.headers.has('origin') && request.headers.get('origin') !== authOrigin()) ||
        (callback && callback !== destination && callback !== authOrigin() + destination)
      )
        return Response.json({ error: '验证回调无效。' }, { status: 422 });
      url.searchParams.set('callbackURL', authOrigin() + destination);
      request = new Request(url, { headers: request.headers });
    } else {
      const body = await readBody(request);
      if (!body) return Response.json({ error: '请输入有效资料。' }, { status: 422 });
      if (registration || resend || recovery) {
        if (
          typeof body.email !== 'string' ||
          body.email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
        )
          return Response.json({ error: '请输入有效邮箱。' }, { status: 422 });
        if (
          body.callbackURL !== undefined &&
          body.callbackURL !== callbackPath &&
          body.callbackURL !== authOrigin() + callbackPath
        )
          return Response.json({ error: '验证回调无效。' }, { status: 422 });
        if (
          recovery &&
          body.redirectTo !== undefined &&
          body.redirectTo !== resetPath &&
          body.redirectTo !== authOrigin() + resetPath
        )
          return Response.json({ error: '重置回调无效。' }, { status: 422 });
        if (
          registration &&
          (typeof body.name !== 'string' ||
            !body.name.trim() ||
            body.name.length > 80 ||
            typeof body.password !== 'string' ||
            body.password.length < 12 ||
            body.password.length > 128)
        )
          return Response.json(
            { error: '昵称须为 1–80 字，密码须为 12–128 字。' },
            { status: 422 },
          );
        const email = body.email.toLowerCase();
        registrationEmail = email;
        const quota = await consumeQuota(
          `${recovery ? 'recovery' : 'verification'}-email:${email}`,
          { window: 900, max: 3 },
        );
        if (!quota.allowed) return limited(quota.retryAfter);
        request = new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify({
            email,
            ...(registration
              ? { name: (body.name as string).trim(), password: body.password }
              : {}),
            ...(recovery
              ? { redirectTo: authOrigin() + resetPath }
              : { callbackURL: authOrigin() + callbackPath }),
          }),
        });
      } else {
        if (
          reset &&
          (url.search ||
            typeof body.token !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(body.token) ||
            typeof body.newPassword !== 'string' ||
            body.newPassword.length < 12 ||
            body.newPassword.length > 128)
        )
          return Response.json({ error: '重置链接或新密码无效。' }, { status: 422 });
        request = new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(body),
        });
      }
    }
    const response = await getAuth().handler(request);
    if (registration && response.ok) {
      const sent = await getAuth().handler(
        new Request(authOrigin() + '/api/auth/send-verification-email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: authOrigin(),
            Host: new URL(authOrigin()).host,
          },
          body: JSON.stringify({
            email: registrationEmail,
            callbackURL: authOrigin() + callbackPath,
          }),
        }),
      );
      if (sent.status >= 500)
        return Response.json(
          { error: '注册服务暂时不可用，请稍后重发验证邮件。' },
          { status: 503 },
        );
    }
    if (response.status >= 500)
      return Response.json({ error: '认证服务暂时不可用，请稍后重试。' }, { status: 503 });
    if ((registration || resend || recovery) && response.ok) return Response.json({ status: true });
    response.headers.set('Cache-Control', 'no-store');
    const retryAfter = response.headers.get('X-Retry-After');
    if (response.status === 429 && retryAfter) response.headers.set('Retry-After', retryAfter);
    return response;
  } catch {
    return Response.json({ error: '登录服务暂时不可用，请稍后重试。' }, { status: 503 });
  }
}
export { handle as GET, handle as POST };
