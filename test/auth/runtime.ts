import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createBusinessServer } from '../../src/business-server.ts';
import type { Transport } from '../../src/account.ts';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { createIdentityDatabase } from '../../src/identity/database.ts';

const exec = promisify(execFile);
export const users = [
  {
    id: 'synthetic-alice',
    name: '合成用户甲',
    email: 'alice@example.test',
    password: 'synthetic-login-only-01',
  },
  {
    id: 'synthetic-bob',
    name: '合成用户乙',
    email: 'bob@example.test',
    password: 'synthetic-login-only-01',
  },
];
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取测试端口。');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}
export async function startAuthRuntime(
  ports: { web?: number; business?: number; mail?: number; transport?: Transport } = {},
) {
  const mail = {
    messages: [] as { email: string; url: string }[],
    mode: 'accept' as 'accept' | 'fail' | 'timeout',
  };
  const mailServer = createHttpServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/messages') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(mail.messages));
        return;
      }
      let text = '';
      for await (const chunk of request) text += String(chunk);
      if (request.method === 'POST' && request.url === '/mode') {
        const body = JSON.parse(text) as { mode: typeof mail.mode };
        mail.mode = body.mode;
        response.end('{}');
        return;
      }
      if (request.method !== 'POST' || request.url !== '/send') {
        response.writeHead(404).end();
        return;
      }
      if (mail.mode === 'timeout') return;
      if (mail.mode === 'fail') {
        response.writeHead(503).end();
        return;
      }
      mail.messages.push(JSON.parse(text) as { email: string; url: string });
      response.end('{}');
    })().catch(() => response.writeHead(400).end());
  });
  await new Promise<void>((resolve) => mailServer.listen(ports.mail ?? 0, '127.0.0.1', resolve));
  const mailAddress = mailServer.address();
  if (!mailAddress || typeof mailAddress === 'string') throw new Error('邮件夹具启动失败。');
  const mailOrigin = `http://127.0.0.1:${mailAddress.port}`;
  const container = `entry-auth-${randomUUID()}`;
  const webOrigin = `http://127.0.0.1:${ports.web ?? (await freePort())}`;
  const businessOrigin = `http://127.0.0.1:${ports.business ?? (await freePort())}`;
  const keys = generateKeyPairSync('ed25519');
  let web: ChildProcess | undefined;
  let business: ChildProcess | undefined;
  let businessServer: Server | undefined;
  const credentialMaster = { key: randomBytes(32), version: 1 };
  const replicas: ChildProcess[] = [];
  let database: ReturnType<typeof createIdentityDatabase> | undefined;
  let created = false;
  let serving = false;
  let interrupted = false;
  let closing: Promise<void> | undefined;
  const terminate = () => {
    interrupted = true;
    if (serving) void close().then(() => process.exit());
  };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  function checkStartup() {
    if (interrupted) throw new Error('合成服务启动已取消。');
  }
  function close(): Promise<void> {
    return (closing ??= (async () => {
      try {
        await stop(web);
        for (const replica of replicas) await stop(replica);
        mailServer.closeAllConnections();
        await new Promise<void>((resolve) => mailServer.close(() => resolve()));
        await stop(business);
        if (businessServer)
          await new Promise<void>((resolve, reject) =>
            businessServer!.close((error) => (error ? reject(error) : resolve())),
          );
        await database?.$disconnect();
        // Also try the known name if Docker was interrupted just after creating it.
        if (created) await exec('docker', ['stop', '-t', '1', container]);
        else await exec('docker', ['stop', '-t', '1', container]).catch(() => undefined);
      } finally {
        process.off('SIGTERM', terminate);
        process.off('SIGINT', terminate);
      }
    })());
  }
  try {
    await exec('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '--label',
      `entry-guidance.fixture-owner=${process.pid}`,
      '-p',
      '127.0.0.1::5432',
      '-e',
      'POSTGRES_USER=synthetic',
      '-e',
      'POSTGRES_PASSWORD=synthetic-database-only',
      '-e',
      'POSTGRES_DB=entry_auth_test',
      'postgres:17',
    ]);
    created = true;
    checkStartup();
    const { stdout } = await exec('docker', ['port', container, '5432/tcp']);
    const port = stdout.trim().split(':').at(-1);
    const databaseUrl = `postgresql://synthetic:synthetic-database-only@127.0.0.1:${port}/entry_auth_test`;
    database = createIdentityDatabase(databaseUrl);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      checkStartup();
      try {
        await database.$queryRaw`SELECT 1`;
        ready = true;
        break;
      } catch {
        await setTimeout(250);
      }
    }
    if (!ready) throw new Error('合成 PostgreSQL 启动超时。');
    const common = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'production',
      APP_ENV: 'test',
      AUTH_MAIL_FAKE_ORIGIN: mailOrigin,
      NEXT_TELEMETRY_DISABLED: '1',
      CHECKPOINT_DISABLE: '1',
      DATABASE_URL: databaseUrl,
      AUTH_ORIGIN: webOrigin,
      BUSINESS_ORIGIN: businessOrigin,
    };
    await exec(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: common,
    });
    checkStartup();
    for (const user of users) {
      checkStartup();
      await database.user.create({
        data: {
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: true,
          accounts: {
            create: {
              id: randomUUID(),
              accountId: user.id,
              providerId: 'credential',
              password: await hashPassword(user.password),
            },
          },
        },
      });
    }
    checkStartup();
    if (ports.transport) {
      businessServer = createBusinessServer({
        database,
        authOrigin: webOrigin,
        businessOrigin,
        publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        credentialMaster,
        transport: ports.transport,
      });
      await new Promise<void>((resolve) =>
        businessServer!.listen(Number(new URL(businessOrigin).port), '127.0.0.1', resolve),
      );
    } else
      business = spawn(process.execPath, ['src/business-main.ts'], {
        env: {
          ...common,
          CREDENTIAL_MASTER_KEY: credentialMaster.key.toString('base64'),
          CREDENTIAL_MASTER_KEY_VERSION: String(credentialMaster.version),
          DELEGATION_PUBLIC_KEY: keys.publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64'),
        },
        stdio: 'ignore',
      });
    const webEnvironment = {
      ...common,
      AUTH_SECRET: randomUUID() + randomUUID(),
      DELEGATION_PRIVATE_KEY: keys.privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .toString('base64'),
    };
    web = spawn(
      process.execPath,
      [
        'node_modules/next/dist/bin/next',
        'start',
        'web',
        '--hostname',
        '127.0.0.1',
        '--port',
        new URL(webOrigin).port,
      ],
      {
        env: webEnvironment,
        stdio: 'ignore',
      },
    );
    ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      checkStartup();
      if (web.exitCode !== null || (business && business.exitCode !== null))
        throw new Error('合成服务未能启动；请先完成生产构建。');
      try {
        const response = await fetch(`${webOrigin}/login`);
        const protectedResponse = await fetch(`${businessOrigin}/v1/users/${users[0]!.id}/profile`);
        if (response.ok && protectedResponse.status === 401) {
          ready = true;
          break;
        }
      } catch {
        /* Services are still starting. */
      }
      await setTimeout(250);
    }
    if (!ready) throw new Error('合成服务启动超时。');
    checkStartup();
    serving = true;
    return {
      webOrigin,
      businessOrigin,
      database,
      keys,
      credentialMaster,
      close,
      container,
      mail,
      mailOrigin,
      async expiredVerificationURL(email: string) {
        const token = await createEmailVerificationToken(
          webEnvironment.AUTH_SECRET,
          email,
          undefined,
          -1,
        );
        return `${webOrigin}/api/auth/verify-email?token=${token}`;
      },
      async startReplica(environment: Record<string, string> = {}) {
        const port = await freePort();
        const origin = `http://127.0.0.1:${port}`;
        const replica = spawn(
          process.execPath,
          [
            'node_modules/next/dist/bin/next',
            'start',
            'web',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
          ],
          { env: { ...webEnvironment, AUTH_ORIGIN: origin, ...environment }, stdio: 'ignore' },
        );
        replicas.push(replica);
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if ((await fetch(origin + '/login')).ok) return origin;
          } catch {
            /* Starting. */
          }
          await setTimeout(250);
        }
        throw new Error('第二个网页实例启动失败。');
      },
    };
  } catch (error) {
    await close();
    if (interrupted) process.exit(0);
    throw error;
  }
}
