'use client';
import { useEffect, useState, type FormEvent } from 'react';

export default function Registration({ resendOnly = false }: { resendOnly?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [pending, setPending] = useState(resendOnly);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(
        `/api/auth/${pending ? 'send-verification-email' : 'sign-up/email'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: fields.get('email'),
            ...(!pending ? { name: fields.get('name'), password: fields.get('password') } : {}),
          }),
        },
      );
      if (!response.ok) {
        setError(
          response.status === 429
            ? `尝试过于频繁，请在 ${response.headers.get('retry-after') ?? '稍后'} 秒后重试。`
            : response.status >= 500
              ? '认证服务暂时不可用；若已提交注册，可稍后重发验证邮件。'
              : '提交失败，请检查输入资料。',
        );
        return;
      }
      const password = form.elements.namedItem('password');
      if (password instanceof HTMLInputElement) password.value = '';
      setPending(true);
      setMessage(
        '如果此邮箱需要验证，我们已尝试发送验证邮件。邮件服务接受请求不代表最终送达；请检查收件箱和垃圾邮件，未收到可稍后重发。验证后请手动登录。',
      );
    } catch {
      setError('无法连接认证服务，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="login__form" onSubmit={(event) => void submit(event)}>
      {!pending && (
        <p className="field">
          <label className="field-label" htmlFor="name">
            昵称
          </label>
          <input
            className="field-control"
            id="name"
            name="name"
            autoComplete="nickname"
            maxLength={80}
            required
          />
        </p>
      )}
      <p className="field">
        <label className="field-label" htmlFor="email">
          邮箱
        </label>
        <input
          className="field-control"
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
        />
      </p>
      {!pending && (
        <p className="field">
          <label className="field-label" htmlFor="password">
            密码
          </label>
          <input
            className="field-control"
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            aria-describedby="password-hint"
            required
          />
          <span className="help" id="password-hint">
            使用 12–128 字的密码。
          </span>
        </p>
      )}
      <button className="button" disabled={!ready || busy} aria-busy={busy}>
        {busy ? '正在提交…' : pending ? '重发验证邮件' : '注册并验证邮箱'}
      </button>
      <p role="status">{message}</p>
      <p className="error" role="alert">
        {error}
      </p>
      <p>
        <a href="/login">前往登录</a>
        {!pending && (
          <>
            {' '}
            · <a href="/verify-email">已有账号，重发验证邮件</a>
          </>
        )}
      </p>
    </form>
  );
}
