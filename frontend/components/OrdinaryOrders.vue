<script setup lang="ts">
import { computed, ref } from 'vue';
import type { OrdersSnapshot } from '../../src/orders.ts';
import { parseDecimal } from '../../public/draft.js';

const props = defineProps<{
  orders: OrdersSnapshot | null;
  stale: boolean;
  status: string;
  attemptedAt: string;
}>();
const filter = ref('');
const filtered = computed(() =>
  (props.orders?.orders ?? [])
    .filter((o) => o.symbol.includes(filter.value.trim().toUpperCase()))
    .toSorted(
      (a, b) =>
        a.symbol.localeCompare(b.symbol) ||
        a.positionSide.localeCompare(b.positionSide) ||
        (BigInt(a.orderId) < BigInt(b.orderId)
          ? -1
          : BigInt(a.orderId) > BigInt(b.orderId)
            ? 1
            : 0),
    ),
);
const quantities = [
  ['origQty', '原数量'],
  ['executedQty', '已成交量'],
  ['remainingQty', '剩余量'],
] as const;
function time(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知 · 未返回';
}
function price(value: string | null) {
  return value === null ? '未知 · 未返回' : `${value} USDT`;
}
</script>

<template>
  <section class="orders" aria-labelledby="orders-heading">
    <h2 id="orders-heading" class="section-title">普通活跃委托</h2>
    <p class="muted">包含部分成交后剩余委托；本列表数量不包含条件委托。</p>
    <p class="orders__status" :data-stale="stale" aria-live="polite">{{ status }}</p>
    <p class="muted">
      普通委托成功查询：{{ orders ? time(orders.queriedAt) : '尚无' }} · 最近尝试：{{
        attemptedAt ? time(attemptedAt) : '尚无'
      }}
    </p>
    <label class="field orders__filter">
      <span class="field-label">筛选普通委托标的</span>
      <input
        v-model="filter"
        class="field-control"
        type="search"
        placeholder="例如 BTCUSDT"
        autocomplete="off"
      />
    </label>
    <p v-if="orders" class="muted">
      显示 {{ filtered.length }} / 全账户 {{ orders.orders.length }} 张普通委托
    </p>
    <p v-if="!orders" class="muted">尚无成功普通委托数据，不能确认是否有挂单。</p>
    <p v-else-if="!orders.orders.length" class="muted">
      {{
        stale ? '上次成功查询无普通委托，当前状态未知。' : '成功查询：当前全账户无普通活跃委托。'
      }}
    </p>
    <p v-else-if="!filtered.length" class="muted">
      筛选无结果，全账户仍有 {{ orders.orders.length }} 张普通委托。
    </p>
    <article
      v-for="o in filtered"
      :key="`${o.symbol}:${o.orderId}`"
      class="order"
      :data-current="!stale"
    >
      <h3 class="section-title">
        {{ o.symbol }} · {{ o.side === 'BUY' ? '买入' : '卖出' }} ·
        {{
          o.positionSide === 'BOTH' ? '单向（BOTH）' : o.positionSide === 'LONG' ? '多头' : '空头'
        }}
      </h3>
      <dl class="details details--account">
        <div class="details__row">
          <dt class="details__term">订单类型</dt>
          <dd class="details__value">
            {{ o.type === 'LIMIT' ? '限价（LIMIT）' : '市价（MARKET）' }}
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">委托价</dt>
          <dd class="details__value">
            {{ o.type === 'MARKET' ? '不适用 · 市价' : price(o.price) }}
          </dd>
        </div>
        <div v-for="[field, label] in quantities" :key="field" class="details__row">
          <dt class="details__term">{{ label }}</dt>
          <dd class="details__value">{{ o[field] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">当前状态</dt>
          <dd class="details__value">
            {{ o.status === 'NEW' ? '待成交（NEW）' : '部分成交（PARTIALLY_FILLED）' }}
          </dd>
        </div>
      </dl>
      <details class="disclosure order__details">
        <summary
          class="disclosure__summary"
          role="button"
          :aria-label="`${o.symbol} 委托 ${o.orderId} 详情`"
        >
          详细设置与数据时间
        </summary>
        <dl class="details details--account">
          <div class="details__row">
            <dt class="details__term">委托标识</dt>
            <dd class="details__value">{{ o.orderId }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">创建时间</dt>
            <dd class="details__value">{{ time(o.createdAt) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">更新时间</dt>
            <dd class="details__value">{{ time(o.updatedAt) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">成交均价</dt>
            <dd class="details__value">
              {{
                parseDecimal(o.executedQty, '已成交量') === 0n
                  ? '不适用 · 尚未成交'
                  : price(o.avgPrice)
              }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">只减仓</dt>
            <dd class="details__value">
              {{ o.reduceOnly === null ? '未知 · 未返回' : o.reduceOnly ? '是' : '否' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">有效方式</dt>
            <dd class="details__value">
              {{ o.type === 'MARKET' ? '不适用 · 市价' : (o.timeInForce ?? '未知 · 未返回') }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">普通委托查询时间</dt>
            <dd class="details__value">
              {{ time(orders?.queriedAt) }}{{ stale ? ' · 已过期' : '' }}
            </dd>
          </div>
        </dl>
      </details>
    </article>
    <p class="footnote">
      委托从活跃列表消失，只表示本次未返回该记录；不推断成交、撤销、过期或已实现盈亏。
    </p>
  </section>
</template>
