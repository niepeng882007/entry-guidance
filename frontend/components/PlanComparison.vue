<script setup lang="ts">
import type { PlanComparison } from '../../src/plan-comparison.ts';
const { comparison, baseAsset } = defineProps<{
  comparison: PlanComparison;
  baseAsset: string;
}>();
const statuses = {
  waiting: '待成交',
  ended: '已结束',
  incomplete: '数据不完整',
  'needs-action': '需要处理',
  verified: '查询时点核验通过',
};
function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
function amount(value: string | null, asset = 'USDT') {
  return value === null ? '无法判断' : `${value} ${asset}`;
}
</script>

<template>
  <section class="review-page__detail" aria-labelledby="plan-comparison-title">
    <h3 id="plan-comparison-title" class="section-title">原方案与执行对照</h3>
    <p id="review-plan-link" class="muted">
      {{
        comparison.status === 'linked'
          ? '原方案：已关联'
          : comparison.status === 'ambiguous'
            ? '原方案：关联歧义'
            : '原方案：未关联'
      }}
      · {{ comparison.reason }}
    </p>
    <p v-if="comparison.status === 'ambiguous'" class="muted">
      候选方案：{{ comparison.candidatePlanIds.join('、') }}
    </p>
    <template v-if="comparison.plan">
      <p class="muted">
        方案 {{ comparison.plan.id }} · 生成于 {{ time(comparison.plan.startedAt) }}
      </p>
      <dl class="details details--card">
        <div class="details__row">
          <dt class="details__term">原固定亏损预算</dt>
          <dd id="review-plan-budget" class="details__value">
            {{ amount(comparison.plan.budget) }}
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">原入场方式 / 参考价</dt>
          <dd class="details__value">
            {{ comparison.plan.execution.entryType === 'LIMIT' ? '普通 GTC 限价' : '市价' }} ·
            {{ amount(comparison.plan.referencePrice) }}
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">计划数量 / 实际累计入场</dt>
          <dd class="details__value">
            {{ amount(comparison.plan.quantity, baseAsset) }} /
            {{ amount(comparison.actualEntry?.quantity ?? null, baseAsset) }}
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">实际入场加权均价</dt>
          <dd class="details__value">{{ amount(comparison.actualEntry?.price ?? null) }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">数量差 / 价格差（实际 − 计划）</dt>
          <dd class="details__value">
            {{ amount(comparison.quantityDifference, baseAsset) }} /
            {{ amount(comparison.priceDifference) }}
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">入场方式偏离</dt>
          <dd class="details__value">
            {{
              comparison.entryTypeDeviation === null
                ? '无法判断'
                : comparison.entryTypeDeviation
                  ? '有已记录偏离'
                  : '已记录方式一致'
            }}
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">原绝对最终止损</dt>
          <dd id="review-plan-stop" class="details__value">
            {{ amount(comparison.plan.stopPrice) }} · 标记价触发
          </dd>
        </div>
        <div v-if="comparison.plan.nearStop" class="details__row">
          <dt class="details__term">原近端止损 / 分配数量</dt>
          <dd class="details__value">
            {{ amount(comparison.plan.nearStop.price) }} /
            {{ amount(comparison.plan.nearStop.quantity, baseAsset) }} ·
            {{ comparison.plan.nearStop.percent }}%
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">计划杠杆</dt>
          <dd class="details__value">
            {{ comparison.plan.leverage }} 倍（实际历史设置另见查询记录）
          </dd>
        </div>
        <div class="details__row">
          <dt class="details__term">已确认最终净亏损 / 超预算</dt>
          <dd id="review-budget-excess" class="details__value">
            {{ amount(comparison.confirmedLoss) }} / {{ amount(comparison.budgetExcess) }}
          </dd>
        </div>
      </dl>
      <p v-if="comparison.actualEntry" class="muted">
        实际入场口径：本周期全部开仓及加仓成交；数量按 {{ baseAsset }}，均价按 USDT 加权并截取到 8
        位小数。 首次 {{ time(comparison.actualEntry.firstAt) }} · 最后
        {{ time(comparison.actualEntry.lastAt) }}。 数量差可能来自部分成交或加仓，不单独判定违规。
      </p>
      <details class="disclosure">
        <summary class="disclosure__summary">原费用与价格假设</summary>
        <p class="muted">
          开仓估值 {{ comparison.plan.entryEstimate }} USDT · 止损执行估值
          {{ comparison.plan.exitEstimate }} USDT。
        </p>
        <p class="muted">
          taker 费率 {{ comparison.plan.takerRate ?? '未知' }} · 每次滑点
          {{ comparison.plan.slippagePercent }}% · 资金费预留 {{ comparison.plan.funding }} USDT。
        </p>
        <p class="muted">
          预计开仓手续费 {{ comparison.plan.entryFee }} USDT · 预计退出手续费
          {{ comparison.plan.exitFee }}
          USDT；实际手续费及资金费按本周期已记录分项表达，未确认的成本不当作零。
        </p>
      </details>
      <h4 class="section-title">已保存核验 · {{ comparison.verifications.length }} 次查询</h4>
      <details
        v-for="(check, index) in comparison.verifications"
        :key="index"
        class="disclosure review-check"
      >
        <summary class="disclosure__summary">
          {{ time(check.queriedAt) }} · {{ statuses[check.status] }}
        </summary>
        <p class="muted">
          仅代表查询时点；本次读取范围：{{
            check.reviewEvidence
              ? `${time(new Date(check.reviewEvidence.startTime).toISOString())} 至 ${time(new Date(check.reviewEvidence.endTime).toISOString())}`
              : '未知'
          }}。
        </p>
        <p class="muted">
          查询时点剩余仓位 {{ amount(check.quantity ?? null, baseAsset) }} · 持仓均价
          {{ amount(check.entryPrice ?? null) }} · 实际杠杆 {{ check.leverage ?? '未知' }} 倍。
        </p>
        <p class="muted">
          已付手续费 {{ amount(check.paidCommission ?? null) }} · 已付资金费支出
          {{ amount(check.paidFunding ?? null) }} · 按原止损计算的亏损
          {{
            amount(check.plannedLoss ?? null)
          }}（包含核验的实际成本与剩余退出假设，非最终净亏损）。
        </p>
        <p v-if="!check.reviewEvidence?.snapshotConsistent" class="muted">
          快照时间或持仓证据不一致，此次止损设置与覆盖无法判断。
        </p>
        <p class="muted">
          记录覆盖：{{ check.coverage ?? '未能确认' }} · 近端状态
          {{ check.nearStatus ?? '无记录' }}。
        </p>
        <p v-for="(issue, issueIndex) in check.issues" :key="issueIndex" class="muted">
          {{ issue }}
        </p>
        <p
          v-for="(deviation, deviationIndex) in comparison.stopChecks[index]?.deviations ?? []"
          :key="deviationIndex"
          class="error"
        >
          已记录设置偏离：{{ deviation }}
        </p>
        <p v-if="!check.reviewEvidence?.stops.length" class="muted">
          此查询快照未返回止损委托；未记录期间的设置与覆盖未知。
        </p>
        <p
          v-for="stop in check.reviewEvidence?.stops ?? []"
          :key="`${stop.algo}-${stop.id}`"
          class="muted"
        >
          止损 {{ stop.id }} · {{ stop.status }} · {{ stop.type }} · {{ stop.side }} /
          {{ stop.positionSide }} · 触发价 {{ stop.triggerPrice }} USDT · {{ stop.workingType }} ·
          {{ stop.closePosition ? '整仓退出' : `固定数量 ${stop.quantity} ${baseAsset}` }} · 只减仓
          {{ stop.reduceOnly ? '是' : '否' }} · 价格保护 {{ stop.priceProtect ? '是' : '否' }} ·
          设置更新时间 {{ time(new Date(stop.updateTime).toISOString()) }}。
        </p>
        <p
          v-for="stop in check.reviewEvidence?.historicalStops ?? []"
          :key="`historical-${stop.id}`"
          class="muted"
        >
          条件单历史 {{ stop.id }} · {{ stop.status }} · 触发价 {{ stop.triggerPrice }} USDT ·
          {{ stop.workingType }} ·
          {{ stop.closePosition ? '整仓退出' : `固定数量 ${stop.quantity} ${baseAsset}` }} ·
          实际退出订单 {{ stop.actualOrderId ?? '未记录' }} · 设置更新时间
          {{ time(new Date(stop.updateTime).toISOString()) }}。
        </p>
      </details>
    </template>
    <p v-for="limit in comparison.limitations" :key="limit" class="muted">{{ limit }}</p>
  </section>
</template>
