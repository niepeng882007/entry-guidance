import type { PrismaClient } from '../generated/prisma/client.ts';
import type { Delegation } from '../identity/delegation.ts';
import {
  AccountError,
  accountAssetDetails,
  readAccountData,
  binanceTransport,
  signBinanceRequest,
  type Transport,
} from '../account.ts';
import type { createBinanceEgress } from '../binance-egress.ts';
import { readAccountPositions } from '../positions.ts';
import { readAccountOrders, readAccountConditionalOrders } from '../orders.ts';
import { coordinateAccountReads, SharedRead } from '../account-refresh.ts';
import { openCredential } from './credential.ts';
import { BindingError, requireBusinessIdentity } from './binding.ts';

export type AccountResource = 'summary' | 'assets' | 'positions' | 'orders' | 'conditional-orders';

export function createBoundAccountReader(options: {
  database: PrismaClient;
  master: () => { key: Buffer; version: number };
  transport?: Transport;
  egress: ReturnType<typeof createBinanceEgress>;
}) {
  const { database } = options;
  const entries = new Map<string, ReturnType<typeof createEntry>>();
  function createEntry(binding: Awaited<ReturnType<typeof currentBinding>>, userVersion: number) {
    const master = options.master();
    if (master.version !== binding.keyVersion) throw new Error('凭据主密钥版本不可用。');
    const credential = openCredential(
      binding.sealedCredential,
      {
        userId: binding.userId,
        bindingId: binding.id,
        purpose: 'binance',
        version: binding.credentialVersion,
        keyVersion: binding.keyVersion,
      },
      master.key,
    );
    const readers = new Map<string, number>();
    const transport: Transport = (url, headers, signal, priority = 'foreground') =>
      options.egress.run(url, signal, priority, async (bounded) => {
        const current = await database.binanceBinding.findUnique({
          where: { id: binding.id },
          include: { user: true },
        });
        if (
          !current ||
          current.state !== 'active' ||
          current.userId !== binding.userId ||
          current.credentialVersion !== binding.credentialVersion ||
          current.authorizationVersion !== binding.authorizationVersion ||
          current.user.disabled ||
          !current.user.emailVerified ||
          current.user.authorizationVersion !== userVersion
        )
          throw new BindingError(401, '账户连接已变化，请重新查询。');
        const session = await database.session.findFirst({
          where: {
            id: { in: [...readers.keys()] },
            userId: binding.userId,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (!session) throw new BindingError(401, '请重新登录。');
        bounded.throwIfAborted();
        if (url.searchParams.has('signature')) signBinanceRequest(credential, url);
        return (options.transport ?? binanceTransport)(url, headers, bounded, priority);
      });
    const coordinator = coordinateAccountReads({ ...credential, transport });
    const data = new SharedRead(
      (signal) => readAccountData(coordinator.config, signal),
      2900,
      true,
    );
    const assets = new SharedRead(
      async (signal) => {
        const result = await data.read(signal);
        return {
          ...result.value.snapshot,
          ...accountAssetDetails(result.value.asset),
          attemptedAt: result.attemptedAt,
          reused: result.reused,
        };
      },
      2900,
      true,
    );
    const positions = new SharedRead(
      (signal) => readAccountPositions(coordinator.config, signal),
      2900,
      true,
    );
    const orders = new SharedRead(
      (signal) => readAccountOrders(coordinator.config, signal),
      2900,
      true,
    );
    const conditional = new SharedRead(
      (signal) => readAccountConditionalOrders(coordinator.config, signal),
      2900,
      true,
    );
    const slots = [data, assets, positions, orders, conditional];
    return {
      binding,
      userVersion,
      readers,
      coordinator,
      data,
      assets,
      positions,
      orders,
      conditional,
      usedAt: Date.now(),
      generation: 0,
      stop() {
        slots.forEach((slot) => slot.stop());
        coordinator.stop();
      },
      invalidate() {
        this.generation++;
        slots.forEach((slot) => slot.clear());
      },
    };
  }
  async function currentBinding(userId: string) {
    const binding = await database.binanceBinding.findFirst({
      where: { userId, state: 'active', source: 'binance-live' },
    });
    if (!binding) throw new BindingError(409, '请先连接只读 Binance 账户。');
    return binding;
  }
  return {
    async read(
      claims: Delegation,
      resource: AccountResource,
      automatic: boolean,
      signal: AbortSignal,
    ) {
      await requireBusinessIdentity(database, claims);
      const binding = await currentBinding(claims.sub);
      for (const [key, entry] of entries) {
        if (
          entry.usedAt < Date.now() - 60_000 ||
          (key === claims.sub &&
            (entry.binding.id !== binding.id ||
              entry.binding.credentialVersion !== binding.credentialVersion ||
              entry.binding.authorizationVersion !== binding.authorizationVersion ||
              entry.userVersion !== claims.version))
        ) {
          entry.stop();
          entries.delete(key);
        }
      }
      let entry = entries.get(claims.sub);
      if (!entry) {
        entry = createEntry(binding, claims.version);
        entries.set(claims.sub, entry);
      }
      entry.usedAt = Date.now();
      entry.readers.set(claims.sid, (entry.readers.get(claims.sid) ?? 0) + 1);
      const generation = entry.generation;
      try {
        await options.egress.check();
        entry.coordinator.check();
        const lifetime = automatic ? 30_000 : 2900;
        const result =
          resource === 'summary'
            ? await entry.data.read(signal)
            : await entry[resource === 'conditional-orders' ? 'conditional' : resource].read(
                signal,
                lifetime,
              );
        signal.throwIfAborted();
        await requireBusinessIdentity(database, claims);
        const current = await currentBinding(claims.sub);
        if (
          current.id !== binding.id ||
          current.credentialVersion !== binding.credentialVersion ||
          current.authorizationVersion !== binding.authorizationVersion
        )
          throw new BindingError(401, '账户连接已变化，请重新查询。');
        if (entry.generation !== generation) {
          const error = new AccountError('scope_unconfirmed', '账户口径或权限未确认，请重新查询。');
          error.scopeConfirmed = false;
          throw error;
        }
        const value = 'snapshot' in result.value ? result.value.snapshot : result.value;
        return {
          ...value,
          userId: claims.sub,
          binding: {
            id: binding.id,
            uid: binding.uid,
            source: binding.source,
            credentialVersion: binding.credentialVersion,
            authorizationVersion: binding.authorizationVersion,
          },
          attemptedAt: 'attemptedAt' in value ? value.attemptedAt : result.attemptedAt,
          reused: result.reused || ('reused' in value && value.reused === true),
        };
      } catch (error) {
        await requireBusinessIdentity(database, claims);
        if (error instanceof AccountError && error.scopeConfirmed === false) entry.invalidate();
        throw error;
      } finally {
        const remaining = (entry.readers.get(claims.sid) ?? 1) - 1;
        if (remaining) entry.readers.set(claims.sid, remaining);
        else entry.readers.delete(claims.sid);
      }
    },
    stop() {
      for (const entry of entries.values()) entry.stop();
      entries.clear();
    },
  };
}
