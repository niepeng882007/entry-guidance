<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { Button, ConfigProvider, DatePicker, Pagination, Select, Table, Tag } from 'ant-design-vue';
import type { TableColumnsType } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import 'dayjs/locale/zh-cn';
import type { ReviewSummary } from '../src/review-ledger.ts';
import ReviewArchive from './components/ReviewArchive.vue';
import ReviewTradeDetail from './components/ReviewTradeDetail.vue';
import ReviewNotes from './components/ReviewNotes.vue';
import ReviewStatistics from './components/ReviewStatistics.vue';
import TradeAnalysis from './components/TradeAnalysis.vue';
import ReviewBackup from './components/ReviewBackup.vue';
import ReviewOrders from './components/ReviewOrders.vue';
import { useReviewPage } from './useReviewPage';
import { useReviewLocation } from './useReviewLocation';
import { dateRangeError, reviewTime } from './review-records';
import { reviewTheme } from './review-theme';
import 'virtual:review-antd.css';
import { reviewPageSize } from '../src/review-filters.ts';

const { source, expectedSource } = defineProps<{
  source: string;
  expectedSource: 'binance' | 'demo';
}>();
const { location, filter, paginate, show, back, view } = useReviewLocation();
const review = useReviewPage(expectedSource, () => location.value);
const {
  list,
  trade,
  busy,
  relogin,
  status,
  refresh,
  archive,
  sync,
  stale,
  filterOptions,
  cancelRead,
  journalSaved,
} = review;
const rangeError = computed(() => dateRangeError(location.value.from, location.value.to));
const total = computed(() => list.value?.total ?? 0);
const lastPage = computed(() => Math.max(1, Math.ceil(total.value / reviewPageSize)));
const currentPage = computed(() => Math.min(location.value.page, lastPage.value));
const rows = computed(() => list.value?.trades ?? []);
const symbolOptions = computed(() =>
  filterOptions.value.symbols.map((value) => ({ value, label: value })),
);
const hasFilters = computed(
  () => !!(location.value.from || location.value.to || location.value.symbol),
);
const analysisScope = computed(() =>
  list.value?.accountId ? { source: list.value.source, accountId: list.value.accountId } : null,
);
const analysisQuery = computed(() => {
  const query = new URLSearchParams();
  for (const key of ['from', 'to', 'symbol'] as const)
    if (location.value[key]) query.set(key, location.value[key]);
  return query.toString();
});
const columns: TableColumnsType<ReviewSummary> = [
  { title: '交易对', key: 'symbol', dataIndex: 'symbol', width: 136 },
  { title: '方向', key: 'side', width: 80 },
  { title: '状态', key: 'status', width: 120 },
  { title: '净盈亏（USDT）', key: 'netPnl', width: 150, align: 'right' },
  { title: '开仓时间', key: 'openedAt', width: 180 },
  { title: '平仓时间', key: 'closedAt', width: 180 },
  { title: '操作', key: 'action', width: 88 },
];
function pickerValue(value: string) {
  return dateRangeError(value, '') ? undefined : value || undefined;
}
function rowProps(record: ReviewSummary) {
  return {
    class: 'review-table__row',
    onClick: (event: MouseEvent) => {
      if (
        !busy.value &&
        !stale.value &&
        !relogin.value &&
        event.target instanceof Element &&
        !event.target.closest('button, a')
      )
        show(record.id);
    },
  };
}
let previousTrade: string | null = null;
watch(
  () => location.value.tradeId,
  (id, previous) => {
    previousTrade = id ? null : (previous ?? null);
    document.title = id ? '交易详情 · 开仓前' : '交易记录分析 · 开仓前';
  },
  { immediate: true },
);
watch([busy, rows], async () => {
  if (!location.value.tradeId && !busy.value && previousTrade) {
    await nextTick();
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-review-trade]')].find(
      (item) => item.dataset.reviewTrade === previousTrade,
    );
    (button ?? document.getElementById('review-list-title'))?.focus();
    previousTrade = null;
  }
});
watch(trade, async (value) => {
  if (value) {
    await nextTick();
    document.getElementById('trade-detail')?.focus();
  }
});
watch([lastPage, busy], () => {
  if (
    list.value &&
    !busy.value &&
    !stale.value &&
    !location.value.tradeId &&
    location.value.view === 'cycles' &&
    location.value.page > lastPage.value
  )
    paginate(lastPage.value);
});
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="reviewTheme" :auto-insert-space-in-button="false">
    <div class="review-page">
      <header class="page-header">
        <div>
          <Button v-if="location.tradeId" class="review-page__back" @click="back"
            >← 返回交易记录</Button
          >
          <h1 class="page-title">{{ location.tradeId ? '交易详情' : '交易记录分析' }}</h1>
        </div>
        <Button
          v-if="location.tradeId || location.view"
          :aria-label="busy ? '取消读取' : '重新读取'"
          :disabled="relogin"
          @click="busy ? cancelRead() : refresh()"
          >{{ busy ? '取消读取' : '重新读取' }}</Button
        >
      </header>
      <p class="source">{{ source }}</p>
      <div
        v-if="location.tradeId || location.view"
        id="review-status"
        class="review-page__status"
        role="status"
        aria-live="polite"
      >
        <p class="status__message">{{ status }}</p>
        <a v-if="relogin" class="button button--text button--link" href="/login">重新登录</a>
      </div>

      <div v-if="!location.tradeId" class="review-page__actions" aria-label="复盘视图">
        <Button :type="location.view ? 'default' : 'primary'" @click="view()">订单记录</Button>
        <Button :type="location.view ? 'primary' : 'default'" @click="view('cycles')"
          >完整交易复盘</Button
        >
      </div>
      <ReviewOrders
        v-if="!location.tradeId && !location.view"
        :source="expectedSource"
        :location="location"
        @filter="filter"
        @paginate="paginate"
        @trade="show"
      />
      <section v-else-if="!location.tradeId" aria-labelledby="review-list-title">
        <div class="review-filters" role="group" aria-label="交易记录筛选">
          <div class="review-filters__dates">
            <div class="field">
              <label class="field-label" for="review-date-from">开仓开始日期</label>
              <DatePicker
                id="review-date-from"
                class="review-filters__control"
                :value="pickerValue(location.from)"
                value-format="YYYY-MM-DD"
                format="YYYY-MM-DD"
                placeholder="不限开始日期"
                :input-read-only="true"
                :status="rangeError ? 'error' : undefined"
                @update:value="(value) => filter({ from: typeof value === 'string' ? value : '' })"
              />
            </div>
            <div class="field">
              <label class="field-label" for="review-date-to">开仓结束日期</label>
              <DatePicker
                id="review-date-to"
                class="review-filters__control"
                :value="pickerValue(location.to)"
                value-format="YYYY-MM-DD"
                format="YYYY-MM-DD"
                placeholder="不限结束日期"
                :input-read-only="true"
                :status="rangeError ? 'error' : undefined"
                @update:value="(value) => filter({ to: typeof value === 'string' ? value : '' })"
              />
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="review-symbol">交易对</label>
            <Select
              id="review-symbol"
              class="review-filters__control"
              :value="location.symbol || undefined"
              :options="symbolOptions"
              show-search
              allow-clear
              placeholder="全部交易对"
              option-filter-prop="label"
              @update:value="(value) => filter({ symbol: typeof value === 'string' ? value : '' })"
            />
          </div>
          <Button :disabled="!hasFilters" @click="filter({ from: '', to: '', symbol: '' })"
            >重置</Button
          >
          <p v-if="rangeError" class="error review-filters__hint" role="alert">{{ rangeError }}</p>
          <p v-else class="muted review-filters__hint">
            北京时间 · 包含首尾整天 · 一行对应一个交易周期
          </p>
        </div>
        <div class="section-heading">
          <h2 id="review-list-title" class="section-title" tabindex="-1">
            {{ list ? `${list.total} 笔归档交易` : '交易列表' }}
          </h2>
          <p v-if="list" class="muted review-table__count" role="status">
            {{ stale ? '上次匹配' : '当前匹配' }} {{ total }} 笔
          </p>
        </div>
        <p v-if="stale && list" class="error" role="status">
          上次读取结果 · 当前范围需重新读取确认，详情暂不可打开。
        </p>
        <p class="review-table__hint">左右滑动查看更多，点击一行进入详情。</p>
        <Table
          class="review-table"
          :columns="rows.length ? columns : []"
          :data-source="rows"
          row-key="id"
          :pagination="false"
          :loading="busy"
          :scroll="rows.length ? { x: 934 } : undefined"
          :custom-row="rowProps"
          size="middle"
        >
          <template #emptyText>
            <div class="review-table__empty">
              <template v-if="busy">正在读取交易记录…</template>
              <template v-else-if="rangeError">{{ rangeError }}</template>
              <template v-else-if="!list">暂未读取到交易记录，请重新读取。</template>
              <template v-else-if="hasFilters">没有符合条件的交易，请调整日期或交易对。</template>
              <template v-else-if="sync || archive"
                >当前没有可归并的成交记录；查询范围与缺口见同步状态。</template
              >
              <template v-else>尚未同步，无真实交易归档。请展开归档管理并开始同步。</template>
            </div>
          </template>
          <template #bodyCell="{ column, record }">
            <strong v-if="column.key === 'symbol'">{{ record.symbol }}</strong>
            <template v-else-if="column.key === 'side'">{{
              record.side === null ? '待确认' : record.side === 'long' ? '做多' : '做空'
            }}</template>
            <Tag
              v-else-if="column.key === 'status'"
              :color="record.status === 'incomplete' ? 'warning' : undefined"
              >{{
                record.status === 'closed'
                  ? '已结束'
                  : record.status === 'open'
                    ? '持仓中'
                    : '数据不完整'
              }}</Tag
            >
            <span
              v-else-if="column.key === 'netPnl'"
              class="review-table__amount"
              :data-state="
                record.netPnl === null
                  ? 'unknown'
                  : record.netPnl.startsWith('-')
                    ? 'loss'
                    : 'known'
              "
              >{{ record.netPnl ?? '待确认' }}</span
            >
            <time v-else-if="column.key === 'openedAt'" :datetime="record.openedAt ?? undefined">{{
              reviewTime(record.openedAt)
            }}</time>
            <time v-else-if="column.key === 'closedAt'" :datetime="record.closedAt ?? undefined">{{
              record.closedAt
                ? reviewTime(record.closedAt)
                : record.status === 'open'
                  ? '持仓中'
                  : '待确认'
            }}</time>
            <Button
              v-else-if="column.key === 'action'"
              type="link"
              :data-review-trade="record.id"
              :disabled="busy || relogin || stale"
              :aria-label="`查看 ${record.symbol} 交易详情`"
              @click.stop="show(record.id)"
              >详情</Button
            >
          </template>
        </Table>
        <Pagination
          v-if="total > reviewPageSize"
          class="review-table__pagination"
          :current="currentPage"
          :page-size="reviewPageSize"
          :total="total"
          :show-size-changer="false"
          :show-less-items="true"
          responsive
          @change="paginate"
        />
        <p class="footnote">
          净盈亏 = 已实现盈亏 − 手续费 + 资金费净收支；缺失或归属未确认时显示待确认。
        </p>
        <details class="disclosure review-page__statistics">
          <summary class="disclosure__summary">表现统计 · 当前筛选范围</summary>
          <ReviewStatistics v-if="list && !stale" :statistics="list.statistics" />
          <p v-else class="muted">当前统计需重新读取确认。</p>
        </details>
        <TradeAnalysis
          :scope="analysisScope"
          :query="analysisQuery"
          :total="total"
          :unavailable="busy || stale || !!rangeError"
        />
        <ReviewArchive v-if="expectedSource === 'binance'" :review="review" />
        <ReviewBackup
          :source="expectedSource"
          :account-id="list?.accountId ?? null"
          :query="analysisQuery"
          :disabled="busy || relogin || stale || !!rangeError"
          @restored="refresh"
        />
      </section>

      <template v-else>
        <ReviewTradeDetail v-if="trade" :trade="trade" :analysis-query="analysisQuery" />
        <p v-else class="muted">
          {{ busy ? '正在读取交易详情…' : '详情暂不可用，请重新读取或返回交易记录。' }}
        </p>
      </template>
      <details v-show="location.tradeId && trade" class="disclosure review-page__notes" open>
        <summary class="disclosure__summary">个人笔记与风格标签</summary>
        <ReviewNotes
          :source="expectedSource"
          :account-id="list?.accountId ?? null"
          :trade="trade"
          @journal-saved="journalSaved"
        />
      </details>
    </div>
  </ConfigProvider>
</template>
