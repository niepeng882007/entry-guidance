import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.ts';
import type { Delegation } from '../identity/delegation.ts';
import { readReviewIdentity, type Transport } from '../account.ts';
import { sealCredential, type BinanceCredential } from './credential.ts';

export class BindingError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const bindingMetadata = {
  id: true,
  uid: true,
  source: true,
  credentialVersion: true,
  authorizationVersion: true,
} as const;
export async function requireBusinessIdentity(
  database: Pick<PrismaClient, 'session'>,
  claims: Delegation,
  recent = false,
) {
  const session = await database.session.findUnique({
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
    throw new BindingError(401, '请重新登录。');
  if (
    recent &&
    (session.createdAt.getTime() > Date.now() ||
      Date.now() - session.createdAt.getTime() >= 15 * 60000)
  )
    throw new BindingError(403, '请重新登录以确认密码后再修改凭据。');
  return session;
}
export interface BindingSubmission extends BinanceCredential {
  requestId: string;
}
export function bindingSubmission(value: unknown): BindingSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BindingError(422, '请求格式无效。');
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).some((key) => !['apiKey', 'apiSecret', 'requestId'].includes(key)) ||
    typeof fields.apiKey !== 'string' ||
    !/^[A-Za-z0-9_-]{8,256}$/.test(fields.apiKey) ||
    typeof fields.apiSecret !== 'string' ||
    !/^[A-Za-z0-9_-]{8,256}$/.test(fields.apiSecret) ||
    typeof fields.requestId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(fields.requestId)
  )
    throw new BindingError(422, '请提供有效的 Key、Secret 和请求标识。');
  return { apiKey: fields.apiKey, apiSecret: fields.apiSecret, requestId: fields.requestId };
}
export async function saveBinding(options: {
  database: PrismaClient;
  claims: Delegation;
  submission: BindingSubmission;
  master: { key: Buffer; version: number };
  transport?: Transport;
  signal: AbortSignal;
}) {
  const { database, claims, submission, master } = options;
  const digest = createHmac('sha256', master.key)
    .update(JSON.stringify([claims.sub, submission.apiKey, submission.apiSecret]))
    .digest('hex');
  const previous = await database.bindingMutation.findUnique({
    where: { userId_requestId: { userId: claims.sub, requestId: submission.requestId } },
  });
  if (previous) {
    if (previous.digest !== digest) throw new BindingError(409, '此请求标识已用于其他内容。');
    return previous.result;
  }
  const uid = await readReviewIdentity(
    { ...submission, transport: options.transport },
    options.signal,
  );
  try {
    return await database.$transaction(async (tx) => {
      // Serialize this user's changes and recheck authorization after the external read.
      await tx.$queryRaw`SELECT id FROM auth_user WHERE id = ${claims.sub} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM auth_session WHERE id = ${claims.sid} FOR UPDATE`;
      await requireBusinessIdentity(tx, claims, true);
      const replay = await tx.bindingMutation.findUnique({
        where: { userId_requestId: { userId: claims.sub, requestId: submission.requestId } },
      });
      if (replay) {
        if (replay.digest !== digest) throw new BindingError(409, '此请求标识已用于其他内容。');
        return replay.result;
      }
      const current = await tx.binanceBinding.findFirst({
        where: { userId: claims.sub, state: 'active' },
      });
      if (current && current.uid !== uid)
        throw new BindingError(409, '账户不同；请先完成解绑归档再绑定新账户。');
      const id = current?.id ?? randomUUID();
      const version = (current?.credentialVersion ?? 0) + 1;
      const sealedCredential = sealCredential(
        { apiKey: submission.apiKey, apiSecret: submission.apiSecret },
        {
          userId: claims.sub,
          bindingId: id,
          purpose: 'binance',
          version,
          keyVersion: master.version,
        },
        master.key,
      );
      const data = { sealedCredential, credentialVersion: version, keyVersion: master.version };
      const binding = current
        ? await tx.binanceBinding.update({
            where: { id },
            data: { ...data, authorizationVersion: { increment: 1 } },
            select: bindingMetadata,
          })
        : await tx.binanceBinding.create({
            data: { id, userId: claims.sub, uid, ...data },
            select: bindingMetadata,
          });
      await tx.user.update({
        where: { id: claims.sub },
        data: { authorizationVersion: { increment: 1 } },
      });
      const result = { binding };
      await tx.bindingMutation.create({
        data: { userId: claims.sub, requestId: submission.requestId, digest, result },
      });
      return result;
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
      throw new BindingError(409, '此账户无法绑定，请检查当前绑定或联系支持。');
    throw error;
  }
}
