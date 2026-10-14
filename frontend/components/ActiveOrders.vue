<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  OrdersSnapshot,
  ConditionalOrdersSnapshot,
  ConditionalOrder,
} from '../../src/orders.ts';
import { parseDecimal } from '../../public/draft.js';

const props = defineProps<{
  orders: OrdersSnapshot | null;
  conditionalOrders: ConditionalOrdersSnapshot | null;
  conditionalStale: boolean;
  conditionalStatus: string;
  stale: boolean;
  status: string;
  attemptedAt: string;
  conditionalAttemptedAt: string;
}>();
const filter = ref('');
const all = computed(() => [
  ...(props.orders?.orders ?? []).map((o) => ({ ...o, kind: 'ordinary' as const, id: o.orderId })),
  ...(props.conditionalOrders?.orders ?? []).map((o) => ({
    ...o,
    kind: 'conditional' as const,
    id: o.algoId,
  })),
]);
const filtered = computed(() =>
  all.value
    .filter((o) => o.symbol.includes(filter.value.trim().toUpperCase()))
    .toSorted(
      (a, b) =>
        a.symbol.localeCompare(b.symbol) ||
        a.positionSide.localeCompare(b.positionSide) ||
        a.kind.localeCompare(b.kind) ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0),
    ),
);
const complete = computed(
  () => props.orders && props.conditionalOrders && !props.stale && !props.conditionalStale,
);
const types = {
  LIMIT: '限价',
  MARKET: '市价',
  STOP: '止损限价',
  STOP_MARKET: '止损市价',
  TAKE_PROFIT: '止盈限价',
  TAKE_PROFIT_MARKET: '止盈市价',
  TRAILING_STOP_MARKET: '追踪止损',
};
function flag(value: boolean | null) {
  if (value === null) return '未知 · 未返回';
  return value ? '是' : '否';
}
function quantity(value: string | null) {
  return value ?? '未知 · 未返回';
}
function quantityLabel(order: ConditionalOrder) {
  if (order.closePosition === true) return '整仓退出 · 不指定固定数量';
  if (order.quantity === null) return '未知 · 未返回固定数量或整仓设置';
  return `固定数量 ${order.quantity}${order.closePosition === null ? ' · 整仓设置未知' : ''}`;
}
function orderStatus(order: (typeof all.value)[number]) {
  if (order.kind === 'ordinary')
    return order.status === 'NEW' ? '待成交（NEW）' : '部分成交（PARTIALLY_FILLED）';
  return order.status === 'NEW' ? '待触发（NEW）' : order.status;
}
function marketOrder(type: string) {
  return ['MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET'].includes(type);
}
function workingType(value: string | null) {
  if (value === null) return '未知 · 未返回';
  if (value === 'MARK_PRICE') return '标记价（MARK_PRICE）';
  if (value === 'CONTRACT_PRICE') return '最新成交价（CONTRACT_PRICE）';
  return `交易所触发依据（${value}）`;
}
function time(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知 · 未返回';
}
function price(value: string | null) {
  return value === null ? '未知 · 未返回' : `${value} USDT`;
}
</script>

<template>
  <section class="orders" aria-labelledby="orders-heading">
    <h2 id="orders-heading" class="section-title">活跃委托</h2>
    <p class="muted">普通与条件委托分别读取；止盈止损委托存在不表示已保护或核验通过。</p>
    <p class="orders__status" :data-stale="stale" aria-live="polite">{{ status }}</p>
    <p class="muted">
      普通委托成功查询：{{ orders ? time(orders.queriedAt) : '尚无' }} · 最近尝试：{{
        attemptedAt ? time(attemptedAt) : '尚无'
      }}
    </p>
    <p class="orders__status" :data-stale="conditionalStale" aria-live="polite">
      {{ conditionalStatus }}
    </p>
    <p class="muted">
      条件委托成功查询：{{ conditionalOrders ? time(conditionalOrders.queriedAt) : '尚无' }} ·
      最近尝试：{{ conditionalAttemptedAt ? time(conditionalAttemptedAt) : '尚无' }}
    </p>
    <label class="field orders__filter">
      <span class="field-label">筛选委托标的</span>
      <input
        v-model="filter"
        class="field-control"
        type="search"
        placeholder="例如 BTCUSDT"
        autocomplete="off"
      />
    </label>
    <p class="muted">
      {{ complete ? '显示' : '已知列表显示' }} {{ filtered.length }} /
      {{ complete ? '全账户' : '已知列表合计' }} {{ all.length }} 张活跃委托{{
        complete ? ' · 分别查询，非原子快照' : ' · 部分委托来源尚未确认或已过期，不能确认全账户总数'
      }}
    </p>
    <p v-if="orders" class="muted">
      显示 {{ filtered.filter((o) => o.kind === 'ordinary').length }} /
      {{ stale ? '上次全账户' : '全账户' }} {{ orders.orders.length }} 张普通委托{{
        stale ? ' · 已过期' : ''
      }}
    </p>
    <p v-if="conditionalOrders" class="muted">
      显示 {{ filtered.filter((o) => o.kind === 'conditional').length }} /
      {{ conditionalStale ? '上次全账户' : '全账户' }}
      {{ conditionalOrders.orders.length }} 张条件委托{{ conditionalStale ? ' · 已过期' : '' }}
    </p>
    <p v-if="!orders" class="muted">尚无成功普通委托数据，不能确认是否有挂单。</p>
    <p v-else-if="!orders.orders.length" class="muted">
      {{
        stale ? '上次成功查询无普通委托，当前状态未知。' : '成功查询：当前全账户无普通活跃委托。'
      }}
    </p>
    <p v-if="!conditionalOrders" class="muted">尚无成功条件委托数据，不能确认是否有条件挂单。</p>
    <p v-else-if="!conditionalOrders.orders.length" class="muted">
      {{
        conditionalStale
          ? '上次成功查询无条件委托，当前状态未知。'
          : '成功查询：当前全账户无条件活跃委托。'
      }}
    </p>
    <p v-if="complete && !all.length" class="muted">成功查询：当前全账户无活跃委托。</p>
    <p v-else-if="all.length && !filtered.length" class="muted">
      筛选无结果，{{ complete ? '全账户仍有' : '已知列表仍有' }} {{ all.length }} 张活跃委托。
    </p>
    <article
      v-for="o in filtered"
      :key="`${o.kind}:${o.symbol}:${o.id}`"
      class="order"
      :data-kind="o.kind"
      :data-current="o.kind === 'ordinary' ? !stale : !conditionalStale"
    >
      <p class="muted">
        {{ o.kind === 'ordinary' ? '普通委托' : '条件委托'
        }}{{
          (o.kind === 'ordinary' ? stale : conditionalStale)
            ? ' · 上次列表已过期'
            : ' · 查询时点记录'
        }}
      </p>
      <h3 class="section-title">
        {{ o.symbol }} · {{ o.side === 'BUY' ? '买入' : '卖出' }} ·
        {{
          o.positionSide === 'BOTH' ? '单向（BOTH）' : o.positionSide === 'LONG' ? '多头' : '空头'
        }}
      </h3>
      <dl class="details details--account">
        <div class="details__row">
          <dt class="details__term">订单类型</dt>
          <dd class="details__value">{{ types[o.type] }}（{{ o.type }}）</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">委托价</dt>
          <dd class="details__value">
            {{ marketOrder(o.type) ? '不适用 · 市价' : price(o.price) }}
          </dd>
        </div>
        <template v-if="o.kind === 'ordinary'">
          <div
            v-for="[value, label] in [
              [o.origQty, '原数量'],
              [o.executedQty, '已成交量'],
              [o.remainingQty, '剩余量'],
            ]"
            :key="label"
            class="details__row"
          >
            <dt class="details__term">{{ label }}</dt>
            <dd class="details__value">{{ value }}</dd>
          </div>
        </template>
        <template v-else>
          <div class="details__row">
            <dt class="details__term">
              {{ o.type === 'TRAILING_STOP_MARKET' ? '激活价' : '触发价' }}
            </dt>
            <dd class="details__value">
              {{ price(o.type === 'TRAILING_STOP_MARKET' ? o.activatePrice : o.triggerPrice) }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">委托数量</dt>
            <dd class="details__value">
              {{ quantityLabel(o) }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">已执行量</dt>
            <dd class="details__value">{{ quantity(o.executedQty) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">剩余量</dt>
            <dd class="details__value">{{ quantity(o.remainingQty) }}</dd>
          </div>
        </template>
        <div class="details__row">
          <dt class="details__term">当前状态</dt>
          <dd class="details__value">
            {{ orderStatus(o) }}
          </dd>
        </div>
      </dl>
      <details class="disclosure order__details">
        <summary
          class="disclosure__summary"
          role="button"
          :aria-label="`${o.symbol} ${o.kind === 'ordinary' ? '委托' : '条件委托'} ${o.id} 详情`"
        >
          详细设置与数据时间
        </summary>
        <dl class="details details--account">
          <div class="details__row">
            <dt class="details__term">{{ o.kind === 'ordinary' ? '委托标识' : '条件委托标识' }}</dt>
            <dd class="details__value">{{ o.id }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">创建时间</dt>
            <dd class="details__value">{{ time(o.createdAt) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">更新时间</dt>
            <dd class="details__value">{{ time(o.updatedAt) }}</dd>
          </div>
          <div v-if="o.kind === 'ordinary'" class="details__row">
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
              {{ flag(o.reduceOnly) }}
            </dd>
          </div>
          <template v-if="o.kind === 'conditional'">
            <div class="details__row">
              <dt class="details__term">触发依据</dt>
              <dd class="details__value">{{ workingType(o.workingType) }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">整仓退出</dt>
              <dd class="details__value">{{ flag(o.closePosition) }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">价格保护</dt>
              <dd class="details__value">
                {{ o.type === 'TRAILING_STOP_MARKET' ? '不适用 · 追踪止损' : flag(o.priceProtect) }}
              </dd>
            </div>
            <div v-if="o.type === 'TRAILING_STOP_MARKET'" class="details__row">
              <dt class="details__term">回调比例</dt>
              <dd class="details__value">
                {{ o.callbackRate === null ? '未知 · 未返回' : `${o.callbackRate}%` }}
              </dd>
            </div>
          </template>
          <div class="details__row">
            <dt class="details__term">有效方式</dt>
            <dd class="details__value">
              {{ marketOrder(o.type) ? '不适用 · 市价' : (o.timeInForce ?? '未知 · 未返回') }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">{{ o.kind === 'ordinary' ? '普通' : '条件' }}委托查询时间</dt>
            <dd class="details__value">
              {{ time(o.kind === 'ordinary' ? orders?.queriedAt : conditionalOrders?.queriedAt)
              }}{{ (o.kind === 'ordinary' ? stale : conditionalStale) ? ' · 已过期' : '' }}
            </dd>
          </div>
        </dl>
      </details>
    </article>
    <p class="footnote">
      触发价不保证成交价。委托从活跃列表消失，只表示本次未返回该记录；不推断成交、撤销、过期或已实现盈亏。
    </p>
  </section>
</template>
