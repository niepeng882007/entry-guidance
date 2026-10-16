import { currentIdentity } from '../../../../src/identity/auth.ts';
import { authOrigin, businessOrigin, requestAllowed } from '../../../../src/identity/config.ts';
import { issueDelegation } from '../../../../src/identity/delegation.ts';

export async function POST(request: Request) {
  if (!requestAllowed(request))
    return Response.json({ error: '访问来源不受支持。' }, { status: 403 });
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  try {
    const identity = await currentIdentity(request.headers, responseHeaders);
    if (!identity) return Response.json({ error: '请重新登录。' }, { status: 401 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256) {
          await reader.cancel();
          return Response.json({ error: '请求过大。' }, { status: 413 });
        }
        chunks.push(chunk.value);
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return Response.json({ error: '请求格式无效。' }, { status: 422 });
    }
    const scope = body && typeof body === 'object' && 'scope' in body ? body.scope : 'profile:read';
    if (
      scope !== 'profile:read' &&
      scope !== 'binding:read' &&
      scope !== 'binding:write' &&
      scope !== 'account:read' &&
      scope !== 'review:read'
    )
      return Response.json({ error: '操作不受支持。' }, { status: 422 });
    if (
      scope === 'binding:write' &&
      Date.now() - identity.session.createdAt.getTime() >= 15 * 60000
    )
      return Response.json({ error: '请重新登录以确认密码后再修改凭据。' }, { status: 403 });
    return Response.json(
      {
        ...issueDelegation(identity, authOrigin(), businessOrigin(), scope),
        userId: identity.user.id,
        businessOrigin: businessOrigin(),
      },
      { headers: responseHeaders },
    );
  } catch {
    return Response.json(
      { error: '认证服务暂时不可用，请稍后重试。' },
      { status: 503, headers: responseHeaders },
    );
  }
}
