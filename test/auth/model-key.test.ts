import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openModelCredential } from '../../src/bindings/credential.ts';
import { startAuthRuntime, users } from './runtime.ts';
import { bindingTransport } from './binding-fixture.ts';
import { modelTransport } from './model-fixture.ts';

type Runtime = Awaited<ReturnType<typeof startAuthRuntime>>;
async function login(runtime: Runtime, user = users[0]!) {
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
async function grant(runtime: Runtime, cookie: string, scope = 'model:read') {
  const response = await fetch(`${runtime.webOrigin}/api/delegation`, {
    method: 'POST',
    headers: { cookie, Origin: runtime.webOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}
async function readModel(runtime: Runtime, cookie: string, userId = users[0]!.id) {
  return fetch(`${runtime.businessOrigin}/v1/users/${userId}/model`, {
    headers: { Authorization: `Bearer ${await grant(runtime, cookie)}` },
  });
}
async function writeModel(runtime: Runtime, cookie: string, body: object, userId = users[0]!.id) {
  return fetch(`${runtime.businessOrigin}/v1/users/${userId}/model`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await grant(runtime, cookie, 'model:write')}`,
      Origin: runtime.webOrigin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
void test('verified users can read model settings before binding Binance', async (t) => {
  const runtime = await startAuthRuntime({ transport: bindingTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const response = await readModel(runtime, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { credential: null });
});
void test('saving a model key verifies only the fixed metadata endpoint and never returns secrets', async (t) => {
  let requests = 0;
  const runtime = await startAuthRuntime({
    modelTransport: async (...args) => {
      requests++;
      return modelTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const response = await writeModel(runtime, cookie, {
    action: 'save',
    apiKey: 'synthetic-model-alice',
    requestId: randomUUID(),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /synthetic-model|sealedCredential|apiKey|keyVersion/);
  const result = JSON.parse(body);
  assert.equal(result.credential.version, 1);
  assert.equal(result.credential.state, 'active');
  assert.ok(result.credential.verifiedAt);
  assert.deepEqual(await (await readModel(runtime, cookie)).json(), result);
  assert.equal(requests, 1);
});
void test('replacement and revocation advance versions, reject old grants and preserve settings on failure', async (t) => {
  let requests = 0;
  const runtime = await startAuthRuntime({
    modelTransport: async (...args) => {
      requests++;
      return modelTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const save = (apiKey: string, requestId = randomUUID()) =>
    writeModel(runtime, cookie, { action: 'save', apiKey, requestId });
  const requestId = randomUUID();
  const first = await save('synthetic-model-alice', requestId);
  assert.equal(first.status, 200);
  const before = await first.json();
  const replay = await save('synthetic-model-alice', requestId);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), before);
  assert.equal(requests, 1);
  assert.equal((await save('synthetic-model-alice-rotated', requestId)).status, 409);
  const invalid = await save('synthetic-model-invalid');
  assert.equal(invalid.status, 503);
  assert.doesNotMatch(await invalid.text(), /synthetic-private/);
  assert.deepEqual(await (await readModel(runtime, cookie)).json(), before);
  const oldGrant = await grant(runtime, cookie);
  const rotated = await save('synthetic-model-alice-rotated');
  assert.equal(rotated.status, 200);
  const replacement = await rotated.json();
  assert.equal(replacement.credential.id, before.credential.id);
  assert.equal(replacement.credential.version, 2);
  assert.equal(
    (
      await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/model`, {
        headers: { Authorization: `Bearer ${oldGrant}` },
      })
    ).status,
    401,
  );
  const revoked = await writeModel(runtime, cookie, { action: 'revoke', requestId: randomUUID() });
  assert.equal(revoked.status, 200);
  const after = await revoked.json();
  assert.equal(after.credential.version, 3);
  assert.equal(after.credential.state, 'revoked');
  const noOp = await writeModel(runtime, cookie, { action: 'revoke', requestId: randomUUID() });
  assert.deepEqual(await noOp.json(), after);
  assert.equal(requests, 3, 'revocation never contacts the provider');
  const staleReplay = await save('synthetic-model-alice', requestId);
  assert.deepEqual(
    await staleReplay.json(),
    after,
    'a replay cannot report or restore an old active key',
  );
  assert.equal(requests, 3);
  const renewed = await save('synthetic-model-alice');
  assert.equal(renewed.status, 200);
  assert.equal((await renewed.json()).credential.version, 4);
  const profile = await fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/profile`, {
    headers: { Authorization: `Bearer ${await grant(runtime, cookie, 'profile:read')}` },
  });
  assert.equal(profile.status, 200);
});
void test('model authorization rejects cross-user, wrong scope, stale login, origin and hostile fields before contacting the provider', async (t) => {
  let requests = 0;
  const runtime = await startAuthRuntime({
    modelTransport: async (...args) => {
      requests++;
      return modelTransport(...args);
    },
  });
  t.after(() => runtime.close());
  const alice = await login(runtime);
  const bob = await login(runtime, users[1]!);
  const token = await grant(runtime, alice, 'model:write');
  const body = { action: 'save', apiKey: 'synthetic-model-alice', requestId: randomUUID() };
  const write = (overrides: RequestInit = {}, target = users[0]!.id, bearer = token) =>
    fetch(`${runtime.businessOrigin}/v1/users/${target}/model`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Origin: runtime.webOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...overrides,
    });
  assert.equal((await readModel(runtime, bob)).status, 403);
  assert.equal((await write({}, users[1]!.id)).status, 403);
  assert.equal(
    (await write({}, users[0]!.id, await grant(runtime, alice, 'binding:write'))).status,
    403,
  );
  assert.equal((await write({}, users[0]!.id, await grant(runtime, alice))).status, 403);
  for (const origin of ['', 'https://untrusted.example'])
    assert.equal(
      (
        await write({
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: origin,
            'Content-Type': 'application/json',
          },
        })
      ).status,
      403,
    );
  for (const value of [
    { ...body, url: 'https://untrusted.example' },
    { ...body, userId: users[1]!.id },
    { ...body, apiKey: 'bad\r\nkey' },
    { ...body, action: 'revoke' },
    { ...body, requestId: 'bad' },
  ])
    assert.equal((await write({ body: JSON.stringify(value) })).status, 422);
  assert.equal((await write({ body: 'x'.repeat(4097) })).status, 413);
  await runtime.database.session.updateMany({
    where: { userId: users[0]!.id },
    data: { createdAt: new Date(Date.now() - 16 * 60000) },
  });
  assert.equal((await write()).status, 403);
  assert.equal(
    (await readModel(runtime, alice)).status,
    200,
    'reading does not require recent login',
  );
  for (const data of [{ emailVerified: false }, { emailVerified: true, disabled: true }]) {
    await runtime.database.user.update({ where: { id: users[0]!.id }, data });
    assert.equal((await write()).status, 401);
  }
  assert.equal(requests, 0);
  assert.equal(
    (
      await writeModel(
        runtime,
        bob,
        { action: 'save', apiKey: 'synthetic-model-bob', requestId: randomUUID() },
        users[1]!.id,
      )
    ).status,
    200,
  );
  assert.equal(requests, 1);
});

void test('encrypted ownership and invalidation are durable, and a failed revocation transaction preserves the active key', async (t) => {
  const runtime = await startAuthRuntime({ modelTransport });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  const save = (apiKey: string) =>
    writeModel(runtime, cookie, { action: 'save', apiKey, requestId: randomUUID() });
  assert.equal((await save('synthetic-model-alice')).status, 200);
  const first = await runtime.database.modelCredential.findUniqueOrThrow({
    where: { userId: users[0]!.id },
  });
  assert.deepEqual(
    openModelCredential(
      first.sealedCredential!,
      {
        userId: first.userId,
        bindingId: first.id,
        purpose: 'model',
        version: first.version,
        keyVersion: first.keyVersion!,
      },
      runtime.credentialMaster.key,
    ),
    { apiKey: 'synthetic-model-alice' },
  );
  assert.equal((await save('synthetic-model-alice-rotated')).status, 200);
  const before = await (await readModel(runtime, cookie)).json();
  await runtime.database.$executeRawUnsafe(
    `CREATE FUNCTION fail_model_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`,
  );
  await runtime.database.$executeRawUnsafe(
    `CREATE TRIGGER fail_model_invalidation BEFORE INSERT ON model_key_invalidation FOR EACH ROW EXECUTE FUNCTION fail_model_invalidation()`,
  );
  const requestId = randomUUID();
  assert.equal((await writeModel(runtime, cookie, { action: 'revoke', requestId })).status, 503);
  assert.deepEqual(await (await readModel(runtime, cookie)).json(), before);
  await runtime.database.$executeRawUnsafe(
    'DROP TRIGGER fail_model_invalidation ON model_key_invalidation',
  );
  runtime.credentialMaster.key = Buffer.alloc(0);
  assert.equal(
    (await writeModel(runtime, cookie, { action: 'revoke', requestId })).status,
    200,
    'revocation does not need the decryption key',
  );
  const revoked = await runtime.database.modelCredential.findUniqueOrThrow({
    where: { userId: users[0]!.id },
  });
  assert.equal(revoked.sealedCredential, null);
  assert.equal(revoked.keyVersion, null);
  const invalidations = await runtime.database.modelKeyInvalidation.findMany({
    orderBy: { version: 'asc' },
  });
  assert.deepEqual(
    invalidations.map(({ userId, credentialId, version, reason }) => ({
      userId,
      credentialId,
      version,
      reason,
    })),
    [
      { userId: users[0]!.id, credentialId: first.id, version: 1, reason: 'replaced' },
      { userId: users[0]!.id, credentialId: first.id, version: 2, reason: 'revoked' },
    ],
  );
  assert.doesNotMatch(JSON.stringify(invalidations), /apiKey|sealedCredential|synthetic-model/);
});

void test('revocation wins against an in-flight replacement and concurrent changes cannot overwrite it with stale authority', async (t) => {
  let hold = false;
  let arrived!: () => void;
  let release!: () => void;
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = await startAuthRuntime({
    modelTransport: async (...args) => {
      if (hold) {
        arrived();
        await gate;
      }
      return modelTransport(...args);
    },
  });
  t.after(() => {
    release();
    return runtime.close();
  });
  const cookie = await login(runtime);
  assert.equal(
    (
      await writeModel(runtime, cookie, {
        action: 'save',
        apiKey: 'synthetic-model-alice',
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  hold = true;
  const pending = writeModel(runtime, cookie, {
    action: 'save',
    apiKey: 'synthetic-model-alice-rotated',
    requestId: randomUUID(),
  });
  await seen;
  assert.equal(
    (await writeModel(runtime, cookie, { action: 'revoke', requestId: randomUUID() })).status,
    200,
  );
  release();
  assert.equal((await pending).status, 401);
  assert.equal((await (await readModel(runtime, cookie)).json()).credential.state, 'revoked');
  const token = await grant(runtime, cookie, 'model:write');
  const writes = await Promise.all(
    ['synthetic-model-alice', 'synthetic-model-alice-rotated'].map((apiKey) =>
      fetch(`${runtime.businessOrigin}/v1/users/${users[0]!.id}/model`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: runtime.webOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'save', apiKey, requestId: randomUUID() }),
      }),
    ),
  );
  assert.deepEqual(writes.map((response) => response.status).sort(), [200, 401]);
});

void test('malformed model metadata and provider failures never create a saved credential', async (t) => {
  let mode = 'missing';
  const runtime = await startAuthRuntime({
    modelTransport: async () => {
      if (mode === 'throws') throw new Error('synthetic-sensitive-credential');
      if (mode === 'json') return new Response('invalid json');
      return Response.json({
        data: [{ id: 'deepseek-v4-pro', context_window: 2048, max_output_tokens: 2048 }],
      });
    },
  });
  t.after(() => runtime.close());
  const cookie = await login(runtime);
  for (mode of ['missing', 'throws', 'json']) {
    const response = await writeModel(runtime, cookie, {
      action: 'save',
      apiKey: 'synthetic-model-alice',
      requestId: randomUUID(),
    });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /synthetic-sensitive/);
    assert.deepEqual(await (await readModel(runtime, cookie)).json(), { credential: null });
  }
});
