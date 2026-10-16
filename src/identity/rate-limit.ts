import { createHmac, randomUUID } from 'node:crypto';
import { getIdentityDatabase } from './database.ts';

// A single PostgreSQL upsert decides and consumes each quota across all instances.
export async function consumeQuota(key: string, rule: { window: number; max: number }) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('认证配置无效。');
  const digest = createHmac('sha256', secret).update(key).digest('hex');
  const windowMs = rule.window * 1000;
  const rows = await getIdentityDatabase().$queryRaw<{ count: number; retryAfter: number }[]>`
    INSERT INTO auth_rate_limit (id, key, count, "lastRequest")
    VALUES (${randomUUID()}, ${digest}, 1, (EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN auth_rate_limit."lastRequest" <= (EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint - ${windowMs}
        THEN 1 ELSE LEAST(auth_rate_limit.count + 1, ${rule.max + 1}) END,
      "lastRequest" = CASE WHEN auth_rate_limit."lastRequest" <= (EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint - ${windowMs}
        THEN (EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint ELSE auth_rate_limit."lastRequest" END
    RETURNING count, GREATEST(1, CEIL(("lastRequest" + ${windowMs} - EXTRACT(EPOCH FROM statement_timestamp()) * 1000) / 1000))::int AS "retryAfter"
  `;
  const row = rows[0];
  if (!row) throw new Error('认证配额不可用。');
  return {
    allowed: row.count <= rule.max,
    retryAfter: row.count <= rule.max ? null : row.retryAfter,
  };
}
