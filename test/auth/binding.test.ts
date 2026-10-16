import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openCredential } from '../../src/bindings/credential.ts';
import { startAuthRuntime, users } from './runtime.ts';
import { bindingTransport, permissions } from './binding-fixture.ts';

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
async function grant(
  runtime: Awaited<ReturnType<typeof startAuthRuntime>>,
  cookie: string,
  scope = 'binding:read',
) {
  const response = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}
void test('a verified unbound user can read their connection settings without a credential', async (t) => {
  const runtime = await startAuthRuntime({ transport: bindingTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie);
  const response = await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/binding`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { binding: null });
});

void test('a first read-only binding stores a stable live account and never returns credentials', async (t) => {
  const runtime = await startAuthRuntime({ transport: bindingTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie, 'binding:write');
  const response = await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/binding`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: runtime.webOrigin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apiKey: 'synthetic-key-alice',
      apiSecret: 'synthetic-secret-alice',
      requestId: '11111111-1111-4111-8111-111111111111',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /synthetic-key|synthetic-secret|sealedCredential|keyVersion/);
  assert.deepEqual(JSON.parse(body).binding.uid, '10001');
});

const aliceCredential = { apiKey: 'synthetic-key-alice', apiSecret: 'synthetic-secret-alice' };
const bobCredential = { apiKey: 'synthetic-key-bob', apiSecret: 'synthetic-secret-bob' };
async function writeBinding(
  runtime: Awaited<ReturnType<typeof startAuthRuntime>>,
  cookie: string,
  credential = aliceCredential,
  requestId = randomUUID(),
) {
  const token = await grant(runtime, cookie, 'binding:write');
  return fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/binding`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: runtime.webOrigin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...credential, requestId }),
  });
}
async function readBinding(
  runtime: Awaited<ReturnType<typeof startAuthRuntime>>,
  cookie: string,
  userId = users[0]!.id,
) {
  const token = await grant(runtime, cookie);
  const response = await fetch(`${runtime.businessOrigin}/v1/users/${userId}/binding`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    binding: {
      id: string;
      uid: string;
      source: string;
      credentialVersion: number;
      authorizationVersion: number;
    } | null;
  };
}
void test('same UID rotation keeps ownership, revokes old delegation and encrypts only the new version', async (t) => {
  const runtime = await startAuthRuntime({ transport: bindingTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const first = await writeBinding(runtime, cookie);
  assert.equal(first.status, 200);
  const before = await readBinding(runtime, cookie);
  const oldGrant = await grant(runtime, cookie);
  const stored = await runtime.database.binanceBinding.findUniqueOrThrow({
    where: { id: before.binding!.id },
  });
  assert.doesNotMatch(stored.sealedCredential, /synthetic-key|synthetic-secret/);
  assert.deepEqual(
    openCredential(
      stored.sealedCredential,
      {
        userId: users[0]!.id,
        bindingId: stored.id,
        purpose: 'binance',
        version: 1,
        keyVersion: 1,
      },
      runtime.credentialMaster.key,
    ),
    aliceCredential,
  );
  const rotated = {
    apiKey: 'synthetic-key-alice-rotated',
    apiSecret: 'synthetic-secret-alice-rotated',
  };
  assert.equal((await writeBinding(runtime, cookie, rotated)).status, 200);
  const after = await readBinding(runtime, cookie);
  assert.deepEqual(after.binding, {
    ...before.binding,
    credentialVersion: 2,
    authorizationVersion: 2,
  });
  assert.equal(
    (
      await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/binding`, {
        headers: { Authorization: `Bearer ${oldGrant}` },
      })
    ).status,
    401,
  );
  assert.throws(() =>
    openCredential(
      stored.sealedCredential,
      {
        userId: users[0]!.id,
        bindingId: stored.id,
        purpose: 'binance',
        version: 2,
        keyVersion: 1,
      },
      runtime.credentialMaster.key,
    ),
  );
  const replacement = await runtime.database.binanceBinding.findUniqueOrThrow({
    where: { id: stored.id },
  });
  assert.deepEqual(
    openCredential(
      replacement.sealedCredential,
      {
        userId: users[0]!.id,
        bindingId: stored.id,
        purpose: 'binance',
        version: 2,
        keyVersion: 1,
      },
      runtime.credentialMaster.key,
    ),
    rotated,
  );
  const mismatch = await writeBinding(runtime, cookie, bobCredential);
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await readBinding(runtime, cookie), after);
});
void test('idempotent retry neither revalidates nor rotates, and a reused key with different content conflicts', async (t) => {
  let requests = 0;
  const runtime = await startAuthRuntime({
    transport: async (...args) => {
      requests++;
      return bindingTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const requestId = randomUUID();
  const first = await writeBinding(runtime, cookie, aliceCredential, requestId);
  const expected = await first.json();
  assert.equal(first.status, 200);
  assert.equal(requests, 2);
  const replay = await writeBinding(runtime, cookie, aliceCredential, requestId);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), expected);
  assert.equal(requests, 2);
  assert.equal((await writeBinding(runtime, cookie, bobCredential, requestId)).status, 409);
  assert.equal(requests, 2);
});
void test('all unsafe or unknown permissions, unverified identity and upstream failure preserve the existing binding', async (t) => {
  let permissionBody: unknown = permissions;
  let uid: unknown = '10001';
  let unavailable = false;
  let identityRequests = 0;
  const runtime = await startAuthRuntime({
    transport: async (url) => {
      if (unavailable) throw new Error('synthetic-sensitive-upstream-content');
      if (url.pathname.endsWith('apiRestrictions')) return { status: 200, body: permissionBody };
      identityRequests++;
      return { status: 200, body: { uid } };
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  assert.equal((await writeBinding(runtime, cookie)).status, 200);
  const original = await readBinding(runtime, cookie);
  for (const field of Object.keys(permissions)) {
    permissionBody = { ...permissions, [field]: field === 'enableReading' ? false : true };
    assert.equal((await writeBinding(runtime, cookie)).status, 422, field);
    const incomplete = { ...permissions } as Record<string, unknown>;
    delete incomplete[field];
    permissionBody = incomplete;
    assert.equal((await writeBinding(runtime, cookie)).status, 422, `missing ${field}`);
  }
  assert.equal(identityRequests, 1);
  permissionBody = permissions;
  for (uid of [null, '', '0', -1, 9007199254740992, '1.5'])
    assert.equal((await writeBinding(runtime, cookie)).status, 422);
  unavailable = true;
  const failed = await writeBinding(runtime, cookie);
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /synthetic-sensitive/);
  assert.deepEqual(await readBinding(runtime, cookie), original);
});
void test('PostgreSQL awards a UID to one user and permits only one active account per user under concurrent HTTP writes', async (t) => {
  const runtime = await startAuthRuntime({ transport: bindingTransport });
  t.after(() => runtime.close());
  const cookies = await Promise.all(users.map((user) => login(runtime, user)));
  const tokens = await Promise.all(
    cookies.map((cookie) => grant(runtime, cookie, 'binding:write')),
  );
  const responses = await Promise.all(
    tokens.map((token, index) =>
      fetch(`${runtime.businessOrigin}/v1/users/${users[index]!.id}/binding`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: runtime.webOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...aliceCredential, requestId: randomUUID() }),
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const loser = responses.findIndex((response) => response.status === 409);
  const denied = await responses[loser]!.text();
  assert.doesNotMatch(denied, /synthetic-alice|synthetic-bob|alice@|bob@/);
  assert.equal((await readBinding(runtime, cookies[loser]!, users[loser]!.id)).binding, null);
  const winner = responses.findIndex((response) => response.status === 200);
  await runtime.database.binanceBinding.updateMany({
    where: { userId: users[winner]!.id },
    data: { state: 'archived' },
  });
  const reserved = await fetch(`${runtime.businessOrigin}/v1/users/${users[loser]!.id}/binding`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens[loser]}`,
      Origin: runtime.webOrigin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...aliceCredential, requestId: randomUUID() }),
  });
  assert.equal(reserved.status, 409, 'an archived UID remains reserved');
});
void test('two unowned UIDs racing for the same user cannot create two active accounts', async (t) => {
  const runtime = await startAuthRuntime({ transport: bindingTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const token = await grant(runtime, cookie, 'binding:write');
  const responses = await Promise.all(
    [aliceCredential, bobCredential].map((credential) =>
      fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/binding`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: runtime.webOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...credential, requestId: randomUUID() }),
      }),
    ),
  );
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.ok(responses.every((response) => [200, 401, 409].includes(response.status)));
  assert.ok(['10001', '10002'].includes((await readBinding(runtime, cookie)).binding!.uid));
});
void test('scope, ownership, recent password login, origin and input validation reject before Binance is contacted', async (t) => {
  let requests = 0;
  const runtime = await startAuthRuntime({
    transport: async (...args) => {
      requests++;
      return bindingTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const readToken = await grant(runtime, cookie);
  const writeToken = await grant(runtime, cookie, 'binding:write');
  const own = `${runtime.businessOrigin}/v1/users/${users[0]!.id}/binding`;
  const body = JSON.stringify({ ...aliceCredential, requestId: randomUUID() });
  const post = (
    token: string,
    origin: string | undefined = runtime.webOrigin,
    content = body,
    target = own,
  ) =>
    fetch(target, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(origin ? { Origin: origin } : {}),
        'Content-Type': 'application/json',
      },
      body: content,
    });
  assert.equal((await post(readToken)).status, 403);
  assert.equal((await post(writeToken, 'https://wrong.example')).status, 403);
  assert.equal((await post(writeToken, '')).status, 403);
  assert.equal(
    (
      await post(
        writeToken,
        runtime.webOrigin,
        body,
        `${runtime.businessOrigin}/v1/users/${users[1]!.id}/binding`,
      )
    ).status,
    403,
  );
  for (const extra of [{ uid: '9999' }, { userId: users[1]!.id }, { source: 'demo' }])
    assert.equal(
      (await post(writeToken, runtime.webOrigin, JSON.stringify({ ...JSON.parse(body), ...extra })))
        .status,
      422,
    );
  assert.equal((await post(writeToken, runtime.webOrigin, '{')).status, 422);
  assert.equal((await post(writeToken, runtime.webOrigin, 'x'.repeat(5000))).status, 413);
  await runtime.database.session.updateMany({
    where: { userId: users[0]!.id },
    data: { createdAt: new Date(Date.now() - 16 * 60000) },
  });
  assert.equal((await post(writeToken)).status, 403);
  const expired = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'binding:write' }),
  });
  assert.equal(expired.status, 403);
  assert.equal((await readBinding(runtime, cookie)).binding, null);
  assert.equal(requests, 0);
});
void test('a logout during Binance validation prevents the late result from creating a binding', async (t) => {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const runtime = await startAuthRuntime({
    transport: async (...args) => {
      if (args[0].pathname === '/api/v3/account') {
        arrived();
        await gate;
      }
      return bindingTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const pending = writeBinding(runtime, cookie);
  await seen;
  try {
    assert.equal(
      (
        await fetch(`${runtime.webOrigin}/api/auth/sign-out`, {
          method: 'POST',
          headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      200,
    );
  } finally {
    release();
  }
  assert.equal((await pending).status, 401);
  const newCookie = await login(runtime);
  assert.equal((await readBinding(runtime, newCookie)).binding, null);
});
