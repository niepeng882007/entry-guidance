import { configuredOrigin } from './config.ts';

export async function sendVerificationMail(message: { email: string; url: string }) {
  // Only the local synthetic mail receiver is enabled in this implementation stage.
  try {
    if (!['local', 'test'].includes(process.env.APP_ENV ?? 'local')) throw new Error('disabled');
    const origin = configuredOrigin(process.env.AUTH_MAIL_FAKE_ORIGIN);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
      throw new Error('invalid');
    const response = await fetch(`${origin}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('unavailable');
  } catch {
    // Keep the pending account; the public response never confirms recipient existence or delivery.
    console.error('auth-mail:unavailable');
  }
}
