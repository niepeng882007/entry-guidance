<script setup lang="ts">
import { useReviewBackup } from '../useReviewBackup';
const props = defineProps<{
  source: 'demo' | 'binance';
  accountId: string | null;
  query: string;
  disabled: boolean;
}>();
const emit = defineEmits<{ restored: [] }>();
const {
  busy,
  status,
  relogin,
  preview,
  overwrite,
  versions,
  readFile,
  confirm,
  csv,
  download,
  readVersions,
} = useReviewBackup(
  props.source,
  () => props.accountId,
  () => props.query,
  () => emit('restored'),
);
function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}
</script>

<template>
  <details class="disclosure review-backup">
    <summary class="disclosure__summary">导出与备份恢复</summary>
    <section class="review-page__detail" aria-labelledby="review-backup-title">
      <h2 id="review-backup-title" class="section-title">交易导出与完整账本备份</h2>
      <p class="muted">
        CSV 包含当前筛选范围的全部交易。完整 JSON 备份包含账户交易证据、个人笔记与报告，请妥善保存。
      </p>
      <div class="review-backup__actions">
        <button
          class="button button--secondary"
          type="button"
          :disabled="disabled || busy || relogin || !accountId"
          @click="csv"
        >
          导出筛选范围 CSV
        </button>
        <button
          class="button button--secondary"
          type="button"
          :disabled="disabled || busy || relogin || !accountId"
          @click="download"
        >
          下载完整备份
        </button>
      </div>
      <div class="field">
        <label for="review-backup-file" class="field-label"
          >选择 JSON 备份并预览（上限 64 MiB）</label
        >
        <input
          id="review-backup-file"
          class="field-control"
          type="file"
          accept=".json,application/json"
          :disabled="disabled || busy || relogin || !accountId"
          @change="readFile"
        />
      </div>
      <p class="muted">
        仅接受同账户、同真实或模拟模式的备份。默认补入缺失记录，保留当前冲突版本；笔记和标签的备份版本保留为可查看旧版本。
      </p>
      <div class="status" role="status" aria-live="polite" :aria-busy="busy">
        <p class="status__message">{{ status }}</p>
        <a v-if="relogin" class="button button--text button--link" href="/login">重新登录</a>
      </div>
      <section v-if="preview" aria-label="恢复预览">
        <h3 class="section-title">恢复预览</h3>
        <p>
          新增 {{ preview.added }} · 重复 {{ preview.duplicates }} · 冲突
          {{ preview.conflicts.length }} · 拒绝 {{ preview.rejected.length }}
        </p>
        <p v-for="(reason, index) in preview.rejected" :key="index" class="error">{{ reason }}</p>
        <details v-for="conflict in preview.conflicts" :key="conflict.key" class="disclosure">
          <summary class="disclosure__summary">{{ conflict.table }} · {{ conflict.id }}</summary>
          <label v-if="conflict.overwritable" class="field-label">
            <input v-model="overwrite" type="checkbox" :value="conflict.key" :disabled="busy" />
            覆盖此条个人记录（保留双方旧版本）
          </label>
          <p v-else class="muted">
            此项保留当前记录；不同身份或标签关联冲突的个人记录保留为旧版本。
          </p>
          <p class="muted">当前版本</p>
          <pre class="review-backup__json">{{ json(conflict.current) }}</pre>
          <p class="muted">备份版本</p>
          <pre class="review-backup__json">{{ json(conflict.incoming) }}</pre>
        </details>
        <p class="muted">
          任何拒绝项均阻止整份恢复。同步区间需重新读取确认；恢复不会自动调用模型。
        </p>
        <button
          class="button button--primary"
          type="button"
          :disabled="disabled || busy || relogin || preview.rejected.length > 0"
          @click="confirm"
        >
          确认恢复
        </button>
      </section>
      <button
        class="button button--text"
        type="button"
        :disabled="disabled || busy || relogin || !accountId"
        @click="readVersions"
      >
        查看恢复旧版本
      </button>
      <section v-if="versions.length" aria-label="恢复旧版本">
        <h3 class="section-title">恢复旧版本 · {{ versions.length }} 条</h3>
        <details v-for="version in versions" :key="version.id" class="disclosure">
          <summary class="disclosure__summary">
            {{ version.kind === 'review_notes' ? '笔记' : '标签' }} · {{ version.recordId }}
          </summary>
          <pre class="review-backup__json">{{ json(version.value) }}</pre>
        </details>
      </section>
    </section>
  </details>
</template>
