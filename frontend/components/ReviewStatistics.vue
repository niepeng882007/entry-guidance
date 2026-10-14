<script setup lang="ts">
import { computed, ref } from 'vue';
import type { StatisticsEvidence } from '../../src/review-statistics.ts';
import { reviewTimeZone } from '../../src/review-filters.ts';
import { formatDecimal } from '../../public/draft.js';
import SelectControl from './SelectControl.vue';

const { statistics } = defineProps<{ statistics: StatisticsEvidence }>();
const dimension = ref<keyof StatisticsEvidence['groups']>('symbols');
const groups = computed(() => statistics.groups[dimension.value]);
function money(value: string | null) {
  return value === null ? '不适用' : `${value} USDT`;
}
function duration(value: number | null) {
  if (value === null) return '不适用';
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分 ${seconds % 60} 秒`;
}
function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: reviewTimeZone });
}
function fixed(value: string): bigint {
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return BigInt(`${whole}${fraction.padEnd(8, '0')}`) * (value.startsWith('-') ? -1n : 1n);
}
const plot = computed(() => {
  const values = statistics.curve.map((point) => fixed(point.cumulativeNetPnl));
  let low = 0n,
    high = 0n;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  // A flat series still needs a visible scale around zero.
  if (low === high) {
    low = -100_000_000n;
    high = 100_000_000n;
  }
  const y = (value: bigint) =>
    190 - Number(((value - low) * 180_000_000n) / (high - low)) / 1_000_000;
  const first = Date.parse(statistics.curve[0]?.closedAt ?? '');
  const last = Date.parse(statistics.curve.at(-1)?.closedAt ?? '');
  const points = statistics.curve.map((point, index) => ({
    ...point,
    x: first === last ? 300 : 10 + ((Date.parse(point.closedAt) - first) / (last - first)) * 580,
    y: y(values[index]!),
  }));
  return {
    points,
    path: points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' '),
    zero: y(0n),
    middle: formatDecimal((low + high) / 2n),
    low: formatDecimal(low),
    high: formatDecimal(high),
  };
});
const barMaximum = computed(() =>
  groups.value.reduce((max, group) => {
    const value = group.pnl.netPnl === null ? 0n : fixed(group.pnl.netPnl);
    const magnitude = value < 0n ? -value : value;
    return magnitude > max ? magnitude : max;
  }, 1n),
);
function bar(value: string | null) {
  const number = value === null ? 0n : fixed(value);
  const width = Number(((number < 0n ? -number : number) * 140_000n) / barMaximum.value) / 1000;
  return { x: number < 0n ? 150 - width : 150, width };
}
</script>

<template>
  <section class="review-page__detail review-statistics" aria-labelledby="review-statistics-title">
    <h2 id="review-statistics-title" class="section-title">筛选范围表现统计</h2>
    <p class="muted">
      全范围 {{ statistics.total }} 笔 · 净盈亏有效 {{ statistics.pnl.samples }} 笔，排除
      {{ statistics.pnl.excluded.length }} 笔 · 时长有效 {{ statistics.duration.samples }} 笔，排除
      {{ statistics.duration.excluded.length }} 笔
    </p>
    <dl class="details">
      <div class="details__row">
        <dt class="details__term">
          净盈亏
          <details class="disclosure disclosure--help">
            <summary class="disclosure__summary" aria-label="统计净盈亏说明">说明</summary>
            <p class="help">已实现盈亏 − USDT 手续费 + 可确认归属的资金费净收支。</p>
          </details>
        </dt>
        <dd class="details__value">{{ money(statistics.pnl.netPnl) }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">盈利／亏损／持平</dt>
        <dd class="details__value">
          {{ statistics.pnl.wins }} ／ {{ statistics.pnl.losses }} ／ {{ statistics.pnl.flats }} 笔
        </dd>
      </div>
      <div class="details__row">
        <dt class="details__term">胜率</dt>
        <dd class="details__value">
          {{ statistics.pnl.winRate === null ? '不适用（零样本）' : `${statistics.pnl.winRate}%` }}
        </dd>
      </div>
      <div class="details__row">
        <dt class="details__term">平均盈利</dt>
        <dd class="details__value">{{ money(statistics.pnl.averageWin) }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">平均亏损</dt>
        <dd class="details__value">{{ money(statistics.pnl.averageLoss) }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">盈亏因子</dt>
        <dd class="details__value">
          {{ statistics.pnl.profitFactor ?? '不适用（没有亏损样本）' }}
        </dd>
      </div>
      <div class="details__row">
        <dt class="details__term">平均持仓时长</dt>
        <dd class="details__value">{{ duration(statistics.duration.averageMs) }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">最短／最长持仓</dt>
        <dd class="details__value">
          {{ duration(statistics.duration.minMs) }} ／ {{ duration(statistics.duration.maxMs) }}
        </dd>
      </div>
    </dl>
    <p v-if="!statistics.pnl.samples" class="muted">没有可判定净盈亏的已结束交易。</p>
    <p class="muted">
      胜率分母含持平交易；金额与时长分别判断完整性。样本有限，不能据此认定稳定优势。
    </p>
    <details v-if="statistics.pnl.excluded.length || statistics.duration.excluded.length">
      <summary>有效样本与排除原因</summary>
      <p class="muted">费用缺失但成交链和开平仓时点可靠时，时长仍可计入。</p>
      <div
        v-for="metric in [
          { name: '净盈亏', excluded: statistics.pnl.excluded },
          { name: '持仓时长', excluded: statistics.duration.excluded },
        ]"
        :key="metric.name"
      >
        <h3 class="section-title">{{ metric.name }}排除 {{ metric.excluded.length }} 笔</h3>
        <ul>
          <li v-for="item in metric.excluded" :key="item.tradeId">
            {{ item.tradeId }}：{{ item.reasons.join('；') }}
          </li>
        </ul>
      </div>
    </details>

    <h3 class="section-title review-statistics__heading">累计净盈亏 · USDT</h3>
    <p class="muted">
      横轴：平仓时间（上海）；纵轴：累计交易净盈亏（USDT）。仅含选定交易结果，不代表账户权益或资金收益率。
    </p>
    <div v-if="statistics.curve.length" class="review-statistics__chart">
      <div class="review-statistics__scale">
        <span>{{ plot.high }}</span
        ><span>{{ plot.middle }}</span
        ><span>{{ plot.low }}</span>
      </div>
      <svg
        class="review-statistics__plot"
        viewBox="0 0 600 200"
        preserveAspectRatio="none"
        role="img"
        aria-label="累计交易净盈亏曲线"
      >
        <line x1="0" :y1="plot.zero" x2="600" :y2="plot.zero" class="review-statistics__zero" />
        <path :d="plot.path" class="review-statistics__line" />
        <circle
          v-for="point in plot.points"
          :key="point.tradeId"
          :cx="point.x"
          :cy="point.y"
          r="3"
          class="review-statistics__point"
        >
          <title>
            {{ time(point.closedAt) }} · {{ point.tradeId }} · {{ point.cumulativeNetPnl }} USDT
          </title>
        </circle>
      </svg>
      <div class="review-statistics__dates">
        <span>{{ time(statistics.curve[0]!.closedAt) }}</span
        ><span>{{ time(statistics.curve.at(-1)!.closedAt) }}</span>
      </div>
    </div>
    <p v-else class="muted">零有效样本，暂无累计曲线。</p>
    <details v-if="statistics.curve.length">
      <summary>曲线原始数值（{{ statistics.curve.length }} 笔）</summary>
      <ol class="review-statistics__raw">
        <li v-for="point in statistics.curve" :key="point.tradeId">
          {{ time(point.closedAt) }} · {{ point.tradeId }}<br />本笔 {{ money(point.netPnl) }} ·
          累计 {{ money(point.cumulativeNetPnl) }}
        </li>
      </ol>
    </details>

    <h3 class="section-title review-statistics__heading">分组比较</h3>
    <div class="field review-statistics__control">
      <label class="field-label" for="statistics-dimension">比较维度</label>
      <SelectControl
        ><select
          id="statistics-dimension"
          v-model="dimension"
          class="field-control field-control--select"
        >
          <option value="symbols">币种</option>
          <option value="sides">方向</option>
          <option value="entryTypes">入场类型</option>
          <option value="tags">风格标签</option>
        </select></SelectControl
      >
    </div>
    <p class="muted">
      条形横轴：分组净盈亏（USDT），中心为 0，左亏右盈；各条使用同一比例，原值见各组。
    </p>
    <p v-if="dimension === 'tags'" class="muted">
      每笔完整计入所有已确认标签；各标签组重叠，不能相加。未打标签归为未知／未标注。
    </p>
    <div
      v-if="groups.length"
      class="review-statistics__group-axis"
      aria-label="分组净盈亏坐标，单位 USDT"
    >
      <span>{{ formatDecimal(-barMaximum) }}</span
      ><span>0</span><span>{{ formatDecimal(barMaximum) }}</span>
    </div>
    <ul class="review-statistics__groups">
      <li v-for="group in groups" :key="group.key" class="review-statistics__group">
        <div class="section-heading">
          <h4 class="section-title">{{ group.label }}</h4>
          <span>{{ money(group.pnl.netPnl) }}</span>
        </div>
        <p class="muted">
          范围 {{ group.total }} 笔 · 净盈亏有效 {{ group.pnl.samples }} 笔 · 排除
          {{ group.pnl.excluded.length }} 笔
        </p>
        <svg
          class="review-statistics__bar"
          viewBox="0 0 300 20"
          role="img"
          :aria-label="`${group.label}分组净盈亏 ${money(group.pnl.netPnl)}，中心为零`"
        >
          <line x1="150" y1="0" x2="150" y2="20" class="review-statistics__zero" />
          <rect
            :x="bar(group.pnl.netPnl).x"
            y="4"
            :width="bar(group.pnl.netPnl).width"
            height="12"
            class="review-statistics__bar-value"
            :data-loss="group.pnl.netPnl?.startsWith('-')"
          />
        </svg>
        <details>
          <summary>分组指标与排除原因</summary>
          <p>
            盈利 {{ group.pnl.wins }} ／ 亏损 {{ group.pnl.losses }} ／ 持平
            {{ group.pnl.flats }} 笔；胜率
            {{ group.pnl.winRate === null ? '不适用' : `${group.pnl.winRate}%` }}。
          </p>
          <p>
            平均盈利 {{ money(group.pnl.averageWin) }}；平均亏损
            {{ money(group.pnl.averageLoss) }}；盈亏因子
            {{ group.pnl.profitFactor ?? '不适用（没有亏损样本）' }}。
          </p>
          <p>
            时长有效 {{ group.duration.samples }} 笔，排除
            {{ group.duration.excluded.length }} 笔；平均 {{ duration(group.duration.averageMs) }}。
          </p>
          <ul>
            <li v-for="item in group.pnl.excluded" :key="item.tradeId">
              净盈亏 · {{ item.tradeId }}：{{ item.reasons.join('；') }}
            </li>
            <li v-for="item in group.duration.excluded" :key="item.tradeId">
              时长 · {{ item.tradeId }}：{{ item.reasons.join('；') }}
            </li>
          </ul>
        </details>
      </li>
    </ul>
    <details class="review-statistics__evidence">
      <summary>统计证据与读取时点</summary>
      <p>口径版本 {{ statistics.version }} · {{ time(statistics.queriedAt) }}（上海）</p>
      <p>同一平仓时刻按交易 ID 排列。</p>
      <p class="review-statistics__evidence-id">{{ statistics.evidenceId }}</p>
    </details>
  </section>
</template>
