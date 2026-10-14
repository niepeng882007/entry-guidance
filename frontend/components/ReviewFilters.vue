<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { Button, DatePicker, Select } from 'ant-design-vue';
import { dateRangeError, type ReviewLocation } from '../review-records';

type Filters = Pick<ReviewLocation, 'from' | 'to' | 'symbol'>;
const props = defineProps<{
  location: Filters;
  symbols: { value: string; label: string }[];
  idPrefix: string;
  dateLabel: '订单' | '开仓';
  label: string;
  disabled: boolean;
}>();
const emit = defineEmits<{ query: [filters: Filters] }>();
const draft = reactive<Filters>({ from: '', to: '', symbol: '' });
watch(
  () => [props.location.from, props.location.to, props.location.symbol],
  () =>
    Object.assign(draft, {
      from: props.location.from,
      to: props.location.to,
      symbol: props.location.symbol,
    }),
  { immediate: true },
);
const error = computed(() => dateRangeError(draft.from, draft.to));
const hasFilters = computed(
  () =>
    !!(
      draft.from ||
      draft.to ||
      draft.symbol ||
      props.location.from ||
      props.location.to ||
      props.location.symbol
    ),
);
function pickerValue(value: string) {
  return dateRangeError(value, '') ? undefined : value || undefined;
}
function query() {
  if (!error.value && !props.disabled) emit('query', { ...draft });
}
function reset() {
  Object.assign(draft, { from: '', to: '', symbol: '' });
  emit('query', { ...draft });
}
</script>

<template>
  <form class="review-filters" role="group" :aria-label="label" @submit.prevent="query">
    <div class="field">
      <label class="field-label" :for="`${idPrefix}-from`">{{ dateLabel }}开始日期</label>
      <DatePicker
        :id="`${idPrefix}-from`"
        class="review-filters__control"
        :value="pickerValue(draft.from)"
        value-format="YYYY-MM-DD"
        format="YYYY-MM-DD"
        placeholder="不限开始日期"
        :input-read-only="true"
        :status="error ? 'error' : undefined"
        @update:value="(value) => (draft.from = typeof value === 'string' ? value : '')"
      />
    </div>
    <div class="field">
      <label class="field-label" :for="`${idPrefix}-to`">{{ dateLabel }}结束日期</label>
      <DatePicker
        :id="`${idPrefix}-to`"
        class="review-filters__control"
        :value="pickerValue(draft.to)"
        value-format="YYYY-MM-DD"
        format="YYYY-MM-DD"
        placeholder="不限结束日期"
        :input-read-only="true"
        :status="error ? 'error' : undefined"
        @update:value="(value) => (draft.to = typeof value === 'string' ? value : '')"
      />
    </div>
    <div class="field">
      <label class="field-label" :for="`${idPrefix}-symbol`">交易对</label>
      <Select
        :id="`${idPrefix}-symbol`"
        class="review-filters__control"
        :value="draft.symbol || undefined"
        :options="symbols"
        show-search
        allow-clear
        placeholder="全部交易对"
        option-filter-prop="label"
        @update:value="(value) => (draft.symbol = typeof value === 'string' ? value : '')"
      />
    </div>
    <div class="review-filters__actions">
      <Button html-type="submit" type="primary" :disabled="disabled || !!error">查询</Button>
      <Button :disabled="!hasFilters" @click="reset">重置</Button>
    </div>
    <p v-if="error" class="error review-filters__hint" role="alert">{{ error }}</p>
    <p v-else class="muted review-filters__hint">北京时间 · 包含首尾整天 · 点击查询应用筛选</p>
  </form>
</template>
