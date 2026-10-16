import { useEffect, useRef } from 'react';
import type { ReviewTrade } from '../../../src/review-ledger.ts';
import { executionTypes, entryTypeLabel, orderTypes } from '../../../src/review-filters.ts';
import {
  reviewTime as time,
  reviewAmount as amount,
  reviewDuration as duration,
} from '../../../frontend/review-records.ts';
const events = { entry: '开仓', add: '加仓', reduce: '减仓', exit: '平仓' };
export default function TradeDetail({ trade }: { trade: ReviewTrade }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    section.current?.focus();
  }, [trade.id]);
  return (
    <section
      ref={section}
      id="trade-detail"
      className="review-page__detail"
      tabIndex={-1}
      aria-labelledby="trade-detail-title"
    >
      <h2 id="trade-detail-title" className="section-title">
        {trade.symbol} · 单笔交易详情
      </h2>
      <p className="muted">{trade.source === 'demo' ? '合成演示事实' : '交易所事实'} · 北京时间</p>
      <dl className="details details--card">
        {(
          [
            ['已实现盈亏', trade.realizedPnl],
            ['手续费（扣除）', trade.commission],
            ['资金费净收支', trade.fundingNet],
            ['复盘净盈亏', trade.netPnl],
          ] as const
        ).map(([label, value]) => (
          <div className="details__row" key={label}>
            <dt className="details__term">{label}</dt>
            <dd
              className="details__value"
              id={label === '复盘净盈亏' ? 'review-net-pnl' : undefined}
            >
              {amount(value)}
            </dd>
          </div>
        ))}
      </dl>
      {trade.missing.length > 0 && <p className="error">待确认：{trade.missing.join('；')}</p>}
      {!trade.closedAt && (
        <p>
          查询时点浮动盈亏：{amount(trade.unrealizedPnl ?? null)} ·{' '}
          {time(trade.unrealizedAt ?? null)}
        </p>
      )}
      <details className="disclosure">
        <summary className="disclosure__summary">交易概况与归并依据</summary>
        <p>
          账户：{trade.accountId} · 交易身份：{trade.id} · 归并版本 {trade.groupingVersion}
        </p>
        <p>
          {trade.evidence.startPosition === '0' &&
          trade.evidence.endPosition === '0' &&
          trade.evidence.fillsComplete
            ? '已对账空仓起点与终点'
            : '交易片段 · 起点或退出待确认'}
        </p>
        <p>方向：{trade.side === 'long' ? '做多' : trade.side === 'short' ? '做空' : '待确认'}</p>
        <p>
          开仓：{time(trade.openedAt)} · 平仓：{time(trade.closedAt)}
        </p>
        <p>持仓时长：{duration(trade.openedAt, trade.closedAt ?? trade.observedAt ?? null)}</p>
        <p>
          入场类型：{executionTypes(trade, true).map(entryTypeLabel).join('、')} · 退出类型：
          {executionTypes(trade, false).map(entryTypeLabel).join('、')}
        </p>
        <p>
          退出原因：
          {trade.exitReason === 'LIQUIDATION'
            ? '强平'
            : trade.exitReason === 'ADL'
              ? 'ADL'
              : '未知'}
        </p>
      </details>
      <details className="disclosure">
        <summary className="disclosure__summary">
          订单证据 · {trade.evidence.orders.length} 张
        </summary>
        {trade.evidence.orders.map((order) => (
          <article className="review-order" key={order.id}>
            <h3 className="section-title">{order.id}</h3>
            <p>
              {order.symbol} · {order.side === 'BUY' ? '买入' : '卖出'}
            </p>
            <p>
              {order.type
                ? (orderTypes[order.type as keyof typeof orderTypes] ?? order.type)
                : '订单类型：未知'}
            </p>
            {order.algoId && <p>条件订单：{order.algoId}</p>}
            <p>
              {order.quantity} {trade.baseAsset} · {time(order.time)}
            </p>
          </article>
        ))}
      </details>
      <details className="disclosure">
        <summary className="disclosure__summary">
          逐笔成交 · {trade.evidence.fills.length} 条
        </summary>
        {trade.evidence.fills.map((fill, index) => (
          <article className="review-fill" key={`${fill.id}:${index}`} tabIndex={-1}>
            <h3 className="section-title">原始成交：{fill.id}</h3>
            {fill.allocation && (
              <p>{fill.allocation === 'close' ? '反手平仓分配' : '反手开仓分配'}</p>
            )}
            <p>
              {fill.event && events[fill.event]} · {fill.positionSide} · 订单：{fill.orderId}
            </p>
            <p>
              {fill.side === 'BUY' ? '买入' : '卖出'} · {time(fill.time)}
            </p>
            <p>
              {fill.quantity} {trade.baseAsset} × {fill.price} USDT
            </p>
            <p>已实现盈亏：{amount(fill.realizedPnl)}</p>
            <p>手续费：{amount(fill.commission, fill.commissionAsset)}</p>
          </article>
        ))}
      </details>
      <details className="disclosure">
        <summary className="disclosure__summary">
          资金费流水 · {trade.evidence.funding.length} 条
        </summary>
        {trade.evidence.funding.map((fee) => (
          <article className="review-funding" key={fee.id}>
            <h3 className="section-title">{fee.id}</h3>
            <p>
              {fee.symbol} · {time(fee.time)}
            </p>
            <p>{amount(fee.amount, fee.asset)}</p>
            {fee.attribution === 'ambiguous' && <p>归属待确认 · 不计入已确认净盈亏</p>}
          </article>
        ))}
        <p className="muted">正数为收入，负数为支出；是否完整以缺口说明为准。</p>
      </details>
      <details className="disclosure">
        <summary className="disclosure__summary">
          关联原始证据 · {trade.evidence.raw?.length ?? 0} 条
        </summary>
        {trade.evidence.raw?.map((record, index) => (
          <article className="review-fill" key={`${record.kind}:${record.id}:${index}`}>
            <h3 className="section-title">
              {record.kind} · {record.id}
            </h3>
            <p>{time(new Date(record.time).toISOString())}</p>
            <pre className="review-backup__json">{JSON.stringify(record.payload, null, 2)}</pre>
          </article>
        ))}
      </details>
    </section>
  );
}
