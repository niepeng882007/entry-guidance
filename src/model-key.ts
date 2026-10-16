import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client.ts';
import type { Delegation } from './identity/delegation.ts';
import { BindingError, requireBusinessIdentity } from './bindings/binding.ts';
import { sealModelCredential } from './bindings/credential.ts';
import { modelCapacity } from './analysis-model.ts';

export const modelCredentialMetadata = {
  id: true,
  version: true,
  state: true,
  verifiedAt: true,
  updatedAt: true,
} as const;

export type ModelKeySubmission = { requestId: string } & (
  { action: 'save'; apiKey: string } | { action: 'revoke' }
);
export function modelKeySubmission(value: unknown): ModelKeySubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BindingError(422, '请求格式无效。');
  const fields = value as Record<string, unknown>;
  const allowed =
    fields.action === 'save' ? ['action', 'apiKey', 'requestId'] : ['action', 'requestId'];
  if (
    Object.keys(fields).some((key) => !allowed.includes(key)) ||
    !['save', 'revoke'].includes(String(fields.action)) ||
    (fields.action === 'save' &&
      (typeof fields.apiKey !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(fields.apiKey))) ||
    typeof fields.requestId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fields.requestId)
  )
    throw new BindingError(422, '请提供有效的模型 Key 和请求标识。');
  return fields.action === 'save'
    ? { action: 'save', apiKey: fields.apiKey as string, requestId: fields.requestId }
    : { action: 'revoke', requestId: fields.requestId };
}
export async function changeModelKey(options: {
  database: PrismaClient;
  claims: Delegation;
  submission: ModelKeySubmission;
  master: () => { key: Buffer; version: number };
  transport?: typeof fetch;
  signal: AbortSignal;
}) {
  const { database, claims, submission } = options;
  const master = submission.action === 'save' ? options.master() : null;
  await requireBusinessIdentity(database, claims, true);
  const digest =
    submission.action === 'save' && master
      ? createHmac('sha256', master.key)
          .update(JSON.stringify([claims.sub, submission.action, submission.apiKey]))
          .digest('hex')
      : 'revoke';
  const mutationId = { userId_requestId: { userId: claims.sub, requestId: submission.requestId } };
  const previous = await database.modelKeyMutation.findUnique({ where: mutationId });
  if (previous) {
    if (previous.digest !== digest) throw new BindingError(409, '此请求标识已用于其他内容。');
    return {
      credential: await database.modelCredential.findUnique({
        where: { userId: claims.sub },
        select: modelCredentialMetadata,
      }),
    };
  }
  if (submission.action === 'save') {
    try {
      await modelCapacity(
        {
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          effort: 'high',
          apiKey: submission.apiKey,
          transport: options.transport,
        },
        options.signal,
      );
    } catch {
      await requireBusinessIdentity(database, claims, true);
      throw new BindingError(503, '无法验证模型 Key 或模型容量；原有设置已保留，未发起分析。');
    }
  }
  return database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM auth_user WHERE id = ${claims.sub} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM auth_session WHERE id = ${claims.sid} FOR UPDATE`;
    await requireBusinessIdentity(tx, claims, true);
    options.signal.throwIfAborted();
    const replay = await tx.modelKeyMutation.findUnique({ where: mutationId });
    if (replay && replay.digest !== digest)
      throw new BindingError(409, '此请求标识已用于其他内容。');
    const current = await tx.modelCredential.findUnique({
      where: { userId: claims.sub },
      select: modelCredentialMetadata,
    });
    if (replay) return { credential: current };
    let credential = current;
    if (submission.action === 'save' || current?.state === 'active') {
      const id = current?.id ?? randomUUID();
      const version = (current?.version ?? 0) + 1;
      const data =
        submission.action === 'save' && master
          ? {
              version,
              state: 'active',
              keyVersion: master.version,
              verifiedAt: new Date(),
              sealedCredential: sealModelCredential(
                { apiKey: submission.apiKey },
                {
                  userId: claims.sub,
                  bindingId: id,
                  purpose: 'model',
                  version,
                  keyVersion: master.version,
                },
                master.key,
              ),
            }
          : { version, state: 'revoked', sealedCredential: null, keyVersion: null };
      credential = await tx.modelCredential.upsert({
        where: { userId: claims.sub },
        create: { userId: claims.sub, id, ...data },
        update: data,
        select: modelCredentialMetadata,
      });
      if (current?.state === 'active') {
        // shortcut: records share the business DB; tickets 24/25 add independent recovery control.
        await tx.modelKeyInvalidation.create({
          data: {
            userId: claims.sub,
            credentialId: id,
            version: current.version,
            reason: submission.action === 'save' ? 'replaced' : 'revoked',
          },
        });
      }
      await tx.user.update({
        where: { id: claims.sub },
        data: { authorizationVersion: { increment: 1 } },
      });
    }
    await tx.modelKeyMutation.create({
      data: { userId: claims.sub, requestId: submission.requestId, digest },
    });
    return { credential };
  });
}
