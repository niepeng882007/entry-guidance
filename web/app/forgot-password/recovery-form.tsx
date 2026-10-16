'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';

export default function RecoveryForm({ reset = false }: { reset?: boolean }) {
  const [ready, setReady] = useState(false);
  const [valid, setValid] = useState(!reset);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const token = useRef('');
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (reset && !token.current) {
      const params = new URLSearchParams(window.location.search);
      token.current = params.get('token') ?? '';
      const usable = !params.has('error') && /^[a-zA-Z0-9_-]{1,128}$/.test(token.current);
      setValid(usable);
      if (!usable) setError('重置链接无效或已过期，请重新申请。');
      // Keep the reset secret out of subsequent history entries and copied page URLs.
      window.history.replaceState(window.history.state, '', '/reset-password');
    }
    setReady(true);
    const clear = () => {
      form.current?.reset();
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
    };
    const hide = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', clear);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', clear);
    };
  }, [reset]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !valid) return;
    const fields = new FormData(event.currentTarget);
    setError('');
    setMessage('');
    if (reset && fields.get('newPassword') !== fields.get('confirmation')) {
      setError('两次密码不一致，请重新确认。');
      return;
    }
    const body = reset
      ? { token: token.current, newPassword: fields.get('newPassword') }
      : { email: fields.get('email') };
    if (reset) event.currentTarget.reset();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/auth/${reset ? 'reset-password' : 'request-password-reset'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(
          response.status === 429
            ? `尝试过于频繁，请在 ${response.headers.get('retry-after') ?? '稍后'} 秒后重试。`
            : response.status >= 500
              ? '认证服务暂时不可用，请稍后重试。'
              : reset
                ? '重置链接无效或已过期，或密码不符合要求，请检查后重试。'
                : '请输入有效邮箱。',
        );
        return;
      }
      if (reset) {
        token.current = '';
        setDone(true);
        const channel = new BroadcastChannel('workbench-identity');
        channel.postMessage('changed');
        channel.close();
        setMessage('密码已重置，全部旧会话已退出。请用新密码重新登录。');
      } else
        setMessage(
          '如果此邮箱存在，我们已尝试发送重置邮件。请检查收件箱和垃圾邮件，未收到可稍后重发。',
        );
    } catch {
      if (!controller.signal.aborted) setError('无法连接认证服务，请稍后重试。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <form ref={form} className="login__form" onSubmit={(event) => void submit(event)}>
      {!done &&
        valid &&
        (reset ? (
          <>
            <p className="field">
              <label className="field-label" htmlFor="new-password">
                新密码
              </label>
              <input
                className="field-control"
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                aria-describedby="password-hint"
                required
                disabled={busy}
              />
              <span className="help" id="password-hint">
                使用 12–128 字的密码。
              </span>
            </p>
            <p className="field">
              <label className="field-label" htmlFor="confirmation">
                确认新密码
              </label>
              <input
                className="field-control"
                id="confirmation"
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={busy}
              />
            </p>
          </>
        ) : (
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
              disabled={busy}
            />
          </p>
        ))}
      {!done && valid && (
        <button className="button" disabled={!ready || busy} aria-busy={busy}>
          {busy ? '正在提交…' : reset ? '保存新密码' : '发送重置邮件'}
        </button>
      )}
      <p role="status">{message}</p>
      <p className="error" role="alert">
        {error}
      </p>
      <p>
        <a href="/login">前往登录</a>
        {reset && (
          <>
            {' '}
            · <a href="/forgot-password">重新申请重置链接</a>
          </>
        )}
      </p>
    </form>
  );
}
