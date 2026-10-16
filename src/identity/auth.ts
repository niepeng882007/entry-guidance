import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { getIdentityDatabase } from './database.ts';
import { authIpAddressOptions, authOrigin } from './config.ts';
import { consumeQuota } from './rate-limit.ts';
import { sendVerificationMail } from './mail.ts';

function createAuth() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('认证配置无效。');
  return betterAuth({
    baseURL: authOrigin(),
    secret,
    telemetry: { enabled: false },
    database: prismaAdapter(getIdentityDatabase(), { provider: 'postgresql', transaction: true }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => sendVerificationMail({ email: user.email, url }),
    },
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
        sendVerificationMail({ email: user.email, url }),
    },
    session: { expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await getIdentityDatabase().user.findUnique({
              where: { id: session.userId },
            });
            if (!user || user.disabled || !user.emailVerified)
              throw new APIError('FORBIDDEN', { message: '此账号不可用。' });
          },
        },
      },
    },
    advanced: {
      cookiePrefix: 'workbench',
      crossSubDomainCookies: { enabled: false },
      ipAddress: authIpAddressOptions(),
    },
    trustedOrigins: [authOrigin()],
    user: {
      additionalFields: {
        disabled: { type: 'boolean', defaultValue: false, input: false },
        authorizationVersion: { type: 'number', defaultValue: 0, input: false },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 30,
      customStorage: { consume: (key, rule) => consumeQuota(`endpoint:${key}`, rule) },
      // These two routes consume IP quotas before parsing or allocating per-email keys.
      customRules: {
        '/sign-up/email': false,
        '/send-verification-email': false,
        '/request-password-reset': false,
      },
    },
    logger: { disabled: true },
  });
}
let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (auth ??= createAuth());
}

export async function currentIdentity(headers: Headers, refreshHeaders?: Headers) {
  const result = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: !refreshHeaders },
    returnHeaders: true,
  });
  const identity = result.response;
  if (!identity || !identity.user.emailVerified || identity.user.disabled) return null;
  if (refreshHeaders)
    for (const cookie of result.headers.getSetCookie()) refreshHeaders.append('Set-Cookie', cookie);
  return identity;
}
