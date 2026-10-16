'use client';
import { parseDecimal } from '../../../public/draft.js';
import { useEntryPlan, type EntryProps } from './use-entry-plan.ts';
const fields = [
  ['budget', '亏损预算'],
  ['stop', '止损值'],
  ['leverage', '杠杆倍数'],
  ['slippage', '滑点预留（%）'],
  ['funding', '资金费预留（USDT）'],
  ['minimumBuffer', '最低强平缓冲（%）'],
  ['fundingCap', '本单资金上限（USDT）'],
] as const;
function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
function liquidationPrice(value: string) {
  if (!value) return '无法估算';
  const scaled = parseDecimal(value, '强平价');
  const cents = (scaled + 500_000n) / 1_000_000n;
  return scaled > 0n && cents === 0n
    ? '<0.01'
    : `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
export default function EntryPanel(props: EntryProps) {
  const { simulation = false } = props;
  const {
    input,
    symbols,
    market,
    error,
    busy,
    loading,
    saved,
    current,
    reason,
    copied,
    card,
    account,
    change,
    draft,
    preview,
    draftError,
    generate,
    copy,
    refresh,
  } = useEntryPlan(props);
  return (
    <>
      <section className="account-page" aria-label="账户摘要">
        <h2 className="section-title">账户摘要</h2>
        <p>{simulation ? '模拟数据 · 不代表真实账户' : 'Binance 只读查询'} · 每轮完成后 3 秒刷新</p>
        <p>
          权益：{account.snapshot?.equity ?? '—'} USDT · 可用：
          {account.snapshot?.availableBalance ?? '—'} USDT
        </p>
        <p className="muted">
          {account.snapshot ? time(account.snapshot.queriedAt) : '尚无成功查询'}
          {account.stale ? ' · 数据待更新' : ''}
        </p>
        {account.message && <p role="status">{account.message}</p>}
      </section>
      <section className="plan-module" aria-label="开仓计划">
        <form
          className="draft-form"
          onSubmit={(event) => {
            event.preventDefault();
            void generate();
          }}
        >
          <div className="field-grid">
            <label className="field">
              <span className="field-label">合约</span>
              <select
                aria-label="合约"
                className="field-control"
                value={input.symbol}
                onChange={(event) => change('symbol', event.target.value)}
              >
                <option value="">请选择</option>
                {symbols.map((symbol) => (
                  <option key={symbol}>{symbol}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">方向</span>
              <select
                aria-label="方向"
                className="field-control"
                value={input.side}
                onChange={(event) => change('side', event.target.value)}
              >
                <option value="">请选择</option>
                <option value="long">做多</option>
                <option value="short">做空</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">预算方式</span>
              <select
                aria-label="预算方式"
                className="field-control"
                value={input.budgetMode}
                onChange={(event) => change('budgetMode', event.target.value)}
              >
                <option value="amount">固定 USDT</option>
                <option value="percent">账户权益百分比</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">止损方式</span>
              <select
                aria-label="止损方式"
                className="field-control"
                value={input.stopMode}
                onChange={(event) => change('stopMode', event.target.value)}
              >
                <option value="percent">距离百分比</option>
                <option value="price">绝对价格（USDT）</option>
              </select>
            </label>
            {fields.map(([key, label]) => (
              <label className="field" key={key}>
                <span className="field-label">{label}</span>
                <input
                  className="field-control"
                  inputMode="decimal"
                  autoComplete="off"
                  value={input[key]}
                  onChange={(event) => change(key, event.target.value)}
                />
              </label>
            ))}
          </div>
          <p className="help">
            单层市价 · 逐仓 · 单向持仓 · 仅支持空仓起点。资金费与本单资金上限可留空；预算单位为{' '}
            {input.budgetMode === 'percent' ? '权益 %' : 'USDT'}，止损值单位为{' '}
            {input.stopMode === 'percent' ? '%' : 'USDT'}。
          </p>
          <section className="draft-result" aria-label="草稿">
            <h2 className="section-title">即时草稿</h2>
            <p className="help">仅作预演，不能作为正式开仓建议。</p>
            {loading && <p role="status">正在刷新账户、行情和规则…</p>}
            {draft && (
              <>
                <p>
                  <span>草稿数量：</span>
                  {draft.quantity} {market?.baseAsset}
                </p>
                <p>
                  绝对止损：{draft.stopPrice} USDT · 预算：{draft.budget} USDT
                </p>
                <p>计划亏损：{draft.plannedLoss} USDT</p>
              </>
            )}
            {preview && (
              <>
                <p>
                  资金约束后数量：{preview.quantity} {market?.baseAsset}
                </p>
                <p>资金需求：{preview.fundingRequired} USDT</p>
                <p>
                  预估强平价：{liquidationPrice(preview.liquidationPrice)} USDT · 缓冲：
                  {preview.liquidationBuffer || '—'}%
                </p>
                <p className="help">
                  {preview.liquidationIssue || '预估不等于成交后的当前强平价。'}
                </p>
              </>
            )}
            {draftError && <p>{draftError}</p>}
          </section>
          <button
            className="button"
            disabled={
              busy ||
              loading ||
              !draft ||
              !preview ||
              Boolean(preview.liquidationIssue) ||
              account.stale
            }
            type="submit"
          >
            {busy ? '刷新并保存中…' : '刷新并生成开仓卡'}
          </button>
          <button
            className="button button--secondary"
            type="button"
            disabled={busy}
            onClick={refresh}
          >
            刷新账户与行情
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </section>
      {saved && (
        <section
          ref={card}
          tabIndex={-1}
          className="entry-card"
          data-current={current}
          aria-label="本次开仓卡"
        >
          <h2 className="section-title">本次开仓卡</h2>
          <p>{saved.plan.notice}</p>
          <p role="status">{reason}</p>
          <p>
            {saved.plan.symbol} · {saved.plan.side === 'long' ? '做多' : '做空'} · 市价 ·{' '}
            {saved.plan.leverage} 倍杠杆
          </p>
          <div className="copy-row">
            <div className="copy-row__content">
              <p>开仓数量</p>
              <p className="amount amount--card amount--copy">
                {saved.plan.quantity} {saved.plan.baseAsset}
              </p>
            </div>
            <button
              className="button button--copy"
              disabled={!current}
              onClick={() => void copy(saved.plan.quantity)}
            >
              复制数量
            </button>
          </div>
          <div className="copy-row">
            <div className="copy-row__content">
              <p>绝对止损触发价</p>
              <p className="amount amount--card amount--copy">{saved.plan.stopPrice} USDT</p>
            </div>
            <button
              className="button button--copy"
              disabled={!current}
              onClick={() => void copy(saved.plan.stopPrice)}
            >
              复制止损价
            </button>
          </div>
          <p>固定预算：{saved.plan.budget} USDT</p>
          <p>
            计划亏损：{saved.plan.plannedLoss} USDT · 资金需求：{saved.plan.fundingRequired} USDT
          </p>
          <p>
            预估强平价：{liquidationPrice(saved.plan.liquidationPrice)} USDT · 强平缓冲：
            {saved.plan.liquidationBuffer}%
          </p>
          <p>
            资金费：{saved.plan.fundingReserved ? `${saved.plan.funding} USDT` : '未预留资金费'}
          </p>
          <p className="help">
            在 Binance
            手动设置逐仓、单向持仓和所选杠杆，市价开仓并附带整仓止损市价；使用标记价触发，关闭价格保护。所有交易均由你执行。
          </p>
          <p className="help">
            当前仅提供生成时点方案；成交核验与刷新后的本单恢复尚未开放。输入变化、离开页面或数据失效后停用复制。已有持仓时不要重新生成。
          </p>
          <p className="muted">生成时间（北京时间）：{time(saved.plan.queriedAt)}</p>
          <p role="status">{copied}</p>
        </section>
      )}
    </>
  );
}
