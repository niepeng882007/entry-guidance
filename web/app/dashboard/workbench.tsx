'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Profile {
  id: string;
  name: string;
  email: string;
}
export default function Workbench() {
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
  }, []);
  const load = useCallback(async () => {
    clear();
    setError('');
    if (signedOut.current || document.visibilityState === 'hidden') return;
    const version = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    try {
      const grant = await fetch('/api/delegation', {
        method: 'POST',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (generation.current !== version) return;
      if (grant.status === 401) {
        signedOut.current = true;
        window.location.replace('/login');
        return;
      }
      if (!grant.ok) throw new Error('服务暂时不可用，请稍后刷新。');
      // The delegation lives only in this request's memory; no browser persistence.
      const delegation: { token: string; userId: string; businessOrigin: string } =
        await grant.json();
      const response = await fetch(
        `${delegation.businessOrigin}/v1/users/${encodeURIComponent(delegation.userId)}/profile`,
        {
          headers: { Authorization: `Bearer ${delegation.token}` },
          credentials: 'omit',
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        },
      );
      if (generation.current !== version) return;
      if (response.status === 401) {
        signedOut.current = true;
        window.location.replace('/login');
        return;
      }
      if (!response.ok) throw new Error('资料服务暂时不可用，请稍后刷新。');
      const next: Profile = await response.json();
      if (generation.current === version && !signedOut.current) setProfile(next);
    } catch (cause) {
      if (generation.current === version && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '服务暂时不可用。');
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
        <h1 className="page-title">我的工作台</h1>
        <button className="button button--secondary" onClick={() => void logout()}>
          退出登录
        </button>
      </header>
      <p className="eyebrow">个人资料</p>
      {profile ? (
        <section aria-label="个人资料">
          <h2>{profile.name}</h2>
          <p>{profile.email}</p>
          <p className="muted">尚未绑定 Binance 账户。</p>
        </section>
      ) : (
        <p role="status">{error || '正在确认身份并读取资料…'}</p>
      )}
      {error && (
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
