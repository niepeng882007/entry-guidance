'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModelKeySubmission } from '../../../src/model-key.ts';
import { businessRequest, BusinessRequestError } from './business-request.ts';

interface ModelMetadata {
  id: string;
  version: number;
  state: 'active' | 'revoked';
  verifiedAt: string | null;
  updatedAt: string;
}
export default function ModelSettings({
  userId,
  simulation,
  onIdentityInvalid,
}: {
  userId: string;
  simulation?: boolean;
  onIdentityInvalid: () => void;
}) {
  const [credential, setCredential] = useState<ModelMetadata | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef<AbortController | null>(null);
  const request = useCallback(
    async (submission?: ModelKeySubmission) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      try {
        const response = await businessRequest('model', controller.signal, userId, submission);
        const result: { credential: ModelMetadata | null } = await response.json();
        if (controller.signal.aborted) return;
        setCredential(result.credential);
        setReady(true);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof BusinessRequestError && cause.status === 401) onIdentityInvalid();
        else setError(cause instanceof Error ? cause.message : '模型设置暂时不可用，请重试。');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [userId, onIdentityInvalid],
  );
  useEffect(() => {
    void request();
    return () => {
      pending.current?.abort();
    };
  }, [request]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready) return;
    const fields = new FormData(event.currentTarget);
    event.currentTarget.reset();
    void request({
      action: 'save',
      apiKey: String(fields.get('apiKey') ?? ''),
      requestId: crypto.randomUUID(),
    });
  }
  return (
    <section aria-label="自备模型 Key 设置">
      <p>DeepSeek · deepseek-v4-pro · high</p>
      <p>费用由你向 DeepSeek 支付；用量不等同于账单金额。</p>
      <p>
        保存时仅验证模型元数据，不发起分析。Key 加密保存，不回显；修改需要最近 15 分钟内的密码登录。
      </p>
      <p>
        没有有效模型 Key 仍可使用非 AI 功能和查看旧报告。更换 Key 后，未完成分析需由你明确继续。
      </p>
      {simulation && <p>合成演示 · 不连接真实模型，请勿输入真实 Key。</p>}
      <p role="status">
        {!ready
          ? '正在读取模型设置…'
          : credential?.state === 'active'
            ? '模型 Key 已保存。'
            : credential?.state === 'revoked'
              ? '模型 Key 已撤销。'
              : '尚未设置模型 Key。'}
      </p>
      {credential?.state === 'active' && credential.verifiedAt && (
        <p className="muted">
          保存时验证通过：
          {new Date(credential.verifiedAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          })}
          （北京时间）。后续可用性以调用结果为准。
        </p>
      )}
      <form ref={form} autoComplete="off" onSubmit={submit}>
        <p className="field">
          <label className="field-label" htmlFor="model-api-key">
            模型 API Key
          </label>
          <input
            className="field-control"
            id="model-api-key"
            name="apiKey"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            minLength={8}
            maxLength={256}
            required
            disabled={busy || !ready}
          />
        </p>
        <button className="button" disabled={busy || !ready} aria-busy={busy}>
          验证并保存
        </button>{' '}
        <button
          className="button button--secondary"
          type="button"
          disabled={busy || credential?.state !== 'active'}
          onClick={() => {
            form.current?.reset();
            void request({ action: 'revoke', requestId: crypto.randomUUID() });
          }}
        >
          撤销模型 Key
        </button>
      </form>
      {error && (
        <p role="alert">
          {error} <a href="/login">重新登录</a>
        </p>
      )}
      {error && (
        <button className="button button--text" disabled={busy} onClick={() => void request()}>
          重新读取设置
        </button>
      )}
    </section>
  );
}
