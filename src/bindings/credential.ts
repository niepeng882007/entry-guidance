import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

interface CredentialContext {
  userId: string;
  bindingId: string;
  purpose: string;
  version: number;
  keyVersion: number;
}
export interface BinanceCredential {
  apiKey: string;
  apiSecret: string;
}
function associatedData(context: CredentialContext) {
  return Buffer.from(
    JSON.stringify([
      context.userId,
      context.bindingId,
      context.purpose,
      context.version,
      context.keyVersion,
    ]),
  );
}
function sealValue(value: object, context: CredentialContext, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
}
function openValue(sealed: string, context: CredentialContext, key: Buffer): unknown {
  const bytes = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(associatedData(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
  );
}
export function sealCredential(value: BinanceCredential, context: CredentialContext, key: Buffer) {
  return sealValue(value, context, key);
}
export function openCredential(
  sealed: string,
  context: CredentialContext,
  key: Buffer,
): BinanceCredential {
  const value = openValue(sealed, context, key);
  if (
    !value ||
    typeof value !== 'object' ||
    !('apiKey' in value) ||
    !('apiSecret' in value) ||
    typeof value.apiKey !== 'string' ||
    typeof value.apiSecret !== 'string'
  )
    throw new Error('凭据不可用。');
  return { apiKey: value.apiKey, apiSecret: value.apiSecret };
}
export function sealModelCredential(
  value: { apiKey: string },
  context: CredentialContext,
  key: Buffer,
) {
  return sealValue(value, context, key);
}
export function openModelCredential(
  sealed: string,
  context: CredentialContext,
  key: Buffer,
): { apiKey: string } {
  const value = openValue(sealed, context, key);
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 1 ||
    !('apiKey' in value) ||
    typeof value.apiKey !== 'string' ||
    !value.apiKey
  )
    throw new Error('凭据不可用。');
  return { apiKey: value.apiKey };
}
export function credentialMasterKey() {
  const value = process.env.CREDENTIAL_MASTER_KEY ?? '';
  const version = Number(process.env.CREDENTIAL_MASTER_KEY_VERSION);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || !Number.isSafeInteger(version) || version < 1)
    throw new Error('凭据加密配置无效。');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('凭据加密配置无效。');
  return { key, version };
}
