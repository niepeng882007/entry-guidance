<script setup lang="ts">
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
  errorDetail,
  refreshProgress,
  refreshPause,
  refresh,
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
  <div class="account-page">
    <header class="page-header">
      <h1 class="page-title">账户快照</h1>
      <div class="account-page__actions">
        <div class="account-page__refresh">
          <span v-if="busy" class="muted" aria-live="polite">刷新中…</span>
          <span v-else-if="refreshPause" class="muted">{{ refreshPause }}</span>
          <svg
            v-else
            class="account-page__countdown"
            viewBox="0 0 24 24"
            role="img"
            :aria-label="`自动刷新倒计时：${Math.ceil(30 * refreshProgress)} 秒后刷新`"
          >
            <circle class="account-page__countdown-track" cx="12" cy="12" r="9" />
            <circle
              class="account-page__countdown-progress"
              cx="12"
              cy="12"
              r="9"
              pathLength="100"
              stroke-dasharray="100"
              :stroke-dashoffset="100 * (1 - refreshProgress)"
            />
          </svg>
        </div>
        <button
          class="button button--secondary"
          type="button"
          :disabled="busy || relogin"
          :aria-busy="busy"
          @click="refresh()"
        >
          手动刷新
        </button>
      </div>
    </header>
    <p v-if="expectedSource === 'demo'" class="source">{{ source }}</p>
    <div v-if="stale && status" class="status" data-state="error" role="status">
      <p class="status__message">{{ status }}</p>
      <a class="button button--text button--link" href="/login" :hidden="!relogin">重新登录</a>
      <details v-if="errorDetail" :key="errorDetail" class="disclosure">
        <summary class="disclosure__summary">错误详情</summary>
        <p class="status__message account-page__error-detail">{{ errorDetail }}</p>
      </details>
    </div>
    <div class="balances balances--assets" :data-current="!stale">
      <section class="balance">
        <h2 class="section-title">账户权益 <span class="balance__unit">USDT</span></h2>
        <p id="asset-equity" class="amount">{{ snapshot?.equity ?? '—' }}</p>
        <details class="disclosure disclosure--help">
          <summary class="disclosure__summary" aria-label="账户权益说明">说明</summary>
          <p class="help">钱包余额 + 未实现盈亏。</p>
        </details>
      </section>
      <section class="balance">
        <h2 class="section-title">可用余额 <span class="balance__unit">USDT</span></h2>
        <p id="asset-available" class="amount">{{ snapshot?.availableBalance ?? '—' }}</p>
        <details class="disclosure disclosure--help">
          <summary class="disclosure__summary" aria-label="可用余额说明">说明</summary>
          <p class="help">可用于开仓的余额，已计入现有资金占用。</p>
        </details>
      </section>
      <section class="balance">
        <h2 class="section-title">未实现盈亏 <span class="balance__unit">USDT</span></h2>
        <p id="asset-pnl" class="amount">{{ snapshot?.unrealizedProfit ?? '—' }}</p>
        <details class="disclosure disclosure--help">
          <summary class="disclosure__summary" aria-label="未实现盈亏说明">说明</summary>
          <p class="help">当前持仓的浮动盈亏，未扣手续费与资金费。</p>
        </details>
      </section>
    </div>
    <details class="disclosure account-page__details" open>
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
  </div>
</template>
