<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import type { ReviewTrade } from '../../src/review-ledger.ts';
import type { Candle, PriceSource } from '../../src/trade-market.ts';
import { useTradeMarket } from '../useTradeMarket.ts';
const props = defineProps<{ trade: ReviewTrade }>();
const emit = defineEmits<{ fill: [index: number] }>();
const { interval, chart, busy, relogin, status, read } = useTradeMarket(toRef(props, 'trade'));
const source = ref<PriceSource>('contract');
const selected = ref<number | null>(null);
const selectedCandle = ref<Candle | null>(null);
const eventPage = ref(0);
const series = computed(() => chart.value?.series[source.value]);
const events = { entry: '开仓', add: '加仓', reduce: '减仓', exit: '平仓' };
const event = computed(() =>
  selected.value === null ? null : chart.value?.events[selected.value],
);
const bounds = computed(() => {
  const prices = [
    ...(series.value?.candles.flatMap((row) => [Number(row.high), Number(row.low)]) ?? []),
    ...(chart.value?.events.map((row) => Number(row.price)) ?? []),
    ...(chart.value?.stops.map((row) => Number(row.price)) ?? []),
  ];
  const min = Math.min(...prices),
    max = Math.max(...prices);
  const padding = Math.max((max - min) * 0.08, max * 0.001);
  return { min: min - padding, max: max + padding };
});
const shownEvents = computed(
  () => chart.value?.events.slice(eventPage.value * 20, eventPage.value * 20 + 20) ?? [],
);
function x(time: number) {
  return chart.value
    ? 80 +
        (680 * (time - chart.value.startTime)) /
          Math.max(1, chart.value.endTime - chart.value.startTime)
    : 80;
}
function y(price: string | number) {
  return (
    270 -
    (240 * (Number(price) - bounds.value.min)) /
      Math.max(0.000001, bounds.value.max - bounds.value.min)
  );
}
function time(value: string | number) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
function phase(row: Candle) {
  const opened = chart.value?.openedAt ? Date.parse(chart.value.openedAt) : null;
  const closed = chart.value?.closedAt ? Date.parse(chart.value.closedAt) : null;
  if (
    (opened !== null && row.openTime <= opened && row.closeTime >= opened) ||
    (closed !== null && row.openTime <= closed && row.closeTime >= closed)
  )
    return '跨开平仓边界';
  if (closed !== null && row.openTime > closed) return '出场后 · 事后观察';
  return opened === null ? '起点未知' : row.closeTime < opened ? '开仓前' : '持仓中';
}
function choose(index: number) {
  selected.value = index;
  selectedCandle.value = null;
}
watch([chart, source], () => {
  selected.value = null;
  selectedCandle.value = null;
  eventPage.value = 0;
});
</script>

<template>
  <section class="trade-chart" aria-label="行情与交易事件">
    <h3 class="section-title">行情与交易事件</h3>
    <div class="trade-chart__controls">
      <div class="field">
        <label class="field-label" for="chart-interval">K 线周期</label>
        <select id="chart-interval" v-model="interval" class="field-control" :disabled="relogin">
          <option v-for="value in ['1m', '5m', '15m', '1h', '4h']" :key="value" :value="value">
            {{ value }}
          </option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="chart-source">行情价格来源</label>
        <select id="chart-source" v-model="source" class="field-control">
          <option value="contract">合约成交价</option>
          <option value="mark">标记价</option>
        </select>
      </div>
      <button
        class="button button--secondary"
        type="button"
        :disabled="busy || relogin"
        :aria-busy="busy"
        @click="read()"
      >
        继续读取 / 重试行情
      </button>
    </div>
    <p class="muted" role="status" aria-live="polite">{{ status }}</p>
    <a v-if="relogin" class="button button--text button--link" href="/login">行情重新登录</a>
    <template v-if="chart && series">
      <p class="muted">
        {{ chart.source === 'demo' ? '演示合成行情 · 不是真实历史价格' : 'Binance 公共历史行情' }} ·
        {{ source === 'contract' ? '合约成交价' : '标记价' }} · {{ series.endpoint }} ·
        {{ chart.interval }}
      </p>
      <p class="muted">
        查询时点：{{ time(chart.queriedAt) }} · 范围：{{ time(chart.startTime) }} 至
        {{ time(chart.endTime) }}
      </p>
      <p class="muted">
        {{
          series.complete ? '本来源请求范围已完整归档' : '本来源行情未完成或有缺口 / 未闭合 K 线'
        }}
        · {{ series.rawCount }} 根原始 K 线 · 屏幕显示 {{ series.candles.length }} 根{{
          series.sampled ? '（抽稀展示，不是全部原始数据）' : ''
        }}
      </p>
      <p v-if="chart.desiredEndTime > chart.endTime" class="muted">
        出场后窗口尚未全部发生，截至已知时间展示。
      </p>
      <p v-if="!chart.openedAt || !chart.closedAt" class="muted">
        {{ !chart.openedAt ? '开仓起点未知，从首条已知成交附近展示。' : '尚无已确认平仓边界。' }}
      </p>
      <p v-if="series.error" class="error">{{ series.error }}</p>
      <details v-if="series.gaps.length" class="disclosure">
        <summary class="disclosure__summary">
          行情缺口 / 待完成区间 · {{ series.gaps.length }} 段
        </summary>
        <p v-for="gap in series.gaps" :key="gap.startTime" class="muted">
          {{ time(gap.startTime) }} 至 {{ time(gap.endTime) }}
        </p>
      </details>
      <p class="muted">
        开仓前 / 持仓中 / 出场后按已确认边界区分。整根 K 线在收盘后才完整可知；跨边界及未闭合 K
        线不能当作决策时已知路径，不能证明止损触发或精确逐笔走势。
      </p>
      <p v-if="Number.isFinite(bounds.min)" class="muted">
        价格纵轴 {{ bounds.min.toFixed(2) }} 至 {{ bounds.max.toFixed(2) }} USDT ·
        横轴为时间；浅灰区域为开仓前，深灰区域为出场后。
      </p>
      <svg
        v-if="series.candles.length || chart.events.length"
        class="trade-chart__plot"
        viewBox="0 0 800 330"
        role="group"
        aria-label="K 线、实际成交与止损证据，纵轴 USDT"
      >
        <rect
          v-if="chart.openedAt"
          class="trade-chart__before"
          x="80"
          y="30"
          :width="Math.max(0, x(Date.parse(chart.openedAt)) - 80)"
          height="240"
        />
        <rect
          v-if="chart.closedAt"
          class="trade-chart__after"
          :x="x(Date.parse(chart.closedAt))"
          y="30"
          :width="Math.max(0, 760 - x(Date.parse(chart.closedAt)))"
          height="240"
        />
        <text class="trade-chart__axis" x="0" y="25">USDT</text>
        <g v-if="Number.isFinite(bounds.min)">
          <text class="trade-chart__axis" x="0" y="50">{{ bounds.max.toFixed(2) }}</text>
          <text class="trade-chart__axis" x="0" y="270">{{ bounds.min.toFixed(2) }}</text>
        </g>
        <line class="trade-chart__axis-line" x1="80" y1="270" x2="760" y2="270" />
        <g
          v-for="row in series.candles"
          :key="row.openTime"
          class="trade-chart__candle"
          :data-up="Number(row.close) >= Number(row.open)"
          tabindex="0"
          role="button"
          :aria-label="`${phase(row)} · ${time(row.openTime)} · 收盘 ${row.close} USDT`"
          @click="selectedCandle = row"
          @keydown.enter.prevent="selectedCandle = row"
          @keydown.space.prevent="selectedCandle = row"
        >
          <title>
            {{ phase(row) }} · {{ row.open }} / {{ row.high }} / {{ row.low }} /
            {{ row.close }} USDT
          </title>
          <line :x1="x(row.openTime)" :x2="x(row.openTime)" :y1="y(row.high)" :y2="y(row.low)" />
          <line
            class="trade-chart__body"
            :x1="x(row.openTime)"
            :x2="x(row.openTime)"
            :y1="y(row.open)"
            :y2="y(row.close)"
          />
        </g>
        <g
          v-for="stop in chart.stops"
          :key="stop.id"
          :class="stop.kind === 'plan' ? 'trade-chart__plan' : 'trade-chart__stop'"
        >
          <title>
            {{ stop.label }} · {{ stop.price }} USDT · {{ stop.basis }} · {{ time(stop.time) }}
          </title>
          <line
            v-if="stop.kind === 'plan'"
            :x1="Math.max(80, x(stop.time))"
            x2="760"
            :y1="y(stop.price)"
            :y2="y(stop.price)"
          />
          <circle
            v-else-if="stop.time >= chart.startTime && stop.time <= chart.endTime"
            :cx="x(stop.time)"
            :cy="y(stop.price)"
            r="5"
          />
        </g>
        <g
          v-for="(row, index) in chart.events.slice(0, 200)"
          :key="`${row.id}-${row.allocation}`"
          class="trade-chart__marker"
          :data-selected="selected === index"
          tabindex="0"
          role="button"
          :aria-label="`图中${row.event ? events[row.event] : '已知成交'} · ${row.id}`"
          @click="choose(index)"
          @keydown.enter.prevent="choose(index)"
          @keydown.space.prevent="choose(index)"
        >
          <title>
            {{ row.event ? events[row.event] : '已知成交' }} · {{ row.price }} USDT ·
            {{ time(row.time) }}
          </title>
          <circle :cx="x(Date.parse(row.time))" :cy="y(row.price)" r="6" />
        </g>
        <text class="trade-chart__axis" x="80" y="310">{{ time(chart.startTime) }}</text>
        <text class="trade-chart__axis" x="760" y="310" text-anchor="end">
          {{ time(chart.endTime) }}
        </text>
      </svg>
      <p v-if="chart.events.length > 200" class="muted">
        图中仅显示前 200 条成交标记；全部 {{ chart.events.length }} 条事件可逐页查看。
      </p>
      <p v-if="selectedCandle" class="trade-chart__selection" role="status">
        {{ phase(selectedCandle) }} · {{ time(selectedCandle.openTime) }} 至
        {{ time(selectedCandle.closeTime) }} · 开 {{ selectedCandle.open }} / 高
        {{ selectedCandle.high }} / 低 {{ selectedCandle.low }} / 收 {{ selectedCandle.close }} USDT
        · {{ selectedCandle.final ? '已闭合' : '尚未闭合' }} · 读取于
        {{ time(selectedCandle.queriedAt) }}
      </p>
      <div class="trade-chart__events" aria-label="实际成交事件">
        <button
          v-for="(row, index) in shownEvents"
          :key="`${row.id}-${row.allocation}`"
          class="button button--secondary"
          type="button"
          :aria-pressed="selected === eventPage * 20 + index"
          @click="choose(eventPage * 20 + index)"
        >
          {{ row.event ? events[row.event] : '已知成交' }} · {{ row.id }}
        </button>
      </div>
      <div v-if="chart.events.length > 20" class="trade-chart__events">
        <button
          class="button button--secondary"
          type="button"
          :disabled="eventPage === 0"
          @click="eventPage--"
        >
          上一页事件
        </button>
        <span>{{ eventPage + 1 }} / {{ Math.ceil(chart.events.length / 20) }}</span>
        <button
          class="button button--secondary"
          type="button"
          :disabled="(eventPage + 1) * 20 >= chart.events.length"
          @click="eventPage++"
        >
          下一页事件
        </button>
      </div>
      <article v-if="event && selected !== null" class="trade-chart__selection" aria-live="polite">
        <p>
          {{ event.event ? events[event.event] : '已知成交 · 边界未知' }} · {{ time(event.time) }} ·
          {{ event.price }} USDT × {{ event.quantity }} {{ trade.baseAsset }}
        </p>
        <p>
          原始成交 {{ event.id }} · 订单 {{ event.orderId
          }}{{ !event.orderKnown ? ' · 订单元数据缺失' : '' }}
        </p>
        <p v-if="event.allocation">
          {{ event.allocation === 'close' ? '反手平仓分配' : '反手开仓分配' }} · 保留原成交关联
        </p>
        <button class="button button--text" type="button" @click="emit('fill', selected)">
          查看此成交原始详情
        </button>
      </article>
      <p v-if="!chart.stops.length" class="muted">无可关联止损证据，不补造计划线或止损触发。</p>
      <p v-for="stop in chart.stops" :key="stop.id" class="muted">
        {{ stop.label }} · {{ stop.price }} USDT ·
        {{
          stop.basis === 'MARK_PRICE'
            ? '标记价触发依据'
            : stop.basis === 'CONTRACT_PRICE'
              ? '合约成交价触发依据'
              : '触发依据未知'
        }}
        · {{ time(stop.time) }}
      </p>
      <p class="muted">
        虚线为原计划；圆点为对应时点的实际设置证据，不能推导持续保护。实际成交标记始终使用成交价，即使当前行情选择标记价。
      </p>
      <p v-if="chart.missing.length" class="error">交易证据缺项：{{ chart.missing.join('；') }}</p>
      <details class="disclosure">
        <summary class="disclosure__summary">原始数值行情证据入口</summary>
        <p class="muted">
          按相同快照与来源读取，每页最多 499 根；抽稀仅影响屏幕。已归档
          {{ series.rawCount }} 根，缺口仍保留，未来分析必须同时携带交易证据与每根读取时点。
        </p>
        <a
          class="button button--text button--link"
          :href="`/api/review/market/${chart.snapshotId}?source=${source}&offset=0`"
          target="_blank"
          rel="noopener"
          >查看本来源原始行情第一页</a
        >
      </details>
    </template>
  </section>
</template>
