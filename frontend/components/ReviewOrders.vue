<script setup lang="ts">
import { computed, watch } from 'vue';
import { Button, DatePicker, Pagination, Select, Table } from 'ant-design-vue';
import type { TableColumnsType } from 'ant-design-vue';
import type { OrderRecord } from '../../src/review-orders.ts';
import type { ReviewLocation } from '../review-records';
import { dateRangeError, reviewTime } from '../review-records';
import { useReviewOrders, orderStatus } from '../useReviewOrders';

const props = defineProps<{ source: 'demo' | 'binance'; location: ReviewLocation }>();
const emit = defineEmits<{
  filter: [value: Partial<Pick<ReviewLocation, 'from' | 'to' | 'symbol'>>];
  paginate: [page: number];
  trade: [id: string];
}>();
const { list, busy, updating, stale, relogin, message, read, update } = useReviewOrders(
  props.source,
  () => props.location,
);
const error = computed(() => dateRangeError(props.location.from, props.location.to));
const symbols = computed(() =>
  (list.value?.symbols ?? []).map((value) => ({ value, label: value })),
);
watch(list, (value) => {
  if (value && props.location.page > Math.max(1, Math.ceil(value.total / value.pageSize)))
    emit('paginate', Math.max(1, Math.ceil(value.total / value.pageSize)));
});
const columns: TableColumnsType<OrderRecord> = [
  { title: '订单时间（北京）', key: 'time', width: 165 },
  { title: '交易对', dataIndex: 'symbol', width: 115 },
  { title: '类型', key: 'type', dataIndex: 'type', width: 90 },
  { title: '方向', key: 'side', width: 70 },
  { title: '成交均价', key: 'avgPrice', width: 110, align: 'right' },
  { title: '执行数量', key: 'executedQty', width: 110, align: 'right' },
  { title: '已实现盈亏（USDT）', key: 'realizedPnl', width: 160, align: 'right' },
  { title: '状态', key: 'status', width: 100 },
];
function fees(value: OrderRecord['commissions']) {
  return value?.map((fee) => `${fee.amount} ${fee.asset}`).join('；') || (value ? '0' : '待补齐');
}
function pnlState(value: string | null) {
  if (value === null) return 'unknown';
  return value.startsWith('-') ? 'loss' : 'known';
}
</script>

<template>
  <section class="review-orders" aria-labelledby="review-orders-title">
    <h2 id="review-orders-title" class="section-title">订单记录</h2>
    <div class="review-filters" role="group" aria-label="订单记录筛选">
      <div class="review-filters__dates">
        <div class="field">
          <label class="field-label" for="order-from">订单开始日期</label>
          <DatePicker
            id="order-from"
            class="review-filters__control"
            :value="location.from || undefined"
            value-format="YYYY-MM-DD"
            format="YYYY-MM-DD"
            :input-read-only="true"
            placeholder="不限开始日期"
            @update:value="
              (value) => emit('filter', { from: typeof value === 'string' ? value : '' })
            "
          />
        </div>
        <div class="field">
          <label class="field-label" for="order-to">订单结束日期</label>
          <DatePicker
            id="order-to"
            class="review-filters__control"
            :value="location.to || undefined"
            value-format="YYYY-MM-DD"
            format="YYYY-MM-DD"
            :input-read-only="true"
            placeholder="不限结束日期"
            @update:value="
              (value) => emit('filter', { to: typeof value === 'string' ? value : '' })
            "
          />
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="order-symbol">交易对</label>
        <Select
          id="order-symbol"
          class="review-filters__control"
          :value="location.symbol || undefined"
          :options="symbols"
          show-search
          allow-clear
          placeholder="全部交易对"
          @update:value="
            (value) => emit('filter', { symbol: typeof value === 'string' ? value : '' })
          "
        />
      </div>
      <Button @click="emit('filter', { from: '', to: '', symbol: '' })">重置</Button>
    </div>
    <div class="review-page__actions">
      <Button
        v-if="source === 'binance'"
        type="primary"
        :disabled="updating || relogin"
        :loading="updating"
        @click="update()"
        >手动更新至当前</Button
      >
      <Button :disabled="busy || relogin || !!error" @click="read">读取本地记录</Button>
      <Button
        v-if="source === 'binance'"
        :disabled="updating || relogin || !!error || !location.from || !location.to"
        @click="update(true)"
        >补查所选日期</Button
      >
      <a v-if="relogin" href="/login">重新登录</a>
    </div>
    <p class="muted" role="status">{{ error || message }}</p>
    <p v-if="source === 'binance'" class="muted">
      手动更新或补查可能使用一次文件生成额度；未完成任务会继续查询，不重复生成。
    </p>
    <p v-if="stale" class="error">上次读取结果，当前筛选范围尚未确认。</p>
    <p class="muted">
      当前匹配 {{ list?.total ?? 0 }} 张订单；展开查看订单编号、费用与完整交易复盘。
    </p>
    <Table
      class="review-table"
      row-key="id"
      :columns="columns"
      :data-source="list?.orders ?? []"
      :pagination="false"
      :loading="busy"
      :scroll="{ x: 960 }"
    >
      <template #emptyText>当前没有订单记录；手动更新后可查看。</template>
      <template #bodyCell="{ column, record }">
        <time v-if="column.key === 'time'">{{ reviewTime(record.time) }}</time>
        <template v-else-if="column.key === 'type'">{{ record.type ?? '未知' }}</template>
        <template v-else-if="column.key === 'side'">{{
          record.side === 'BUY' ? '买入' : '卖出'
        }}</template>
        <template v-else-if="column.key === 'status'">{{ orderStatus(record.status) }}</template>
        <span
          v-else-if="['avgPrice', 'executedQty', 'realizedPnl'].includes(String(column.key))"
          class="review-table__amount"
          :data-state="column.key === 'realizedPnl' ? pnlState(record.realizedPnl) : undefined"
          >{{
            record[String(column.key)] ?? (column.key === 'realizedPnl' ? '待补齐' : '未知')
          }}</span
        >
      </template>
      <template #expandedRowRender="{ record }">
        <dl class="details review-orders__details">
          <div class="details__row">
            <dt class="details__term">订单编号</dt>
            <dd class="details__value">{{ record.orderId }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">委托价格 / 数量</dt>
            <dd class="details__value">
              {{ record.price ?? '未知' }} / {{ record.quantity ?? '未知' }}
            </dd>
          </div>
          <div class="details__row">
            <dt class="details__term">已执行报价金额</dt>
            <dd class="details__value">{{ record.quoteQty ?? '未知' }} USDT</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">止损价格</dt>
            <dd class="details__value">{{ record.stopPrice ?? '未知' }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">更新时间</dt>
            <dd class="details__value">{{ reviewTime(record.updateTime) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">手续费</dt>
            <dd class="details__value">{{ fees(record.commissions) }}</dd>
          </div>
        </dl>
        <p v-for="item in record.missing" :key="item" class="muted">{{ item }}</p>
        <Button v-for="id in record.tradeIds" :key="id" :disabled="stale" @click="emit('trade', id)"
          >查看完整交易复盘</Button
        >
        <p v-if="!record.tradeIds.length" class="muted">
          尚未关联完整交易周期；未成交订单也会保留。
        </p>
      </template>
    </Table>
    <Pagination
      v-if="(list?.total ?? 0) > 20"
      class="review-table__pagination"
      :current="location.page"
      :total="list?.total ?? 0"
      :page-size="20"
      :show-size-changer="false"
      @change="(page) => emit('paginate', page)"
    />
    <p class="footnote">
      已实现盈亏汇总本订单成交结果，不含手续费及资金费；成交未补齐时不以零代替。完整交易胜率、净盈亏和
      AI 分析在完整交易复盘中查看。
    </p>
    <details v-if="list?.archive" class="disclosure">
      <summary class="disclosure__summary">本次手动更新进度</summary>
      <p v-if="list.archive.orderDownload">{{ list.archive.orderDownload.message }}</p>
      <p>
        状态：{{ list.archive.status }} · 已完成 {{ list.archive.completedSymbols.length }} /
        {{ list.archive.symbols.length }} 个合约
      </p>
      <p
        v-for="item in [...list.archive.missing, ...list.archive.scopeMissing]"
        :key="item"
        class="muted"
      >
        {{ item }}
      </p>
    </details>
  </section>
</template>
