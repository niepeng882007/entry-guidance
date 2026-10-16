import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { startAuthRuntime, users } from './runtime.ts';

test('two verified synthetic users read only their own profile through Next and Node', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  for (const user of users.slice(0, 2)) {
    const login = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const profile = await fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie } });
    assert.equal(profile.status, 200);
    assert.deepEqual(await profile.json(), { id: user.id, name: user.name, email: user.email });
    assert.equal(profile.headers.get('cache-control'), 'no-store');
  }
});

test('a disabled user cannot create a new login session', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const user = users[1]!;
  await runtime.database.user.update({ where: { id: user.id }, data: { disabled: true } });
  const response = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  assert.equal(response.status, 403);
});

async function login(runtime: Awaited<ReturnType<typeof startAuthRuntime>>, user = users[0]!) {
  const response = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  assert.equal(response.status, 200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function grant(runtime: Awaited<ReturnType<typeof startAuthRuntime>>, cookie: string) {
  const response = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

test('unauthenticated, unverified, forged, expired and cross-user access are refused', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  assert.equal((await fetch(`${runtime.webOrigin}/api/profile`)).status, 401);
  assert.equal(
    (
      await fetch(`${runtime.webOrigin}/api/delegation`, {
        method: 'POST',
        headers: { Origin: runtime.webOrigin },
      })
    ).status,
    401,
  );
  await runtime.database.user.update({
    where: { id: users[1]!.id },
    data: { emailVerified: false },
  });
  const unverified = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
    body: JSON.stringify({ email: users[1]!.email, password: users[1]!.password }),
  });
  assert.equal(unverified.status, 403);
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie);
  const own = `${runtime.businessOrigin}/v1/users/${users[0]!.id}/profile`;
  const read = (value: string, url = own) =>
    fetch(url, { headers: { Authorization: `Bearer ${value}` } });
  assert.equal((await read(token)).status, 200);
  assert.equal(
    (await read(token, `${runtime.businessOrigin}/v1/users/${users[1]!.id}/profile`)).status,
    403,
  );
  assert.equal((await read(token.slice(0, -5) + 'AAAAA')).status, 401);
  assert.equal((await fetch(`${own}?token=${encodeURIComponent(token)}`)).status, 404);
  const { sign } = await import('node:crypto');
  const [header, payload] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  for (const change of [
    { exp: 1 },
    { aud: 'https://wrong.example' },
    { iss: 'https://wrong.example' },
    { scope: 'admin' },
    { sid: 'other-session' },
    { version: 99 },
  ]) {
    const body = `${header}.${Buffer.from(JSON.stringify({ ...claims, ...change })).toString('base64url')}`;
    const invalid = `${body}.${sign(null, Buffer.from(body), runtime.keys.privateKey).toString('base64url')}`;
    assert.equal((await read(invalid)).status, 401);
  }
  for (const path of ['/api/account', '/api/review', '/entry', '/review']) {
    assert.equal(
      (
        await fetch(`${runtime.businessOrigin}${path}`, {
          headers: { Authorization: `Bearer ${token}`, cookie },
        })
      ).status,
      404,
    );
  }
});

test('logout, current user status, authorization generation and session expiry revoke existing delegation', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const own = `${runtime.businessOrigin}/v1/users/${users[0]!.id}/profile`;
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie);
  const read = () => fetch(own, { headers: { Authorization: `Bearer ${token}` } });
  await runtime.database.user.update({ where: { id: users[0]!.id }, data: { disabled: true } });
  assert.equal((await read()).status, 401);
  assert.equal(
    (await fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie } })).status,
    401,
  );
  await runtime.database.user.update({
    where: { id: users[0]!.id },
    data: { disabled: false, authorizationVersion: 1 },
  });
  assert.equal((await read()).status, 401);
  const newToken = await grant(runtime, cookie);
  assert.equal(
    (await fetch(own, { headers: { Authorization: `Bearer ${newToken}` } })).status,
    200,
  );
  const logout = await fetch(`${runtime.webOrigin}/api/auth/sign-out`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (await fetch(own, { headers: { Authorization: `Bearer ${newToken}` } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie } })).status,
    401,
  );
  const nextCookie = await login(runtime);
  const expiring = await grant(runtime, nextCookie);
  await runtime.database.session.updateMany({
    where: { userId: users[0]!.id },
    data: { expiresAt: new Date(0) },
  });
  assert.equal(
    (await fetch(own, { headers: { Authorization: `Bearer ${expiring}` } })).status,
    401,
  );
});

test('origin protection, private caching and dependency failure preserve the authorization boundary', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie);
  for (const path of ['/api/delegation', '/api/auth/sign-out', '/api/auth/sign-in/email']) {
    const response = await fetch(`${runtime.webOrigin}${path}`, {
      method: 'POST',
      headers: { cookie, Origin: 'https://wrong.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  }
  assert.equal(
    (
      await fetch(`${runtime.webOrigin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    404,
  );
  const own = `${runtime.businessOrigin}/v1/users/${users[0]!.id}/profile`;
  const headers = { Authorization: `Bearer ${token}`, Origin: runtime.webOrigin };
  const allowed = await fetch(own, { headers });
  assert.equal(allowed.headers.get('access-control-allow-origin'), runtime.webOrigin);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  assert.equal(
    (await fetch(own, { headers: { ...headers, Origin: 'https://wrong.example' } })).status,
    403,
  );
  const { request } = await import('node:http');
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const call = request(own, { headers: { ...headers, Host: 'wrong.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    call.on('error', reject);
    call.end();
  });
  assert.equal(wrongHost, 403);
  const page = await fetch(`${runtime.webOrigin}/login`);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self' 'nonce-/);
  assert.doesNotMatch(page.headers.get('content-security-policy')!, /unsafe-inline|unsafe-eval/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('x-robots-tag')!, /noindex/);
  await runtime.database.$executeRaw`ALTER TABLE auth_session RENAME TO unavailable_session`;
  try {
    assert.equal((await fetch(own, { headers })).status, 503);
    const failure = await fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie } });
    assert.equal(failure.status, 503);
    assert.equal(failure.headers.get('set-cookie'), null);
  } finally {
    await runtime.database.$executeRaw`ALTER TABLE unavailable_session RENAME TO auth_session`;
  }
  assert.equal(
    (await fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie } })).status,
    200,
  );
});

test('legacy shared-password sessions and new identities cannot authenticate each other', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const { createServer } = await import('../../src/server.ts');
  const legacy = createServer({ password: 'legacy-synthetic-only', mode: 'demo' });
  await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => legacy.close(() => resolve())));
  const address = legacy.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const oldLogin = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=legacy-synthetic-only',
  });
  assert.equal(oldLogin.status, 303);
  const oldCookie = oldLogin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.equal(
    (await fetch(`${origin}/api/account`, { headers: { cookie: oldCookie } })).status,
    200,
  );
  assert.equal(
    (await fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie: oldCookie } })).status,
    401,
  );
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie);
  assert.equal(
    (
      await fetch(`${origin}/api/account`, {
        headers: { cookie, Authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/profile`, {
        headers: { cookie: oldCookie },
      })
    ).status,
    401,
  );
});

test('login cooldown uses database rate limiting and returns a standard retry interval', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  for (let attempt = 0; attempt < 3; attempt++) await login(runtime);
  const response = await fetch(`${runtime.webOrigin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: runtime.webOrigin },
    body: JSON.stringify({ email: users[0]!.email, password: users[0]!.password }),
  });
  assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(retryAfter > 0 && retryAfter <= 10);
});

test('the active session refresh reaches the browser cookie and RSC reads do not consume it', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  await runtime.database.session.updateMany({
    where: { userId: users[0]!.id },
    data: {
      expiresAt: new Date(Date.now() + 5 * 86400000),
      updatedAt: new Date(Date.now() - 2 * 86400000),
    },
  });
  await fetch(`${runtime.webOrigin}/dashboard`, { headers: { cookie } });
  const response = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin },
  });
  assert.equal(response.status, 200);
  const refreshed = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('workbench.session_token='));
  assert.ok(refreshed, 'the session renewal must include the browser cookie');
  assert.match(refreshed, /Max-Age=604800/);
  assert.match(refreshed, /HttpOnly/);
  assert.doesNotMatch(refreshed, /Domain=/i);
});

test(
  'interrupting the demo while its database starts leaves no synthetic container',
  { timeout: 20000 },
  async (t) => {
    const { spawn, execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const child = spawn(process.execPath, ['scripts/auth-demo.ts'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const filter = `label=entry-guidance.fixture-owner=${child.pid}`;
    const containers = async () =>
      (await exec('docker', ['ps', '-aq', '--filter', filter])).stdout.trim();
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      const remaining = await containers();
      if (remaining) await exec('docker', ['stop', '-t', '1', ...remaining.split('\n')]);
    });
    let found = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await containers()) {
        found = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(found, 'the demo created its isolated database');
    assert.equal(output.includes('合成用户工作台'), false, 'termination occurs before readiness');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(await containers(), '');
  },
);
