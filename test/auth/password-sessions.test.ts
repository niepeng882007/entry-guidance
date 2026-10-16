import assert from 'node:assert/strict';
import test from 'node:test';
import { startAuthRuntime, users } from './runtime.ts';

type Runtime = Awaited<ReturnType<typeof startAuthRuntime>>;
const newPassword = 'synthetic-password-reset-03';
async function post(runtime: Runtime, path: string, body: unknown, cookie = ''): Promise<Response> {
  const response = await fetch(`${runtime.webOrigin}/api/auth/${path}`, {
    method: 'POST',
    headers: { Origin: runtime.webOrigin, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  if (path === 'sign-in/email' && response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    assert.ok(seconds > 0 && seconds <= 10);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
    return post(runtime, path, body, cookie);
  }
  return response;
}
async function login(runtime: Runtime, user = users[0]!, password = user.password) {
  const response = await post(runtime, 'sign-in/email', { email: user.email, password });
  assert.equal(response.status, 200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function grant(runtime: Runtime, cookie: string) {
  const response = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { Origin: runtime.webOrigin, cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}
function profile(runtime: Runtime, cookie: string) {
  return fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie } });
}
function direct(runtime: Runtime, token: string, user = users[0]!) {
  return fetch(`${runtime.businessOrigin}/v1/users/${user.id}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
async function resetToken(runtime: Runtime, email = users[0]!.email) {
  const response = await post(runtime, 'request-password-reset', { email });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: true });
  assert.equal(response.headers.get('set-cookie'), null);
  const letter = runtime.mail.messages.findLast((message) => message.email === email)!;
  assert.ok(letter);
  const opened = await fetch(letter.url, { redirect: 'manual' });
  assert.equal(opened.status, 302);
  const location = new URL(opened.headers.get('location')!);
  assert.equal(location.origin, runtime.webOrigin);
  assert.equal(location.pathname, '/reset-password');
  const token = location.searchParams.get('token');
  assert.ok(token);
  return token;
}

void test('password reset is single use and revokes both devices and their business grants, not another user', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const first = await login(runtime);
  const second = await login(runtime);
  const bob = await login(runtime, users[1]!);
  const tokens = await Promise.all([grant(runtime, first), grant(runtime, second)]);
  const token = await resetToken(runtime);
  const reset = await post(runtime, 'reset-password', { token, newPassword }, first);
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get('set-cookie'), null);
  for (const cookie of [first, second]) assert.equal((await profile(runtime, cookie)).status, 401);
  for (const value of tokens) assert.equal((await direct(runtime, value)).status, 401);
  assert.equal((await profile(runtime, bob)).status, 200);
  assert.equal((await post(runtime, 'reset-password', { token, newPassword })).status, 400);
  assert.equal((await post(runtime, 'sign-in/email', users[0]!)).status, 401);
  assert.equal((await profile(runtime, await login(runtime, users[0]!, newPassword))).status, 200);
});

interface SessionList {
  sessions: {
    id: string;
    current: boolean;
    createdAt: string;
    expiresAt: string;
    userAgent: string | null;
  }[];
}
async function sessions(runtime: Runtime, cookie: string) {
  const response = await fetch(`${runtime.webOrigin}/api/auth/list-sessions`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  const text = await response.text();
  assert.doesNotMatch(text, /"token"|"password"|"ipAddress"/);
  return JSON.parse(text) as SessionList;
}
void test('device management revokes one or all other sessions without touching current or foreign sessions', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const current = await login(runtime);
  const other = await login(runtime);
  const bob = await login(runtime, users[1]!);
  const otherGrant = await grant(runtime, other);
  const list = await sessions(runtime, current);
  assert.equal(list.sessions.length, 2);
  assert.equal(list.sessions.filter((item) => item.current).length, 1);
  const revoke = (id: string) =>
    post(runtime, 'revoke-session', { sessionId: id, expectedUserId: users[0]!.id }, current);
  assert.equal((await revoke(list.sessions.find((item) => item.current)!.id)).status, 422);
  assert.equal((await revoke((await sessions(runtime, bob)).sessions[0]!.id)).status, 404);
  assert.equal((await revoke(list.sessions.find((item) => !item.current)!.id)).status, 200);
  assert.equal((await profile(runtime, other)).status, 401);
  assert.equal((await direct(runtime, otherGrant)).status, 401);
  assert.equal((await profile(runtime, current)).status, 200);
  const third = await login(runtime);
  assert.equal(
    (await post(runtime, 'revoke-other-sessions', { expectedUserId: users[0]!.id }, current))
      .status,
    200,
  );
  assert.equal((await profile(runtime, third)).status, 401);
  assert.equal((await profile(runtime, bob)).status, 200);
  assert.equal((await sessions(runtime, current)).sessions.length, 1);
});

void test('reset tokens reject expiration and simultaneous consumption across web instances, and roll back on database failure', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const expired = await resetToken(runtime);
  await runtime.database.verification.updateMany({
    where: { value: users[0]!.id },
    data: { expiresAt: new Date(0) },
  });
  assert.equal(
    (await post(runtime, 'reset-password', { token: expired, newPassword })).status,
    400,
  );
  const opened = await fetch(runtime.mail.messages.at(-1)!.url, { redirect: 'manual' });
  assert.match(opened.headers.get('location')!, /error=INVALID_TOKEN/);

  const token = await resetToken(runtime);
  await runtime.database.$executeRaw`ALTER TABLE auth_account RENAME TO unavailable_account`;
  try {
    const failed = await post(runtime, 'reset-password', { token, newPassword });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('set-cookie'), null);
    assert.doesNotMatch(await failed.text(), /Prisma|SELECT|passwordHash|postgresql/);
  } finally {
    await runtime.database.$executeRaw`ALTER TABLE unavailable_account RENAME TO auth_account`;
  }
  assert.equal((await profile(runtime, cookie)).status, 200);
  const replica = await runtime.startReplica();
  const results = await Promise.all([
    post(runtime, 'reset-password', { token, newPassword }),
    fetch(`${replica}/api/auth/reset-password`, {
      method: 'POST',
      headers: { Origin: replica, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await profile(runtime, cookie)).status, 401);
  assert.equal((await profile(runtime, await login(runtime, users[0]!, newPassword))).status, 200);
});

void test('recovery hides account existence, limits mail and rejects foreign origins and callbacks', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  for (const path of [
    'request-password-reset',
    'reset-password',
    'revoke-session',
    'revoke-other-sessions',
  ]) {
    for (const origin of ['', 'https://wrong.example']) {
      const response = await fetch(`${runtime.webOrigin}/api/auth/${path}`, {
        method: 'POST',
        headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403);
    }
  }
  assert.equal(
    (
      await post(runtime, 'request-password-reset', {
        email: users[0]!.email,
        redirectTo: 'https://wrong.example',
      })
    ).status,
    422,
  );
  for (const mode of ['accept', 'fail', 'timeout'] as const) {
    runtime.mail.mode = mode;
    for (const email of [users[0]!.email, 'unknown@example.test']) {
      const response = await post(runtime, 'request-password-reset', { email });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: true });
    }
  }
  assert.equal(runtime.mail.messages.length, 1);
  const limited = await post(runtime, 'request-password-reset', {
    email: users[0]!.email.toUpperCase(),
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const link = new URL(runtime.mail.messages[0]!.url);
  link.searchParams.set('callbackURL', '/dashboard');
  assert.equal((await fetch(link, { redirect: 'manual' })).status, 422);
  assert.equal(
    (await post(runtime, 'reset-password', { token: 'tampered', newPassword })).status,
    400,
  );
  for (const path of ['/forgot-password', '/reset-password', '/dashboard/security']) {
    const response = await fetch(runtime.webOrigin + path, { redirect: 'manual' });
    assert.match(response.headers.get('cache-control')!, /no-store/);
    assert.match(response.headers.get('x-robots-tag')!, /noindex/);
  }
});

void test('device writes require recent login and current page ownership; outages keep valid cookies and never bypass authentication', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie);
  const write = () =>
    post(runtime, 'revoke-other-sessions', { expectedUserId: users[0]!.id }, cookie);
  assert.equal(
    (await post(runtime, 'revoke-other-sessions', { expectedUserId: users[1]!.id }, cookie)).status,
    401,
  );
  await runtime.database.session.updateMany({
    where: { userId: users[0]!.id },
    data: { createdAt: new Date(Date.now() - 16 * 60 * 1000) },
  });
  assert.equal((await write()).status, 403);
  assert.equal((await sessions(runtime, cookie)).sessions.length, 1);
  await runtime.database.session.updateMany({
    where: { userId: users[0]!.id },
    data: { createdAt: new Date() },
  });
  await runtime.database.$executeRaw`ALTER TABLE auth_session RENAME TO unavailable_session`;
  try {
    for (const response of [
      await write(),
      await profile(runtime, cookie),
      await direct(runtime, token),
      await fetch(`${runtime.webOrigin}/api/auth/list-sessions`, { headers: { cookie } }),
    ]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.doesNotMatch(await response.text(), /Prisma|SELECT|postgresql/);
    }
  } finally {
    await runtime.database.$executeRaw`ALTER TABLE unavailable_session RENAME TO auth_session`;
  }
  assert.equal((await profile(runtime, cookie)).status, 200);
  for (const data of [{ disabled: true }, { disabled: false, emailVerified: false }]) {
    await runtime.database.user.update({ where: { id: users[0]!.id }, data });
    assert.equal((await write()).status, 401);
    assert.equal(
      (await fetch(`${runtime.webOrigin}/api/auth/list-sessions`, { headers: { cookie } })).status,
      401,
    );
  }
});
