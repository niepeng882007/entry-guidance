'use client';
import type { MouseEvent } from 'react';
import {
  reviewUrl,
  reviewTime,
  reviewAmount,
  type ReviewLocation,
} from '../../../frontend/review-records.ts';
import { useReviewBrowser } from './use-review-browser.ts';
import TradeDetail from './trade-detail.tsx';

export default function ReviewBrowser() {
  const { owner, visible, data, location, busy, message, actions } = useReviewBrowser();
  function navigate(event: MouseEvent<HTMLAnchorElement>, next: ReviewLocation) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    actions.current.navigate(next);
  }
  const list = data && 'trades' in data ? data : null;
  const detail = data && 'trade' in data ? data.trade : null;
  const back = { ...location, tradeId: null };
  return (
    <main className="page review-page">
      <header className="page-header">
        <h1 className="page-title">完整交易</h1>
        <button className="button button--secondary" onClick={() => actions.current.logout()}>
          退出登录
        </button>
      </header>
      <nav aria-label="工作台导航">
        <a className="button button--text" href="/dashboard">
          返回工作台
        </a>
        <a className="button button--text" href="/dashboard/connections">
          连接设置
        </a>
      </nav>
      <p role="status" className="review-page__status">
        {message || (busy ? '正在读取…' : !visible ? '正在确认身份…' : '')}
      </p>
      {!visible && (
        <button
          className="button"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) actions.current.read();
          }}
        >
          重新读取
        </button>
      )}
      {owner && (
        <div hidden={!visible}>
          <p className="muted">
            {owner.profile.name} · {owner.profile.email}
            {owner.binding && ` · UID ${owner.binding.uid}`}
          </p>
          {owner.profile.simulation && (
            <p className="review-page__source">模拟数据 · 不代表真实账户</p>
          )}
          {!owner.binding ? (
            <p>尚未绑定 Binance 账户，请前往连接设置。</p>
          ) : (
            <>
              <p className="muted">
                {data?.coverage ?? '仅展示本账户已归档记录；未读取或未发现的历史范围仍待确认。'}
              </p>
              {data && <p className="muted">账本读取于 {reviewTime(data.readAt)}（北京时间）</p>}
              {location.tradeId ? (
                <>
                  <a
                    className="button button--text review-page__back"
                    href={reviewUrl(back)}
                    onClick={(event) => navigate(event, back)}
                  >
                    返回完整交易
                  </a>
                  <button
                    className="button button--secondary"
                    aria-disabled={busy}
                    onClick={() => {
                      if (!busy) actions.current.read();
                    }}
                  >
                    重新读取
                  </button>
                  {detail && <TradeDetail trade={detail} />}
                </>
              ) : (
                <>
                  <form
                    className="review-filters"
                    aria-label="完整交易筛选"
                    key={`${location.from}:${location.to}:${location.symbol}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const fields = new FormData(event.currentTarget);
                      actions.current.navigate({
                        ...location,
                        from: String(fields.get('from') ?? ''),
                        to: String(fields.get('to') ?? ''),
                        symbol: String(fields.get('symbol') ?? ''),
                        page: 1,
                      });
                    }}
                  >
                    <div className="field">
                      <label className="field-label" htmlFor="cycle-from">
                        开仓日期从
                      </label>
                      <input
                        className="field-control review-filters__control"
                        id="cycle-from"
                        name="from"
                        type="date"
                        defaultValue={location.from}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="cycle-to">
                        开仓日期至
                      </label>
                      <input
                        className="field-control review-filters__control"
                        id="cycle-to"
                        name="to"
                        type="date"
                        defaultValue={location.to}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="cycle-symbol">
                        交易对
                      </label>
                      <input
                        className="field-control review-filters__control"
                        id="cycle-symbol"
                        name="symbol"
                        list="cycle-symbols"
                        defaultValue={location.symbol}
                        placeholder="全部交易对"
                      />
                      <datalist id="cycle-symbols">
                        {list?.options.symbols.map((symbol) => (
                          <option key={symbol} value={symbol} />
                        ))}
                      </datalist>
                    </div>
                    <div className="review-filters__actions">
                      <button className="button" type="submit">
                        筛选
                      </button>
                    </div>
                    <p className="muted review-filters__hint">
                      北京时间，包含首尾整天；默认全部已归档记录。
                    </p>
                  </form>
                  <section className="review-table-panel" aria-label="完整交易列表">
                    <div className="review-table-panel__toolbar">
                      <p className="muted">
                        {list
                          ? `${message ? '上次匹配' : '当前匹配'} ${list.total} 笔完整交易`
                          : '尚未读取账本'}
                      </p>
                      <button
                        className="button button--secondary"
                        aria-disabled={busy}
                        onClick={() => {
                          if (!busy) actions.current.read();
                        }}
                      >
                        重新读取
                      </button>
                    </div>
                    <p className="review-table__hint">左右滑动查看更多；每页 20 条。</p>
                    <div
                      className="cycle-table"
                      role="region"
                      aria-label="完整交易表格"
                      tabIndex={0}
                    >
                      <table className="cycle-table__table">
                        <thead>
                          <tr>
                            {[
                              '交易对',
                              '方向',
                              '状态',
                              '净盈亏（USDT）',
                              '开仓时间（北京）',
                              '平仓时间（北京）',
                              '详情',
                            ].map((title) => (
                              <th scope="col" key={title}>
                                {title}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {list?.trades.map((trade) => {
                            const next = { ...location, tradeId: trade.id };
                            return (
                              <tr key={trade.id}>
                                <td>{trade.symbol}</td>
                                <td>
                                  {trade.side === 'long'
                                    ? '做多'
                                    : trade.side === 'short'
                                      ? '做空'
                                      : '待确认'}
                                </td>
                                <td>
                                  {trade.status === 'closed'
                                    ? '已结束'
                                    : trade.status === 'open'
                                      ? '持仓中'
                                      : '不完整'}
                                </td>
                                <td className="review-table__amount">
                                  {reviewAmount(trade.netPnl)}
                                </td>
                                <td>{reviewTime(trade.openedAt)}</td>
                                <td>{reviewTime(trade.closedAt)}</td>
                                <td>
                                  <a
                                    href={reviewUrl(next)}
                                    aria-label={`查看 ${trade.id}`}
                                    onClick={(event) => navigate(event, next)}
                                  >
                                    查看详情
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {list && !list.trades.length && (
                      <p>当前范围没有已归档记录；这不表示没有交易或全部历史已完整。</p>
                    )}
                    {list && (list.total > 20 || location.page > 1) && (
                      <nav className="review-table__pagination" aria-label="交易分页">
                        <button
                          className="button button--secondary"
                          disabled={location.page <= 1 || busy}
                          onClick={() => actions.current.navigate({ ...location, page: 1 })}
                        >
                          第一页
                        </button>
                        <button
                          className="button button--secondary"
                          disabled={location.page <= 1 || busy}
                          onClick={() =>
                            actions.current.navigate({ ...location, page: location.page - 1 })
                          }
                        >
                          上一页
                        </button>
                        <span>第 {location.page} 页</span>
                        <button
                          className="button button--secondary"
                          disabled={!list.nextPage || busy}
                          onClick={() =>
                            actions.current.navigate({ ...location, page: location.page + 1 })
                          }
                        >
                          下一页
                        </button>
                      </nav>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}
