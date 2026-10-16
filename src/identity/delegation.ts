import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
export interface Delegation {
  sub: string;
  sid: string;
  version: number;
  scope: 'profile:read';
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}
export function issueDelegation(
  identity: { user: { id: string; authorizationVersion: number }; session: { id: string } },
  issuer: string,
  audience: string,
) {
  const iat = Math.floor(Date.now() / 1000);
  const claims: Delegation = {
    sub: identity.user.id,
    sid: identity.session.id,
    version: identity.user.authorizationVersion,
    scope: 'profile:read',
    iss: issuer,
    aud: audience,
    iat,
    exp: iat + 60,
  };
  const payload = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const key = createPrivateKey({
    key: Buffer.from(process.env.DELEGATION_PRIVATE_KEY ?? '', 'base64'),
    type: 'pkcs8',
    format: 'der',
  });
  return {
    token: `${payload}.${sign(null, Buffer.from(payload), key).toString('base64url')}`,
    expiresAt: claims.exp * 1000,
  };
}
export function verifyDelegation(
  token: string,
  publicKey: string,
  issuer: string,
  audience: string,
): Delegation | null {
  try {
    if (token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== header) return null;
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      type: 'spki',
      format: 'der',
    });
    if (
      !verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        Buffer.from(parts[2]!, 'base64url'),
      )
    )
      return null;
    const value: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') return null;
    const claims = value as Partial<Delegation>;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.sid !== 'string' ||
      !claims.sid ||
      !Number.isSafeInteger(claims.version) ||
      (claims.version ?? -1) < 0 ||
      claims.scope !== 'profile:read' ||
      claims.iss !== issuer ||
      claims.aud !== audience ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat! > now ||
      claims.exp! <= now ||
      claims.exp! - claims.iat! > 60 ||
      claims.exp! <= claims.iat!
    )
      return null;
    return claims as Delegation;
  } catch {
    return null;
  }
}
