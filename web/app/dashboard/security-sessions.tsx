'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

interface DeviceSession {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
}
function deviceName(agent: string | null) {
  if (!agent) return '未知浏览器';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : '浏览器';
  const system = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '未知系统';
  return `${browser} · ${system}`;
}
function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
export default function SecuritySessions({
  userId,
  onIdentityLost,
}: {
  userId: string;
  onIdentityLost: () => void;
}) {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(
    async (sessionId?: string) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      setMessage('');
      const writing = sessionId !== undefined;
      try {
        if (writing) {
          const response = await fetch(
            `/api/auth/${sessionId ? 'revoke-session' : 'revoke-other-sessions'}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expectedUserId: userId, sessionId }),
              signal: controller.signal,
            },
          );
          if (controller.signal.aborted) return;
          if (response.status === 401) {
            onIdentityLost();
            return;
          }
          if (!response.ok)
            throw new Error(
              response.status === 403
                ? '请重新登录以确认密码后再撤销会话。'
                : response.status === 429
                  ? '尝试过于频繁，请稍后重试。'
                  : '撤销未完成，请刷新列表后重试。',
            );
          setMessage('已撤销所选的其他会话，当前设备保持登录。');
        }
        const response = await fetch('/api/auth/list-sessions', {
          headers: { 'X-Workbench-User': userId },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onIdentityLost();
          return;
        }
        if (!response.ok) throw new Error('会话服务暂时不可用，请稍后重试。');
        const data: { sessions: DeviceSession[] } = await response.json();
        if (!controller.signal.aborted) setSessions(data.sessions);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setSessions([]);
          setError(cause instanceof Error ? cause.message : '无法连接会话服务，请稍后重试。');
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [userId, onIdentityLost],
  );
  useEffect(() => {
    void load();
    return () => {
      pending.current?.abort();
    };
  }, [load]);
  return (
    <section aria-label="设备会话">
      <p>
        <a href="/forgot-password">通过邮箱重置密码</a>
      </p>
      <h2>有效会话</h2>
      <p>撤销需要最近 15 分钟内的密码登录。时间为北京时间；浏览器信息仅供识别。</p>
      <p>退出登录或撤销页面会话不会取消此前已接受的后台任务。</p>
      <p>
        <button className="button button--secondary" disabled={busy} onClick={() => void load()}>
          刷新会话
        </button>{' '}
        <button
          className="button"
          disabled={busy || !sessions.some((item) => !item.current)}
          onClick={() => void load('')}
        >
          退出其他设备
        </button>
      </p>
      {sessions.map((item) => (
        <section
          className="settings"
          key={item.id}
          aria-label={item.current ? '当前设备会话' : '其他设备会话'}
        >
          <h3>{deviceName(item.userAgent)}</h3>
          {item.current && <p>当前设备</p>}
          <p>登录时间：{time(item.createdAt)}</p>
          <p>到期时间：{time(item.expiresAt)}</p>
          {!item.current && (
            <button
              className="button button--secondary"
              disabled={busy}
              onClick={() => void load(item.id)}
            >
              撤销此会话
            </button>
          )}
        </section>
      ))}
      <p role="status">{busy ? '正在读取会话…' : message}</p>
      {error && (
        <p className="error" role="alert">
          {error} <a href="/login">重新登录</a>
        </p>
      )}
    </section>
  );
}
