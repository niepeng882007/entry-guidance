import { createPublicKey } from 'node:crypto';
import { createBusinessServer } from './business-server.ts';
import { createIdentityDatabase } from './identity/database.ts';
import { authOrigin, businessOrigin } from './identity/config.ts';

try {
  const origin = new URL(businessOrigin());
  const publicKey = process.env.DELEGATION_PUBLIC_KEY ?? '';
  if (
    createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' })
      .asymmetricKeyType !== 'ed25519'
  )
    throw new Error('Invalid key');
  const database = createIdentityDatabase(process.env.DATABASE_URL ?? '');
  const server = createBusinessServer({
    database,
    authOrigin: authOrigin(),
    businessOrigin: origin.origin,
    publicKey,
  });
  server.on('error', () => {
    console.error('业务服务启动失败。');
    process.exitCode = 1;
  });
  server.listen(
    Number(origin.port || (origin.protocol === 'http:' ? 80 : 443)),
    process.env.BUSINESS_HOST ?? '127.0.0.1',
  );
  const close = () => {
    server.close(() => {
      void database.$disconnect().then(() => process.exit());
    });
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} catch {
  console.error('业务服务配置无效。');
  process.exitCode = 1;
}
