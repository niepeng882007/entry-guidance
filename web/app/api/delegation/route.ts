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
    return Response.json(
      {
        ...issueDelegation(identity, authOrigin(), businessOrigin()),
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
