<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Position, LastPrice, Funding, MarketPart } from '../../src/positions.ts';
import { parseDecimal } from '../../public/draft.js';

type MarketState<T> = {
  snapshot: Extract<MarketPart<T>, { status: 'ok' }> | null;
  stale: boolean;
  error: string;
};
const props = defineProps<{
  positions: { queriedAt: string; data: Position[] } | null;
  stale: boolean;
  status: string;
  attemptedAt: string;
  last: MarketState<LastPrice>;
  funding: MarketState<Funding>;
}>();
const filter = ref('');
const filtered = computed(
  () =>
    props.positions?.data.filter((p) => p.symbol.includes(filter.value.trim().toUpperCase())) ?? [],
);
const lastPrices = computed(() => new Map(props.last.snapshot?.data.map((p) => [p.symbol, p])));
const fundingRates = computed(
  () => new Map(props.funding.snapshot?.data.map((p) => [p.symbol, p])),
);
const mainFields = [
  ['quantity', '持仓数量'],
  ['entryPrice', '入场均价'],
  ['markPrice', '标记价'],
] as const;
const detailFields = [
  ['notional', '仓位名义价值'],
  ['liquidationPrice', '当前强平价'],
  ['breakEvenPrice', '保本价'],
] as const;
function time(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知 · 未返回';
}
function amount(value: string | null | undefined) {
  return value === null || value === undefined ? '未知 · 未返回' : `${value} USDT`;
}
function pnl(value: string) {
  return parseDecimal(value.replace('-', ''), '盈亏') > 0n && !value.startsWith('-')
    ? `+${value}`
    : value;
}
function pnlState(value: string) {
  return parseDecimal(value.replace('-', ''), '盈亏') === 0n
    ? 'zero'
    : value.startsWith('-')
      ? 'loss'
      : 'profit';
}
</script>

<template>
  <section class="positions" aria-labelledby="positions-heading">
    <h2 id="positions-heading" class="section-title">当前持仓</h2>
    <p class="muted">
      未实现盈亏采用交易所查询值，未扣手续费与资金费；绿色 + 为盈利，红色 − 为亏损。
    </p>
    <p class="positions__status" :data-stale="stale" aria-live="polite">{{ status }}</p>
    <p class="muted">
      持仓成功查询：{{ positions ? time(positions.queriedAt) : '尚无' }} · 最近尝试：{{
        attemptedAt ? time(attemptedAt) : '尚无'
      }}
    </p>
    <label class="field positions__filter">
      <span class="field-label">筛选持仓标的</span>
      <input
        v-model="filter"
        class="field-control"
        type="search"
        placeholder="例如 BTCUSDT"
        autocomplete="off"
      />
    </label>
    <p v-if="positions" class="muted">
      显示 {{ filtered.length }} / 全账户 {{ positions.data.length }} 份持仓
    </p>
    <p v-if="!positions" class="muted">尚无成功持仓数据，不能确认是否空仓。</p>
    <p v-else-if="!positions.data.length" class="muted">
      {{ stale ? '上次成功查询为空仓，当前状态未知。' : '成功查询：当前全账户空仓。' }}
    </p>
    <p v-else-if="!filtered.length" class="muted">
      筛选无结果，全账户仍有 {{ positions.data.length }} 份持仓。
    </p>
    <article
      v-for="p in filtered"
      :key="`${p.symbol}:${p.positionSide}`"
      class="position"
      :data-current="!stale"
    >
      <div class="position__heading">
        <h3 class="section-title">
          {{ p.symbol }} · {{ p.direction === 'LONG' ? '多头' : '空头' }}
        </h3>
        <span class="tag"
          >{{ p.marginType === 'cross' ? '全仓' : '逐仓' }} · {{ p.leverage }}× ·
          {{ p.positionSide === 'BOTH' ? '单向' : '双向' }}</span
        >
      </div>
      <p class="position__pnl-label">未实现盈亏</p>
      <p class="amount position__pnl" :data-pnl="pnlState(p.unrealizedProfit)">
        {{ pnl(p.unrealizedProfit) }} USDT
      </p>
      <dl class="details details--account">
        <div v-for="[field, label] in mainFields" :key="field" class="details__row">
          <dt class="details__term">{{ label }}</dt>
          <dd class="details__value">{{ field === 'quantity' ? p[field] : amount(p[field]) }}</dd>
        </div>
      </dl>
      <details class="disclosure position__details">
        <summary
          class="disclosure__summary"
          role="button"
          :aria-label="`${p.symbol} ${p.direction === 'LONG' ? '多头' : '空头'}详情`"
        >
          详细参数与数据时间
        </summary>
        <dl class="details details--account">
          <div v-for="[field, label] in detailFields" :key="field" class="details__row">
            <dt class="details__term">{{ label }}</dt>
            <dd class="details__value">{{ amount(p[field]) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">逐仓资金（钱包）</dt>
            <dd class="details__value">
              {{ p.marginType === 'cross' ? '不适用 · 全仓' : amount(p.isolatedWallet) }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">持仓更新时间</dt>
            <dd class="details__value">{{ time(p.updatedAt) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">持仓查询时间</dt>
            <dd class="details__value">
              {{ time(positions?.queriedAt) }}{{ stale ? ' · 已过期' : '' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">最新成交价</dt>
            <dd class="details__value">
              {{ amount(lastPrices.get(p.symbol)?.price)
              }}{{ last.stale && last.snapshot ? ' · 已过期' : '' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">成交价查询时间</dt>
            <dd class="details__value">
              {{ time(last.snapshot?.queriedAt)
              }}{{ last.stale && last.snapshot ? ' · 已过期' : '' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">成交价数据时间</dt>
            <dd class="details__value">{{ time(lastPrices.get(p.symbol)?.updatedAt) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">资金费率（小数）</dt>
            <dd class="details__value">
              {{ fundingRates.get(p.symbol)?.rate ?? '未知 · 未返回'
              }}{{ funding.stale && funding.snapshot ? ' · 已过期' : '' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">下次结算时间</dt>
            <dd class="details__value">
              {{ time(fundingRates.get(p.symbol)?.nextFundingAt)
              }}{{ funding.stale && funding.snapshot ? ' · 已过期' : '' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">资金费查询时间</dt>
            <dd class="details__value">
              {{ time(funding.snapshot?.queriedAt)
              }}{{ funding.stale && funding.snapshot ? ' · 已过期' : '' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">资金费数据时间</dt>
            <dd class="details__value">{{ time(fundingRates.get(p.symbol)?.updatedAt) }}</dd>
          </div>
        </dl>
        <p v-if="last.error" class="muted">
          最新成交价：{{ last.error }}
          {{ last.snapshot ? '保留旧值与原时间，已过期。' : '未知，尚无成功数据。' }}
        </p>
        <p v-if="funding.error" class="muted">
          资金费：{{ funding.error }}
          {{ funding.snapshot ? '保留旧值与原时间，已过期。' : '未知，尚无成功数据。' }}
        </p>
      </details>
    </article>
    <p class="footnote">各分项分别查询，时间可能不同；列表变化不推断历史成交或退出原因。</p>
  </section>
</template>
