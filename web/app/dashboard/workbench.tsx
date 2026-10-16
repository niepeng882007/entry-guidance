'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { businessRequest, BusinessRequestError } from './business-request.ts';
import ConnectionsForm, { type BindingMetadata } from './connections-form.tsx';
import SecuritySessions from './security-sessions.tsx';

interface Profile {
  id: string;
  name: string;
  email: string;
}
export default function Workbench({
  connections = false,
  security = false,
}: {
  connections?: boolean;
  security?: boolean;
}) {
  const [binding, setBinding] = useState<BindingMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const signedOut = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const clear = useCallback(() => {
    generation.current++;
    pending.current?.abort();
    pending.current = null;
    setProfile(null);
    setBinding(null);
    setBusy(false);
  }, []);
  const identityLost = useCallback(() => {
    signedOut.current = true;
    clear();
    window.location.replace('/login');
  }, [clear]);
  const load = useCallback(async () => {
    clear();
    setError('');
    if (signedOut.current || document.visibilityState === 'hidden') return;
    const version = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    try {
      const response = await businessRequest('profile', controller.signal);
      const next: Profile = await response.json();
      if (generation.current !== version || signedOut.current) return;
      const connectionResponse = await businessRequest('binding', controller.signal, next.id);
      const connection: { binding: BindingMetadata | null } = await connectionResponse.json();
      if (generation.current === version && !signedOut.current) {
        setProfile(next);
        setBinding(connection.binding);
      }
    } catch (cause) {
      if (generation.current === version && !controller.signal.aborted) {
        if (cause instanceof BusinessRequestError && cause.status === 401) {
          signedOut.current = true;
          window.location.replace('/login');
        } else setError(cause instanceof Error ? cause.message : '服务暂时不可用。');
      }
    }
  }, [clear]);
  useEffect(() => {
    const bus = new BroadcastChannel('workbench-identity');
    channel.current = bus;
    bus.onmessage = () => {
      signedOut.current = true;
      clear();
      window.location.replace('/login');
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') clear();
      else void load();
    };
    const hide = () => clear();
    const show = () => {
      void load();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    void load();
    return () => {
      clear();
      bus.close();
      channel.current = null;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [clear, load]);
  async function saveConnection(value: { apiKey: string; apiSecret: string; requestId: string }) {
    if (busy || signedOut.current || !profile) return;
    const version = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      await businessRequest('binding', controller.signal, profile.id, value);
      if (generation.current === version && !signedOut.current) await load();
    } catch (cause) {
      if (generation.current === version && !controller.signal.aborted) {
        if (cause instanceof BusinessRequestError && cause.status === 401) {
          clear();
          signedOut.current = true;
          window.location.replace('/login');
        } else setError(cause instanceof Error ? cause.message : '连接失败，请稍后重试。');
      }
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  async function logout() {
    signedOut.current = true;
    clear();
    setError('');
    channel.current?.postMessage('changed');
    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error();
      window.location.replace('/login');
    } catch {
      setError('退出尚未完成，请重试；私有资料已隐藏。');
    }
  }
  return (
    <main className="page">
      <header className="page-header">
        <h1 className="page-title">
          {security ? '密码与设备会话' : connections ? 'Binance 只读连接' : '我的工作台'}
        </h1>
        <button className="button button--secondary" onClick={() => void logout()}>
          退出登录
        </button>
      </header>
      <nav aria-label="工作台导航">
        <a
          className="button button--text"
          href={connections || security ? '/dashboard' : '/dashboard/connections'}
        >
          {connections || security ? '返回工作台' : '连接设置'}
        </a>
        {!security && (
          <a className="button button--text" href="/dashboard/security">
            安全设置
          </a>
        )}
      </nav>
      <p className="eyebrow">个人资料</p>
      {profile ? (
        <section aria-label="个人资料">
          <h2>{profile.name}</h2>
          <p>{profile.email}</p>
          <p className="muted">
            {binding ? `已绑定真实 Binance 账户：${binding.uid}` : '尚未绑定 Binance 账户。'}
          </p>
        </section>
      ) : (
        <p role="status">{error || '正在确认身份并读取资料…'}</p>
      )}
      {connections && profile && (
        <ConnectionsForm binding={binding} busy={busy} onSubmit={saveConnection} />
      )}
      {security && profile && (
        <SecuritySessions userId={profile.id} onIdentityLost={identityLost} />
      )}
      {connections && error && (
        <p role="alert">
          {error} <a href="/login">重新登录</a>
        </p>
      )}
      {error && !connections && (
        <button
          className="button"
          onClick={() => {
            if (signedOut.current) void logout();
            else void load();
          }}
        >
          重试
        </button>
      )}
    </main>
  );
}
