import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';

export function createIdentityDatabase(url: string) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('数据库配置无效。');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }), log: [] });
}

const state = globalThis as typeof globalThis & { identityDatabase?: PrismaClient };
export function getIdentityDatabase() {
  return (state.identityDatabase ??= createIdentityDatabase(process.env.DATABASE_URL ?? ''));
}
