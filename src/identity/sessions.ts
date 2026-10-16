import { currentIdentity, getAuth } from './auth.ts';
import { getIdentityDatabase } from './database.ts';
import { consumeQuota } from './rate-limit.ts';

export async function manageSessions(request: Request, body?: Record<string, unknown> | null) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  const identity = await currentIdentity(request.headers, headers);
  if (!identity) return Response.json({ error: '请重新登录。' }, { status: 401 });
  const writing = request.method === 'POST';
  const expected = writing ? body?.expectedUserId : request.headers.get('X-Workbench-User');
  if ((writing || expected) && expected !== identity.user.id)
    return Response.json({ error: '登录身份已变化，请重新登录。' }, { status: 401 });
  const quota = await consumeQuota(`sessions:${identity.user.id}`, { window: 60, max: 30 });
  if (!quota.allowed)
    return Response.json(
      { error: '尝试过于频繁，请稍后重试。' },
      {
        status: 429,
        headers: { 'Retry-After': String(quota.retryAfter) },
      },
    );
  const database = getIdentityDatabase();
  if (!writing) {
    const sessions = await database.session.findMany({
      where: { userId: identity.user.id, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true, createdAt: true, expiresAt: true, userAgent: true },
    });
    return Response.json(
      {
        sessions: sessions.map((session) => ({
          ...session,
          current: session.id === identity.session.id,
        })),
      },
      { headers },
    );
  }
  if (Date.now() - new Date(identity.session.createdAt).getTime() >= 15 * 60 * 1000)
    return Response.json({ error: '请重新登录以确认密码后再撤销会话。' }, { status: 403 });
  const single = new URL(request.url).pathname.endsWith('/revoke-session');
  let token: string | undefined;
  if (single) {
    if (
      typeof body?.sessionId !== 'string' ||
      body.sessionId.length > 128 ||
      body.sessionId === identity.session.id
    )
      return Response.json({ error: '请选择其他设备的会话。' }, { status: 422 });
    const target = await database.session.findFirst({
      where: { id: body.sessionId, userId: identity.user.id },
      select: { token: true },
    });
    if (!target) return Response.json({ error: '会话不存在或已撤销。' }, { status: 404 });
    token = target.token;
  }
  // Keep bearer session tokens on the server; Better Auth performs the actual revocation.
  const response = await getAuth().handler(
    new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(single ? { token } : {}),
    }),
  );
  if (!response.ok)
    return Response.json(
      { error: response.status === 401 ? '请重新登录。' : '会话服务暂时不可用，请重试。' },
      { status: response.status === 401 ? 401 : 503 },
    );
  return Response.json({ status: true }, { headers });
}
