import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { sealCredential, openCredential } from '../../src/bindings/credential.ts';

void test('authenticated credentials can only be used by their owner, binding, purpose and version', () => {
  const key = randomBytes(32);
  const context = {
    userId: 'alice',
    bindingId: 'binding-1',
    purpose: 'binance',
    version: 1,
    keyVersion: 1,
  };
  const credential = { apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' };
  const sealed = sealCredential(credential, context, key);
  assert.deepEqual(openCredential(sealed, context, key), credential);
  assert.notEqual(sealed, sealCredential(credential, context, key));
  assert.ok(!sealed.includes(credential.apiKey));
  for (const changed of [
    { userId: 'bob' },
    { bindingId: 'binding-2' },
    { purpose: 'model' },
    { version: 2 },
    { keyVersion: 2 },
  ])
    assert.throws(() => openCredential(sealed, { ...context, ...changed }, key));
  assert.throws(() => openCredential(sealed, context, randomBytes(32)));
  const bytes = Buffer.from(sealed, 'base64');
  bytes[20] = bytes[20]! ^ 1;
  assert.throws(() => openCredential(bytes.toString('base64'), context, key));
});
