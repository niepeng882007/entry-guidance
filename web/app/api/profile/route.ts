import { connection } from 'next/server';
import { currentIdentity } from '../../../../src/identity/auth.ts';
import { authOrigin, businessOrigin, requestAllowed } from '../../../../src/identity/config.ts';
import { issueDelegation } from '../../../../src/identity/delegation.ts';

export async function GET(request: Request) {
  await connection();
  if (!requestAllowed(request))
    return Response.json({ error: '访问来源不受支持。' }, { status: 403 });
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  try {
    const identity = await currentIdentity(request.headers, responseHeaders);
    if (!identity) return Response.json({ error: '请重新登录。' }, { status: 401 });
    const { token } = issueDelegation(identity, authOrigin(), businessOrigin());
    const response = await fetch(
      `${businessOrigin()}/v1/users/${encodeURIComponent(identity.user.id)}/profile`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      },
    );
    if (response.status !== 200)
      return Response.json(
        { error: response.status === 401 ? '请重新登录。' : '资料服务暂时不可用。' },
        { status: response.status === 401 ? 401 : 503, headers: responseHeaders },
      );
    return Response.json(await response.json(), { headers: responseHeaders });
  } catch {
    return Response.json(
      { error: '资料服务暂时不可用，请稍后重试。' },
      { status: 503, headers: responseHeaders },
    );
  }
}
