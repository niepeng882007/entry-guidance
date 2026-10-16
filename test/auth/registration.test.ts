import assert from 'node:assert/strict';
import test from 'node:test';
import { startAuthRuntime, users } from './runtime.ts';

type Runtime = Awaited<ReturnType<typeof startAuthRuntime>>;
const password = 'synthetic-registration-only-02';
function post(runtime: Runtime, path: string, body: unknown, origin = runtime.webOrigin) {
  return fetch(`${origin}/api/auth/${path}`, {
    method: 'POST',
    headers: {
      Host: new URL(origin).host,
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
async function signIn(runtime: Runtime, email: string) {
  let response = await post(runtime, 'sign-in/email', { email, password });
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    assert.ok(seconds > 0 && seconds <= 10);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 50));
    response = await post(runtime, 'sign-in/email', { email, password });
  }
  return response;
}
async function generic(response: Response) {
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: true });
  assert.equal(response.headers.get('set-cookie'), null);
}
void test('two visitors register, verify by email and log into separate profiles', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  for (const [index, name] of ['新用户甲', '新用户乙'].entries()) {
    const email = `new-${index}@example.test`;
    await generic(
      await post(runtime, 'sign-up/email', {
        name,
        email,
        password,
        emailVerified: true,
        disabled: true,
        authorizationVersion: 99,
      }),
    );
    const unverified = await signIn(runtime, email);
    assert.equal(unverified.status, 403);
    assert.equal(unverified.headers.get('set-cookie'), null);
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
    const dashboard = await fetch(`${runtime.webOrigin}/dashboard`, { redirect: 'manual' });
    assert.ok((dashboard.headers.get('location') ?? (await dashboard.text())).includes('/login'));
    const verification = await fetch(runtime.mail.messages[index]!.url, { redirect: 'manual' });
    assert.equal(verification.status, 302);
    assert.equal(verification.headers.get('set-cookie'), null);
    const authenticated = await signIn(runtime, email);
    assert.equal(authenticated.status, 200);
    const cookie = authenticated.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const profile = await fetch(`${runtime.webOrigin}/api/profile`, { headers: { cookie } });
    assert.equal(profile.status, 200);
    const data = (await profile.json()) as { id: string; name: string; email: string };
    assert.equal(data.email, email);
    assert.equal(data.name, name);
    // A verification link is idempotent and never grants a session on replay.
    const replay = await fetch(runtime.mail.messages[index]!.url, { redirect: 'manual' });
    assert.equal(replay.headers.get('set-cookie'), null);
  }
});

void test('failed and timed-out mail preserves the pending account and explicit resend recovers it', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  for (const mode of ['fail', 'timeout'] as const) {
    runtime.mail.mode = mode;
    const email = `${mode}@example.test`;
    await generic(await post(runtime, 'sign-up/email', { name: '原昵称', email, password }));
    assert.equal(runtime.mail.messages.length, mode === 'fail' ? 0 : 1);
    const pending = await signIn(runtime, email);
    assert.equal(pending.status, 403);
    runtime.mail.mode = 'accept';
    await generic(await post(runtime, 'send-verification-email', { email }));
    const letter = runtime.mail.messages.at(-1)!;
    assert.equal(letter.email, email);
    await fetch(letter.url);
    const login = await signIn(runtime, email);
    assert.equal(login.status, 200);
    assert.equal(((await login.json()) as { user: { name: string } }).user.name, '原昵称');
  }
});

void test('duplicate signup and resend responses never reveal existing user data', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  await generic(
    await post(runtime, 'sign-up/email', { name: '冒名', email: users[0]!.email, password }),
  );
  for (const email of [users[0]!.email, 'unknown@example.test'])
    await generic(await post(runtime, 'send-verification-email', { email }));
  assert.equal(runtime.mail.messages.length, 0);
  await generic(
    await post(runtime, 'sign-up/email', {
      name: '原昵称',
      email: 'pending@example.test',
      password,
    }),
  );
  await generic(
    await post(runtime, 'sign-up/email', {
      name: '替换昵称',
      email: 'pending@example.test',
      password: 'different-password-only',
    }),
  );
  await fetch(runtime.mail.messages.at(-1)!.url);
  const login = await post(runtime, 'sign-in/email', { email: 'pending@example.test', password });
  assert.equal(login.status, 200);
  assert.equal(((await login.json()) as { user: { name: string } }).user.name, '原昵称');
});

void test('two web instances atomically share registration and per-email resend quotas', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const replica = await runtime.startReplica();
  const results = await Promise.all(
    Array.from({ length: 14 }, (_, i) =>
      post(
        runtime,
        'sign-up/email',
        { name: '限流用户', email: `quota-${i}@example.test`, password },
        i % 2 ? replica : runtime.webOrigin,
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === 200).length, 10);
  assert.equal(results.filter((result) => result.status === 429).length, 4);
  for (const result of results.filter((result) => result.status === 429)) {
    assert.ok(Number(result.headers.get('retry-after')) > 0);
    assert.ok(Number(result.headers.get('retry-after')) <= 3600);
  }
  const resend = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      post(
        runtime,
        'send-verification-email',
        { email: i % 2 ? 'Case@Example.test' : 'case@example.test' },
        i % 2 ? replica : runtime.webOrigin,
      ),
    ),
  );
  assert.equal(resend.filter((result) => result.status === 200).length, 3);
  assert.equal(resend.filter((result) => result.status === 429).length, 5);
  for (const result of resend.filter((result) => result.status === 429))
    assert.ok(Number(result.headers.get('retry-after')) <= 900);
});

void test('registration and verification reject foreign sources, callbacks, invalid tokens and dependency failure', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  for (const path of ['sign-up/email', 'send-verification-email']) {
    for (const origin of [undefined, 'https://wrong.example']) {
      const response = await fetch(`${runtime.webOrigin}/api/auth/${path}`, {
        method: 'POST',
        headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403);
    }
    const invalid = await post(runtime, path, {
      email: 'safe@example.test',
      name: '测试',
      password,
      callbackURL: 'https://wrong.example',
    });
    assert.equal(invalid.status, 422);
    const oversized = await post(runtime, path, {
      email: 'safe@example.test',
      name: 'x'.repeat(9000),
      password,
    });
    assert.equal(oversized.status, 422);
  }
  const email = 'expired@example.test';
  await generic(await post(runtime, 'sign-up/email', { email, name: '到期', password }));
  for (const link of [
    await runtime.expiredVerificationURL(email),
    runtime.mail.messages[0]!.url.replace('token=', 'token=bad'),
  ]) {
    const response = await fetch(link, { redirect: 'manual' });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('location') ?? '', /error=/);
  }
  assert.equal((await signIn(runtime, email)).status, 403);
  const malicious = new URL(runtime.mail.messages[0]!.url);
  malicious.searchParams.set('callbackURL', 'https://wrong.example');
  assert.equal((await fetch(malicious, { redirect: 'manual' })).status, 422);
  assert.equal(runtime.mail.messages.length, 1);
  await runtime.database.$executeRaw`ALTER TABLE auth_rate_limit RENAME TO unavailable_rate_limit`;
  try {
    assert.equal(
      (
        await post(runtime, 'sign-up/email', {
          email: 'blocked@example.test',
          name: '关闭',
          password,
        })
      ).status,
      503,
    );
  } finally {
    await runtime.database
      .$executeRaw`ALTER TABLE unavailable_rate_limit RENAME TO auth_rate_limit`;
  }
  assert.equal(runtime.mail.messages.length, 1);
});

void test('public HTML is static and independent of sessions, while authentication and private pages stay noindex', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const replica = await runtime.startReplica({ APP_ENV: 'production' });
  const home = await fetch(replica, {
    headers: { Host: new URL(replica).host, Cookie: 'workbench.session_token=invalid' },
  });
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-robots-tag'), null);
  assert.doesNotMatch(home.headers.get('cache-control') ?? '', /no-store|private/);
  const html = await home.text();
  for (const text of [
    '先写下风险',
    '只读',
    '复盘',
    'name="description"',
    'rel="canonical"',
    'property="og:title"',
    'href="/register"',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /alice@example|bob@example|noindex/);
  const policy = home.headers.get('content-security-policy')!;
  assert.match(policy, /sha256-/);
  assert.doesNotMatch(policy, /nonce-|unsafe-inline|unsafe-eval/);
  const again = await fetch(replica, { headers: { Host: new URL(replica).host } });
  assert.equal(await again.text(), html);
  assert.match((await fetch(runtime.webOrigin)).headers.get('x-robots-tag')!, /noindex/);
  for (const path of ['/login', '/register', '/verify-email', '/dashboard']) {
    const response = await fetch(`${runtime.webOrigin}${path}`, { redirect: 'manual' });
    assert.match(response.headers.get('x-robots-tag')!, /noindex/);
    assert.match(response.headers.get('cache-control')!, /no-store/);
  }
  const sitemap = await (await fetch(`${runtime.webOrigin}/sitemap.xml`)).text();
  assert.doesNotMatch(sitemap, /login|register|dashboard|verify-email/);
  const robots = await (await fetch(`${runtime.webOrigin}/robots.txt`)).text();
  assert.match(robots, /Allow: \//);
  assert.doesNotMatch(robots, /Disallow: \/(login|dashboard)/);
  assert.equal((await fetch(`${runtime.webOrigin}/missing-page`)).status, 404);
});

void test('public navigation only receives login state, never the session or user record', async (t) => {
  const runtime = await startAuthRuntime();
  t.after(() => runtime.close());
  const login = await post(runtime, 'sign-in/email', {
    email: users[0]!.email,
    password: users[0]!.password,
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await fetch(`${runtime.webOrigin}/api/auth/get-session`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['authenticated']);
  assert.equal(body.authenticated, true);
});
