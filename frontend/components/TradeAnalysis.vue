<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import type { ReviewTrade } from '../../src/review-ledger.ts';
import { useTradeAnalysis } from '../useTradeAnalysis';
import { reviewTime } from '../review-records';
import { reportFields } from '../../src/analysis-model.ts';
const props = defineProps<{ trade: ReviewTrade; query: string }>();
const { tasks, includeNotes, busy, stale, status, refresh, start, action } = useTradeAnalysis(
  toRef(props, 'trade'),
  () => props.query,
);
const labels = {
  observations: '观察',
  evidence: '证据',
  improvements: '改进建议',
  nextChecks: '下次检查项',
};
const kinds = { fact: '交易 / 统计事实', user: '用户自述', inference: '模型推测' };
const timing = {
  contemporaneous: '当时信息',
  retrospective: '事后观察',
  unknown: '可知时点待确认',
};
const states = {
  running: '后台分析中',
  complete: '完整报告',
  failed: '未完成 · 请求或格式失败',
  cancelled: '未完成 · 已取消',
  interrupted: '未完成 · 服务中断',
};
const sections = ref(new Set<string>());
function disclosure(event: Event, id: string) {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  const next = new Set(sections.value);
  if (event.target.open) next.add(id);
  else next.delete(id);
  sections.value = next;
}
const latest = computed(() => tasks.value[0]);
</script>

<template>
  <section class="trade-analysis" aria-labelledby="trade-analysis-title">
    <h3 id="trade-analysis-title" class="section-title">单笔模型复盘</h3>
    <p class="muted">DeepSeek · deepseek-v4-pro · high。仅点击发起时调用；可能产生费用。</p>
    <label class="trade-analysis__notes"
      ><input v-model="includeNotes" type="checkbox" :disabled="busy" />发送已保存笔记</label
    >
    <p class="muted">
      仅发送归属已确认的保存版本；未保存草稿不发送。行情使用已归档的全部周期与原始数值。
    </p>
    <div class="review-page__actions">
      <button type="button" class="button" :disabled="busy || stale" @click="start(false)">
        发起分析 / 复用报告
      </button>
      <button
        v-if="latest"
        type="button"
        class="button button--secondary"
        :disabled="busy || stale"
        @click="start(true)"
      >
        重试 / 重新生成（新证据）
      </button>
      <button type="button" class="button button--text" :disabled="busy" @click="refresh">
        重新读取任务
      </button>
    </div>
    <p role="status" class="muted">{{ status }}</p>
    <p v-if="stale" class="error">任务状态不是当前读取结果；重新读取后再操作。</p>
    <p v-if="!tasks.length && !busy" class="muted">尚无已保存分析。</p>
    <article v-for="task in tasks" :key="task.id" class="trade-analysis__task">
      <h4 class="section-title">{{ states[task.status] }}</h4>
      <p class="muted">
        冻结于 {{ reviewTime(task.snapshot.frozenAt) }} ·
        {{ task.snapshot.notes.length ? '含已保存笔记' : '未发送笔记' }} · 已完成
        {{ task.requests.filter((row) => row.status === 'complete').length }} /
        {{ task.requests.length }} 个请求
      </p>
      <p class="muted">
        统计范围：{{ task.snapshot.statistics.filters.from || '不限起日' }} —
        {{ task.snapshot.statistics.filters.to || '不限止日' }} ·
        {{ task.snapshot.statistics.filters.symbol || '全部交易对' }} ·
        {{ task.snapshot.statistics.total }} 笔
      </p>
      <p v-if="task.error" class="error">{{ task.error }}</p>
      <div class="review-page__actions">
        <button
          v-if="task.status === 'running'"
          type="button"
          class="button button--secondary"
          :disabled="busy || stale"
          @click="action('cancel', task.id)"
        >
          取消后台任务
        </button>
        <button
          v-else-if="task.status !== 'complete'"
          type="button"
          class="button button--secondary"
          :disabled="busy || stale"
          @click="action('continue', task.id)"
        >
          继续（原证据与已完成分段）
        </button>
      </div>
      <p class="muted">
        缺失项 / 不可判断范围：{{
          task.snapshot.missing.join('；') || '无已记录缺项；模型推测仍需核对'
        }}
      </p>
      <div v-if="task.report">
        <section v-for="field in reportFields" :key="field" class="trade-analysis__section">
          <h5 class="section-title">{{ labels[field] }}</h5>
          <p v-if="!task.report[field].length" class="muted">模型未提供此项。</p>
          <article v-for="(item, index) in task.report[field]" :key="index">
            <p>{{ item.text }}</p>
            <p class="muted">{{ kinds[item.kind] }} · {{ timing[item.timing] }}</p>
            <details
              class="disclosure"
              @toggle="disclosure($event, `${task.id}-${field}-${index}`)"
            >
              <summary class="disclosure__summary">引用依据 · {{ item.refs.join('、') }}</summary>
              <div v-if="sections.has(`${task.id}-${field}-${index}`)">
                <p v-for="id in item.refs" :key="id" class="trade-analysis__evidence">
                  {{ id }} ·
                  {{
                    task.records.find((row) => row.id === id)?.path ??
                    '已完成分段结果（非原始证据），见下方分段清单'
                  }}
                  · {{ JSON.stringify(task.records.find((row) => row.id === id)?.value) }}
                </p>
              </div>
            </details>
          </article>
        </section>
      </div>
      <details class="disclosure" @toggle="disclosure($event, task.id)">
        <summary class="disclosure__summary">完整覆盖清单、分段结果与返回用量</summary>
        <div v-if="sections.has(task.id)">
          <p class="muted">
            {{ task.records.length }} 条证据字段。UTF-8
            字节保守估计容量；全量分段后综合，无抽样。模型上下文
            {{ task.capacity.contextWindow }}，最大输出
            {{ task.capacity.maxOutputTokens }} token（含推理）。
          </p>
          <p v-for="market in task.snapshot.markets" :key="market.snapshotId" class="muted">
            {{ market.interval }} · {{ reviewTime(market.queriedAt) }} · 合约价
            {{ market.series.contract.candles.length }} 根 / 标记价
            {{ market.series.mark.candles.length }} 根 ·
            {{
              market.series.contract.complete && market.series.mark.complete
                ? '完整'
                : '含缺口，无法完整判断'
            }}
          </p>
          <details
            v-for="request in task.requests"
            :key="request.id"
            class="disclosure"
            @toggle="disclosure($event, `${task.id}-${request.id}`)"
          >
            <summary class="disclosure__summary">
              {{ request.id }} ·
              {{ request.stage === 'synthesis' ? '基于分段结果综合' : '原始证据分段' }} ·
              {{ request.status }}
            </summary>
            <div v-if="sections.has(`${task.id}-${request.id}`)">
              <p v-for="(attempt, index) in request.attempts" :key="index" class="muted">
                尝试 {{ index + 1 }} · {{ attempt.status }} ·
                {{
                  attempt.usage
                    ? `输入 ${attempt.usage.inputTokens} / 输出 ${attempt.usage.outputTokens} / 合计 ${attempt.usage.totalTokens} token`
                    : '用量未知，可能产生费用'
                }}
              </p>
              <pre class="trade-analysis__evidence">{{
                JSON.stringify(
                  { records: request.records, segments: request.segments, report: request.report },
                  null,
                  2,
                )
              }}</pre>
            </div>
          </details>
        </div>
      </details>
      <p class="muted">
        {{
          task.requests.some((row) => row.attempts.some((attempt) => attempt.usage === null))
            ? '用量未知，可能产生费用；取消或失败不代表免费。'
            : '返回用量见分段清单；用量不等同实际账单金额。'
        }}
      </p>
    </article>
  </section>
</template>
