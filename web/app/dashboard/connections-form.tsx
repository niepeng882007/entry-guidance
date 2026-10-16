'use client';
import { useState, useEffect, type FormEvent } from 'react';

export interface BindingMetadata {
  id: string;
  uid: string;
  source: 'binance-live';
  credentialVersion: number;
  authorizationVersion: number;
}
export default function ConnectionsForm({
  binding,
  busy,
  onSubmit,
}: {
  binding: BindingMetadata | null;
  busy: boolean;
  onSubmit: (value: { apiKey: string; apiSecret: string; requestId: string }) => Promise<void>;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    event.currentTarget.reset();
    void onSubmit({
      apiKey: String(fields.get('apiKey') ?? ''),
      apiSecret: String(fields.get('apiSecret') ?? ''),
      requestId: crypto.randomUUID(),
    });
  }
  return (
    <section aria-label="Binance 连接设置">
      <p>仅支持专用只读 Key，请关闭交易、提现与划转权限。</p>
      <p>凭据由业务服务加密保存，不会回显。修改需要最近 15 分钟内的密码登录。</p>
      {binding ? (
        <div>
          <p>真实 Binance 账户 · 已验证只读绑定</p>
          <p>UID：{binding.uid}</p>
          <p>更新同一 UID 的 Key 会保留账户归属与历史。不同 UID 需先解绑归档。</p>
        </div>
      ) : (
        <p>尚未绑定 Binance 账户。此处仅建立真实账户绑定，模拟数据不作为身份凭证。</p>
      )}
      <form autoComplete="off" onSubmit={submit}>
        <p className="field">
          <label className="field-label" htmlFor="api-key">
            API Key
          </label>
          <input
            className="field-control"
            id="api-key"
            name="apiKey"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            minLength={8}
            maxLength={256}
            required
            disabled={busy}
          />
        </p>
        <p className="field">
          <label className="field-label" htmlFor="api-secret">
            API Secret
          </label>
          <input
            className="field-control"
            id="api-secret"
            name="apiSecret"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            minLength={8}
            maxLength={256}
            required
            disabled={busy}
          />
        </p>
        <button className="button" disabled={!ready || busy} aria-busy={busy}>
          {busy ? '正在验证…' : '验证并保存'}
        </button>
      </form>
    </section>
  );
}
