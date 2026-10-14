<script setup lang="ts">
import { nextTick } from 'vue';
import type { ReviewTrade } from '../../src/review-ledger.ts';
import PlanComparison from './PlanComparison.vue';
import TradeChart from './TradeChart.vue';
import TradeAnalysis from './TradeAnalysis.vue';
import {
  reviewTime as time,
  reviewAmount as amount,
  reviewDuration as duration,
} from '../review-records';
defineProps<{ trade: ReviewTrade; analysisQuery: string }>();
const orderTypes: Record<string, string> = {
  LIMIT: '限价单',
  MARKET: '市价单',
  STOP: '止损限价单',
  STOP_MARKET: '止损市价单',
  TAKE_PROFIT: '止盈限价单',
  TAKE_PROFIT_MARKET: '止盈市价单',
  TRAILING_STOP_MARKET: '追踪止损单',
};
const events = { entry: '开仓', add: '加仓', reduce: '减仓', exit: '平仓' };
function executionType(value: ReviewTrade, entry: boolean) {
  const fills = value.evidence.fills.filter((fill) =>
    value.groupingVersion === 2
      ? entry
        ? fill.event === 'entry' || fill.event === 'add'
        : fill.event === 'reduce' || fill.event === 'exit'
      : value.side !== null && (fill.side === (value.side === 'long' ? 'BUY' : 'SELL')) === entry,
  );
  const types = [
    ...new Set(
      fills.map((fill) => {
        const type = value.evidence.orders.find((order) => order.id === fill.orderId)?.type;
        return type ? (orderTypes[type] ?? type) : '未知';
      }),
    ),
  ];
  return types.length > 1 ? `混合（${types.join('、')}）` : (types[0] ?? '未知');
}
async function focusFill(index: number) {
  const target = document.getElementById(`trade-fill-${index}`);
  const disclosure = target?.closest('details');
  if (disclosure) disclosure.open = true;
  await nextTick();
  target?.focus();
}
</script>

<template>
  <section
    id="trade-detail"
    class="review-page__detail"
    tabindex="-1"
    aria-labelledby="trade-detail-title"
  >
    <h2 id="trade-detail-title" class="section-title">{{ trade.symbol }} · 单笔交易详情</h2>
    <p class="muted"><span>交易所事实</span> · 北京时间</p>
    <dl class="details details--card">
      <div class="details__row">
        <dt class="details__term">已实现盈亏</dt>
        <dd class="details__value">{{ amount(trade.realizedPnl) }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">手续费（扣除）</dt>
        <dd class="details__value">{{ amount(trade.commission) }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">资金费净收支</dt>
        <dd class="details__value">{{ amount(trade.fundingNet) }}</dd>
      </div>
      <div v-if="!trade.closedAt && trade.groupingVersion === 2" class="details__row">
        <dt class="details__term">查询时点浮动盈亏</dt>
        <dd class="details__value">
          {{ amount(trade.unrealizedPnl ?? null)
          }}<span v-if="trade.unrealizedAt"> · {{ time(trade.unrealizedAt) }}</span>
        </dd>
      </div>
      <div class="details__row details__row--risk">
        <dt class="details__term">复盘净盈亏</dt>
        <dd id="review-net-pnl" class="details__value">{{ amount(trade.netPnl) }}</dd>
      </div>
    </dl>
    <p v-if="trade.missing.length" class="error">待确认：{{ trade.missing.join('；') }}</p>
    <details class="disclosure">
      <summary class="disclosure__summary">交易概况与归并依据</summary>
      <p class="muted">
        {{ trade.source === 'demo' ? '演示' : 'Binance' }} · {{ trade.accountId }}
      </p>
      <p class="muted">交易身份：{{ trade.id }} · 归并版本 {{ trade.groupingVersion }}</p>
      <p class="muted">
        {{
          trade.evidence.startPosition === '0' &&
          trade.evidence.endPosition === '0' &&
          trade.evidence.fillsComplete
            ? '已对账空仓起点与终点'
            : trade.status === 'open'
              ? '持仓中 · 已对账空仓起点与查询时点持仓'
              : '交易片段 · 起点或退出待确认'
        }}
        · {{ trade.side === null ? '方向待确认' : trade.side === 'long' ? '做多' : '做空' }}
      </p>
      <p class="muted">
        退出原因：{{
          trade.exitReason === 'LIQUIDATION' ? '强平' : trade.exitReason === 'ADL' ? 'ADL' : '未知'
        }}
      </p>
      <p class="muted">
        入场类型：{{ executionType(trade, true) }} · 退出类型：{{ executionType(trade, false) }}
      </p>
      <p class="muted">开仓：{{ time(trade.openedAt) }} · 平仓：{{ time(trade.closedAt) }}</p>
      <p class="muted">
        持仓时长：{{ duration(trade.openedAt, trade.closedAt ?? trade.observedAt ?? null)
        }}<span v-if="!trade.closedAt && trade.observedAt"
          >（截至 {{ time(trade.observedAt) }}）</span
        >
      </p>
      <p class="muted">历史杠杆：未知 · 保证金模式：未知</p>
    </details>
    <details class="disclosure">
      <summary class="disclosure__summary">原方案与执行对照</summary>
      <PlanComparison
        v-if="trade.planComparison"
        :comparison="trade.planComparison"
        :base-asset="trade.baseAsset"
      />
      <p v-else class="muted">
        原方案：未关联 · 缺少原方案对照证据，预算、入场与历史止损偏离无法判断。
      </p>
    </details>
    <TradeChart :trade="trade" @fill="focusFill" />
    <TradeAnalysis :trade="trade" :query="analysisQuery" />
    <details class="disclosure">
      <summary class="disclosure__summary">
        订单证据 · {{ trade.evidence.orders.length }} 张
      </summary>
      <article v-for="order in trade.evidence.orders" :key="order.id" class="review-order">
        <h3 class="section-title">{{ order.id }}</h3>
        <p>{{ order.symbol }} · {{ order.side === 'BUY' ? '买入' : '卖出' }}</p>
        <p>
          {{ order.type === null ? '订单类型：未知' : (orderTypes[order.type] ?? order.type) }}
        </p>
        <p v-if="order.algoId" class="muted">条件订单：{{ order.algoId }}</p>
        <p>{{ order.quantity }} {{ trade.baseAsset }} · {{ time(order.time) }}</p>
      </article>
    </details>
    <details v-if="trade.evidence.raw?.length" class="disclosure">
      <summary class="disclosure__summary">
        关联原始证据 · {{ trade.evidence.raw.length }} 条
      </summary>
      <article
        v-for="record in trade.evidence.raw"
        :key="`${record.kind}-${record.id}`"
        class="review-fill"
      >
        <h3 class="section-title">{{ record.kind }} · {{ record.id }}</h3>
        <p class="muted">{{ time(new Date(record.time).toISOString()) }}</p>
        <p>{{ JSON.stringify(record.payload) }}</p>
      </article>
    </details>
    <details class="disclosure">
      <summary class="disclosure__summary">逐笔成交 · {{ trade.evidence.fills.length }} 条</summary>
      <article
        v-for="(fill, index) in trade.evidence.fills"
        :id="`trade-fill-${index}`"
        :key="fill.id"
        class="review-fill"
        tabindex="-1"
      >
        <h3 class="section-title">{{ fill.id }}</h3>
        <p>
          原始成交：{{ fill.id
          }}<span v-if="fill.allocation">
            · {{ fill.allocation === 'close' ? '反手平仓分配' : '反手开仓分配' }}</span
          >
        </p>
        <p v-if="fill.event">{{ events[fill.event] }}</p>
        <p>订单：{{ fill.orderId }} · {{ fill.symbol }}</p>
        <p>{{ fill.side === 'BUY' ? '买入' : '卖出' }} · {{ time(fill.time) }}</p>
        <p>{{ fill.quantity }} {{ trade.baseAsset }} × {{ fill.price }} USDT</p>
        <p>已实现盈亏：{{ amount(fill.realizedPnl) }}</p>
        <p>手续费：{{ amount(fill.commission, fill.commissionAsset) }}</p>
      </article>
    </details>
    <details class="disclosure">
      <summary class="disclosure__summary">
        资金费流水 · {{ trade.evidence.funding.length }} 条
      </summary>
      <article v-for="fee in trade.evidence.funding" :key="fee.id" class="review-funding">
        <h3 class="section-title">{{ fee.id }}</h3>
        <p>{{ fee.symbol }} · {{ time(fee.time) }}</p>
        <p>{{ amount(fee.amount, fee.asset) }}</p>
        <p v-if="fee.attribution === 'ambiguous'" class="muted">归属待确认 · 不计入已确认净盈亏</p>
        <p class="muted">正数为收入，负数为支出</p>
      </article>
    </details>
  </section>
</template>
