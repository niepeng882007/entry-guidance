import type { PrismaClient, Prisma } from '../generated/prisma/client.ts';
import type { Delegation } from '../identity/delegation.ts';
import type { createBoundAccountReader } from './account.ts';
import { BindingError, requireBusinessIdentity } from './binding.ts';
import { createPlan, type Plan } from '../verification.ts';
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
  return {
    async read(claims: Delegation, resource: string, symbol: string | null, signal: AbortSignal) {
      if (resource.startsWith('plans/')) {
        await requireBusinessIdentity(database, claims);
        const saved = await database.entryPlan.findFirst({
          where: {
            id: resource.slice(6),
            userId: claims.sub,
            binding: { userId: claims.sub, state: 'active' },
          },
        });
        await requireBusinessIdentity(database, claims);
        if (!saved) throw new BindingError(404, '未找到此账户的方案。');
        return { userId: claims.sub, binding: saved.owner, input: saved.input, plan: saved.plan };
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
      if (
        (fields.entryType !== undefined && fields.entryType !== 'MARKET') ||
        (fields.stopLevels !== undefined && fields.stopLevels !== 'single') ||
        ['limitPrice', 'nearStop', 'nearStopMode', 'nearPercent'].some((key) => key in fields)
      )
        throw new BindingError(400, '当前仅支持单层市价开仓。');
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
        await database.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM auth_user WHERE id = ${claims.sub} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM auth_session WHERE id = ${claims.sid} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM binance_binding WHERE id = ${binding.id} FOR UPDATE`;
          await requireBusinessIdentity(tx, claims);
          const current = await tx.binanceBinding.findUnique({ where: { id: binding.id } });
          if (
            !current ||
            current.userId !== claims.sub ||
            current.state !== 'active' ||
            current.credentialVersion !== binding.credentialVersion ||
            current.authorizationVersion !== binding.authorizationVersion
          )
            throw new BindingError(401, '账户连接已变化，未保存新方案。');
          signal.throwIfAborted();
          requireFreshPlan(plan);
          await tx.entryPlan.create({
            data: {
              id: plan.id,
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
