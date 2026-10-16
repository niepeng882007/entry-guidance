import type { PrismaClient, Prisma } from '../generated/prisma/client.ts';
import type { Delegation } from '../identity/delegation.ts';
import type { createBoundAccountReader } from './account.ts';
import { BindingError, requireBusinessIdentity } from './binding.ts';
import { createPlan, verifyPosition, type Plan, type Verification } from '../verification.ts';
import { randomUUID } from 'node:crypto';
import { readMarket, readSymbols } from '../market.ts';
import { AccountError } from '../account.ts';
import type { EntryInput } from '../../public/draft.js';

export interface SavedEntryPlan {
  userId: string;
  binding: {
    id: string;
    uid: string;
    source: string;
    credentialVersion: number;
    authorizationVersion: number;
  };
  input: EntryInput;
  plan: Plan;
}
export interface CheckedEntryPlan extends SavedEntryPlan {
  verification: Verification;
}
function requireFreshPlan(plan: Plan) {
  if (
    [plan.accountTime, plan.bookTime, plan.markTime].some(
      (value) =>
        !Number.isFinite(Date.parse(value)) || Math.abs(Date.now() - Date.parse(value)) >= 30000,
    )
  )
    throw new AccountError('stale_market', '生成期间账户或行情数据已过期，请重新生成。', 409);
}
export function createBoundEntryService(
  database: PrismaClient,
  accounts: ReturnType<typeof createBoundAccountReader>,
  simulation = false,
) {
  async function restore(claims: Delegation, id: string): Promise<SavedEntryPlan> {
    await requireBusinessIdentity(database, claims);
    const saved = await database.entryPlan.findFirst({
      where: {
        id,
        userId: claims.sub,
        trustedCurrent: true,
        binding: { userId: claims.sub, state: 'active' },
      },
      include: { binding: true },
    });
    await requireBusinessIdentity(database, claims);
    if (!saved) throw new BindingError(404, '未找到此账户的可信本单。');
    const owner = saved.owner as unknown as SavedEntryPlan['binding'];
    const plan = saved.plan as unknown as Plan;
    const binding = saved.binding;
    if (
      owner.id !== binding.id ||
      owner.uid !== binding.uid ||
      owner.source !== binding.source ||
      plan.reviewAccountId !== binding.uid ||
      saved.source !== (simulation ? 'demo' : 'binance') ||
      plan.source !== saved.source ||
      plan.id !== saved.id ||
      !['MARKET', 'LIMIT'].includes(plan.execution.entryType) ||
      (plan.execution.entryType === 'LIMIT' && plan.execution.timeInForce !== 'GTC')
    )
      throw new BindingError(409, '原方案归属或来源不一致，不能恢复本单。');
    return {
      userId: claims.sub,
      binding: {
        id: binding.id,
        uid: binding.uid,
        source: binding.source,
        credentialVersion: binding.credentialVersion,
        authorizationVersion: binding.authorizationVersion,
      },
      input: saved.input as unknown as EntryInput,
      plan,
    };
  }
  async function saveWithinBinding<T>(
    claims: Delegation,
    owner: SavedEntryPlan['binding'],
    signal: AbortSignal,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM auth_user WHERE id = ${claims.sub} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM auth_session WHERE id = ${claims.sid} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM binance_binding WHERE id = ${owner.id} FOR UPDATE`;
      await requireBusinessIdentity(tx, claims);
      const current = await tx.binanceBinding.findUnique({ where: { id: owner.id } });
      if (
        !current ||
        current.userId !== claims.sub ||
        current.state !== 'active' ||
        current.uid !== owner.uid ||
        current.source !== owner.source ||
        current.credentialVersion !== owner.credentialVersion ||
        current.authorizationVersion !== owner.authorizationVersion
      )
        throw new BindingError(401, '账户连接已变化，未保存本次结果。');
      signal.throwIfAborted();
      return write(tx);
    });
  }
  return {
    async verify(
      claims: Delegation,
      id: string,
      body: unknown,
      signal: AbortSignal,
    ): Promise<CheckedEntryPlan> {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw new BindingError(400, '核验仅接受原方案标识，不能修改本单参数。');
      const saved = await restore(claims, id);
      return accounts.strict(claims, signal, async (config, binding) => {
        if (
          saved.binding.id !== binding.id ||
          saved.binding.uid !== binding.uid ||
          saved.binding.credentialVersion !== binding.credentialVersion ||
          saved.binding.authorizationVersion !== binding.authorizationVersion
        )
          throw new BindingError(401, '账户连接已变化，请重新恢复本单。');
        // The injected demo transport exercises real parsing; its snapshots use the Binance shape.
        const verification = await verifyPosition(
          config,
          simulation ? { ...saved.plan, source: 'binance' } : saved.plan,
        );
        if (simulation) verification.source = 'demo';
        await saveWithinBinding(claims, saved.binding, signal, async (tx) => {
          await tx.entryVerification.create({
            data: {
              id: randomUUID(),
              planId: id,
              owner: saved.binding,
              result: verification as unknown as Prisma.InputJsonValue,
            },
          });
        });
        return { ...saved, verification: { ...verification, reviewRetention: 'saved' } };
      });
    },
    async read(claims: Delegation, resource: string, symbol: string | null, signal: AbortSignal) {
      if (resource.startsWith('plans/')) {
        return restore(claims, resource.slice(6));
      }
      return accounts.strict(claims, signal, async (config, binding) => {
        const data =
          resource === 'symbols'
            ? await readSymbols(config)
            : await readMarket(config, symbol ?? '', signal);
        return {
          ...data,
          source: simulation ? 'demo' : data.source,
          userId: claims.sub,
          binding: {
            id: binding.id,
            uid: binding.uid,
            source: binding.source,
            credentialVersion: binding.credentialVersion,
            authorizationVersion: binding.authorizationVersion,
          },
        };
      });
    },
    async generate(claims: Delegation, input: unknown, signal: AbortSignal) {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new BindingError(400, '计划输入无效。');
      const fields = input as Record<string, unknown>;
      if (fields.entryType !== undefined && !['MARKET', 'LIMIT'].includes(String(fields.entryType)))
        throw new BindingError(400, '当前仅支持市价或 GTC 限价开仓。');
      return accounts.strict(claims, signal, async (config, binding) => {
        const plan = await createPlan(config, input);
        if (plan.reviewAccountId !== binding.uid)
          throw new BindingError(409, '账户身份与绑定不一致，未保存方案。');
        if (simulation) {
          plan.source = 'demo';
          plan.status = 'simulation';
          plan.notice = '模拟开仓卡 · 不可用于真实交易。';
        }
        const owner = {
          id: binding.id,
          uid: binding.uid,
          source: binding.source,
          credentialVersion: binding.credentialVersion,
          authorizationVersion: binding.authorizationVersion,
        };
        const result: SavedEntryPlan = {
          userId: claims.sub,
          binding: owner,
          input: input as EntryInput,
          plan,
        };
        await saveWithinBinding(claims, owner, signal, async (tx) => {
          requireFreshPlan(plan);
          await tx.entryPlan.create({
            data: {
              id: plan.id,
              trustedCurrent: true,
              bindingId: binding.id,
              userId: claims.sub,
              source: plan.source,
              input: result.input as unknown as Prisma.InputJsonValue,
              plan: plan as unknown as Prisma.InputJsonValue,
              owner,
            },
          });
        });
        requireFreshPlan(plan);
        return result;
      });
    },
  };
}
