'use client';
import { useEffect, useState, type FormEvent } from 'react';

export default function Login() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fields.get('email'), password: fields.get('password') }),
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? '尝试过于频繁，请稍后重试。'
            : response.status >= 500
              ? '登录服务暂时不可用，请稍后重试。'
              : '登录失败，请检查邮箱、密码及验证状态。',
        );
        return;
      }
      const channel = new BroadcastChannel('workbench-identity');
      channel.postMessage('changed');
      channel.close();
      window.location.replace('/dashboard');
    } catch {
      setError('无法连接登录服务，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="login__form" method="post" action="/api/auth/sign-in/email" onSubmit={submit}>
      <p className="field">
        <label className="field-label" htmlFor="email">
          邮箱
        </label>
        <input
          className="field-control"
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
        />
      </p>
      <p className="field">
        <label className="field-label" htmlFor="password">
          密码
        </label>
        <input
          className="field-control"
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          required
        />
      </p>
      <button className="button" disabled={!ready || busy} aria-busy={busy}>
        {busy ? '正在登录…' : '登录'}
      </button>
      <p className="error" role="alert">
        {error}
      </p>
    </form>
  );
}
