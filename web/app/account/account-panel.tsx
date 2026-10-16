'use client';
import { accountDetailFields as details } from '../../../public/account-amounts.ts';
import { useAccountSnapshot } from './use-account-snapshot.ts';
import type { BindingMetadata } from '../dashboard/connections-form.tsx';

function time(value: string) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '尚无';
}

export default function AccountPanel({
  userId,
  binding,
  simulation = false,
  summary = false,
  onIdentityInvalid,
}: {
  userId: string;
  binding: BindingMetadata;
  simulation?: boolean;
  summary?: boolean;
  onIdentityInvalid: () => void;
}) {
  const {
    snapshot,
    attempted,
    busy,
    stale,
    message,
    errorDetail,
    relogin,
    progress,
    paused,
    refresh,
    interval,
  } = useAccountSnapshot({ userId, binding, simulation, summary, onIdentityInvalid });
  return (
    <section className="account-page" aria-label={summary ? '账户摘要' : '账户资产'}>
      <header className="page-header">
        <h2 className="section-title">{summary ? '账户摘要' : 'USDT 合约资产'}</h2>
        <div className="account-page__actions">
          <div className="account-page__refresh">
            {busy ? (
              <span className="muted" aria-live="polite">
                刷新中…
              </span>
            ) : paused ? (
              <span className="muted">{paused}</span>
            ) : (
              <svg
                className="account-page__countdown"
                viewBox="0 0 24 24"
                role="img"
                aria-label={`自动刷新倒计时：${Math.ceil((interval / 1000) * progress)} 秒后刷新`}
              >
                <circle className="account-page__countdown-track" cx="12" cy="12" r="9" />
                <circle
                  className="account-page__countdown-progress"
                  cx="12"
                  cy="12"
                  r="9"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 * (1 - progress)}
                />
              </svg>
            )}
          </div>
          <button
            className="button button--secondary"
            type="button"
            disabled={busy || relogin}
            aria-busy={busy}
            onClick={() => refresh.current()}
          >
            手动刷新
          </button>
        </div>
      </header>
      <p className="source">
        {simulation ? '模拟数据 · 不代表真实账户' : 'Binance 只读账户 · 查询时点快照'}
      </p>
      {stale && message && (
        <div className="status" data-state="error" role="status">
          <p className="status__message">{message}</p>
          {relogin && <a href="/login">重新登录</a>}
          {errorDetail && (
            <details key={errorDetail} className="disclosure">
              <summary className="disclosure__summary">错误详情</summary>
              <p className="status__message account-page__error-detail">{errorDetail}</p>
            </details>
          )}
        </div>
      )}
      <div className="balances balances--assets" data-current={!stale}>
        {(
          [
            ['equity', '账户权益', 'asset-equity'],
            ['availableBalance', '可用余额', 'asset-available'],
            ['unrealizedProfit', '未实现盈亏', 'asset-pnl'],
          ] as const
        ).map(([field, label, id]) => (
          <section className="balance" key={field}>
            <h3 className="section-title">
              {label} <span className="balance__unit">USDT</span>
            </h3>
            <p id={id} className="amount">
              {snapshot?.[field] ?? '—'}
            </p>
            {!summary && (
              <details className="disclosure disclosure--help">
                <summary className="disclosure__summary" aria-label={`${label}说明`}>
                  说明
                </summary>
                <p className="help">
                  {field === 'equity'
                    ? '钱包余额 + 未实现盈亏。'
                    : field === 'availableBalance'
                      ? '可用于开仓的余额，已计入现有资金占用。'
                      : '当前持仓的浮动盈亏，未扣手续费与资金费。'}
                </p>
              </details>
            )}
          </section>
        ))}
      </div>
      {!summary && (
        <details className="disclosure account-page__details" open>
          <summary className="disclosure__summary">资金占用与查询信息</summary>
          <dl className="details details--account">
            {details.map(([field, label]) => (
              <div className="details__row" key={field}>
                <dt className="details__term">{label}</dt>
                <dd className="details__value">
                  {!snapshot
                    ? '等待查询'
                    : snapshot[field] == null
                      ? '未知 · 未返回'
                      : `${snapshot[field]} USDT`}
                </dd>
              </div>
            ))}
            <div className="details__row">
              <dt className="details__term">成功查询时间</dt>
              <dd id="asset-queried" className="details__value">
                {time(snapshot?.queriedAt ?? '')}
              </dd>
            </div>
            <div className="details__row">
              <dt className="details__term">最近尝试时间</dt>
              <dd id="asset-attempted" className="details__value">
                {time(attempted)}
              </dd>
            </div>
          </dl>
        </details>
      )}
      {summary && (
        <p className="muted">
          查询时间：{time(snapshot?.queriedAt ?? '')} · <a href="/account">查看资产明细</a>
        </p>
      )}
    </section>
  );
}
