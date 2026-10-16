export class BusinessRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
interface CredentialSubmission {
  apiKey: string;
  apiSecret: string;
  requestId: string;
}
export function businessRequest(resource: 'profile', signal: AbortSignal): Promise<Response>;
export function businessRequest(
  resource: 'binding',
  signal: AbortSignal,
  expectedUserId: string,
  submission?: CredentialSubmission,
): Promise<Response>;
export async function businessRequest(
  resource: 'profile' | 'binding',
  signal: AbortSignal,
  expectedUserId?: string,
  submission?: CredentialSubmission,
): Promise<Response> {
  const grant = await fetch('/api/delegation', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: `${resource}:${submission ? 'write' : 'read'}` }),
  });
  if (!grant.ok)
    throw new BusinessRequestError(
      grant.status,
      grant.status === 403
        ? '请重新登录以确认密码后再修改凭据。'
        : '认证服务暂时不可用，请稍后重试。',
    );
  const delegation: { token: string; userId: string; businessOrigin: string } = await grant.json();
  if (resource === 'binding' && delegation.userId !== expectedUserId)
    throw new BusinessRequestError(401, '登录身份已变化，请重新登录。');
  const response = await fetch(
    `${delegation.businessOrigin}/v1/users/${encodeURIComponent(delegation.userId)}/${resource}`,
    {
      method: submission ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${delegation.token}`,
        ...(submission ? { 'Content-Type': 'application/json' } : {}),
      },
      body: submission ? JSON.stringify(submission) : undefined,
      credentials: 'omit',
      signal,
      cache: 'no-store',
      redirect: 'error',
    },
  );
  if (!response.ok) {
    const failure: { error?: string } = await response.json();
    throw new BusinessRequestError(response.status, failure.error ?? '业务服务暂时不可用。');
  }
  return response;
}
