import type { EntryInput } from '../../../public/draft.js';
import type { Delegation } from '../../../src/identity/delegation.ts';
import type { ModelKeySubmission } from '../../../src/model-key.ts';

export class BusinessRequestError extends Error {
  status: number;
  code?: string;
  retryAt?: string;
  attemptedAt?: string;
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
export async function requestBusinessGrant(
  scope: Delegation['scope'],
  signal: AbortSignal,
  expectedUserId?: string,
) {
  const grant = await fetch('/api/delegation', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  if (!grant.ok)
    throw new BusinessRequestError(
      grant.status,
      grant.status === 403
        ? '请重新登录以确认密码后再修改凭据。'
        : '认证服务暂时不可用，请稍后重试。',
    );
  const delegation: { token: string; userId: string; businessOrigin: string } = await grant.json();
  if (expectedUserId !== undefined && delegation.userId !== expectedUserId)
    throw new BusinessRequestError(401, '登录身份已变化，请重新登录。');
  return delegation;
}
export function businessRequest(
  resource: `entry/${string}`,
  signal: AbortSignal,
  expectedUserId: string,
  input?: EntryInput,
): Promise<Response>;
export function businessRequest(
  resource: `account/${'summary' | 'assets'}`,
  signal: AbortSignal,
  expectedUserId: string,
  automatic?: boolean,
): Promise<Response>;
export function businessRequest(
  resource: `review/${string}/trades${string}`,
  signal: AbortSignal,
  expectedUserId: string,
): Promise<Response>;
export function businessRequest(resource: 'profile', signal: AbortSignal): Promise<Response>;
export function businessRequest(
  resource: 'model',
  signal: AbortSignal,
  expectedUserId: string,
  submission?: ModelKeySubmission,
): Promise<Response>;
export function businessRequest(
  resource: 'binding',
  signal: AbortSignal,
  expectedUserId: string,
  submission?: CredentialSubmission,
): Promise<Response>;
export async function businessRequest(
  resource:
    | 'profile'
    | 'binding'
    | 'model'
    | `account/${'summary' | 'assets'}`
    | `entry/${string}`
    | `review/${string}/trades${string}`,
  signal: AbortSignal,
  expectedUserId?: string,
  submission?: CredentialSubmission | ModelKeySubmission | EntryInput | boolean,
): Promise<Response> {
  const scope =
    resource === 'profile'
      ? 'profile:read'
      : resource === 'binding' || resource === 'model'
        ? submission
          ? (`${resource}:write` as const)
          : (`${resource}:read` as const)
        : resource.startsWith('review/')
          ? 'review:read'
          : resource.startsWith('entry/')
            ? submission
              ? 'entry:write'
              : 'entry:read'
            : 'account:read';
  const delegation = await requestBusinessGrant(scope, signal, expectedUserId);
  const response = await fetch(
    `${delegation.businessOrigin}/v1/users/${encodeURIComponent(delegation.userId)}/${resource}`,
    {
      method: typeof submission === 'object' ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${delegation.token}`,
        ...(typeof submission === 'object' ? { 'Content-Type': 'application/json' } : {}),
        ...(submission === true ? { 'X-Account-Refresh': 'automatic' } : {}),
      },
      body: typeof submission === 'object' ? JSON.stringify(submission) : undefined,
      credentials: 'omit',
      signal,
      cache: 'no-store',
      redirect: 'error',
    },
  );
  if (!response.ok) {
    const failure: { error?: string; code?: string; retryAt?: string; attemptedAt?: string } =
      await response.json();
    const error = new BusinessRequestError(
      response.status,
      failure.error ?? '业务服务暂时不可用。',
    );
    error.code = failure.code;
    error.retryAt = failure.retryAt;
    error.attemptedAt = failure.attemptedAt;
    throw error;
  }
  return response;
}
