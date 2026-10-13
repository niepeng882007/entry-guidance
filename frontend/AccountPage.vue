<script setup lang="ts">
import CurrentPositions from './components/CurrentPositions.vue';
import { useAccountPage } from './useAccountPage.ts';

const { source, expectedSource } = defineProps<{
  source: string;
  expectedSource: 'binance' | 'demo';
}>();
const {
  snapshot,
  attemptedAt,
  busy,
  stale,
  relogin,
  status,
  refresh,
  positions,
  positionsStale,
  positionsStatus,
  last,
  funding,
} = useAccountPage(expectedSource);
const detailFields = [
  ['walletBalance', '钱包余额'],
  ['positionInitialMargin', '持仓初始保证金'],
  ['openOrderInitialMargin', '委托初始保证金'],
  ['maintMargin', '维持保证金'],
  ['maxWithdrawAmount', '可转出额'],
] as const;

function amount(value: string | null | undefined) {
  if (!snapshot.value) return '等待查询';
  return value === null ? '未知 · 未返回' : `${value} USDT`;
}

function time(value: string | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无';
}
</script>

<template>
  <main class="page account-page">
    <nav class="account-page__nav" aria-label="账户页面">
      <a class="button button--text button--link" href="/">返回工作台</a>
      <a class="button button--text button--link" href="/review">交易复盘</a>
      <form action="/logout" method="post">
        <button class="button button--text" type="submit">退出登录</button>
      </form>
    </nav>
    <header class="page-header">
      <h1 class="page-title">账户快照</h1>
      <span class="tag">USDT · 只读</span>
    </header>
    <p class="source">{{ source }}</p>
    <div class="status" :data-state="stale ? 'error' : 'success'" role="status">
      <p class="status__message">{{ status }}</p>
      <p class="muted" :hidden="!busy">正在查询…</p>
      <a class="button button--text button--link" href="/login" :hidden="!relogin">重新登录</a>
    </div>
    <div class="section-heading">
      <p class="muted section-heading__note">正常前台每 3 秒刷新</p>
      <button
        class="button button--secondary"
        type="button"
        :disabled="busy || relogin"
        :aria-busy="busy"
        @click="refresh"
      >
        手动刷新
      </button>
    </div>
    <div class="balances balances--assets" :data-current="!stale">
      <section class="balance">
        <h2 class="section-title">账户权益 <span class="balance__unit">USDT</span></h2>
        <p id="asset-equity" class="amount">{{ snapshot?.equity ?? '—' }}</p>
        <p class="muted balance__caption">钱包余额 + 未实现盈亏</p>
      </section>
      <section class="balance">
        <h2 class="section-title">可用余额 <span class="balance__unit">USDT</span></h2>
        <p id="asset-available" class="amount">{{ snapshot?.availableBalance ?? '—' }}</p>
        <p class="muted balance__caption">交易所返回值，不重复扣除占款</p>
      </section>
      <section class="balance">
        <h2 class="section-title">未实现盈亏 <span class="balance__unit">USDT</span></h2>
        <p id="asset-pnl" class="amount">{{ snapshot?.unrealizedProfit ?? '—' }}</p>
        <p class="muted balance__caption">查询值，未扣手续费与资金费</p>
      </section>
    </div>
    <details class="disclosure account-page__details">
      <summary class="disclosure__summary">资金占用与查询信息</summary>
      <dl class="details details--account">
        <div v-for="[field, label] in detailFields" :key="field" class="details__row">
          <dt class="details__term">{{ label }}</dt>
          <dd class="details__value">{{ amount(snapshot?.[field]) }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">成功查询时间</dt>
          <dd id="asset-queried" class="details__value">{{ time(snapshot?.queriedAt) }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">最近尝试时间</dt>
          <dd id="asset-attempted" class="details__value">{{ time(attemptedAt) }}</dd>
        </div>
      </dl>
    </details>
    <CurrentPositions
      :positions="positions"
      :stale="positionsStale"
      :status="positionsStatus"
      :attempted-at="attemptedAt"
      :last="last"
      :funding="funding"
    />
    <p class="footnote">账户快照不代表后续状态，也不表示止损核验通过。交易由你在 Binance 执行。</p>
  </main>
</template>
