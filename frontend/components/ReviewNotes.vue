<script setup lang="ts">
import type { ReviewJournal } from '../../src/review-notes.ts';
import type { ReviewTrade } from '../../src/review-ledger.ts';
import { useReviewNotes } from '../useReviewNotes.ts';
const props = defineProps<{
  source: 'binance' | 'demo';
  accountId: string | null;
  trade: ReviewTrade | null;
}>();
const {
  staleBasis,
  journal,
  draft,
  savedNote,
  pendingNotes,
  status,
  busy,
  relogin,
  refresh,
  save: saveNoteContent,
  tagName,
  editingTag,
  editTag,
  saveTag: saveStyleTag,
  reloadSaved,
} = useReviewNotes(
  props.source,
  () => props.accountId,
  () => props.trade,
);
const emit = defineEmits<{ 'journal-saved': [journal: ReviewJournal] }>();
async function save() {
  const journal = await saveNoteContent();
  if (journal) emit('journal-saved', journal);
}
async function saveTag(active?: boolean) {
  const journal = await saveStyleTag(active);
  if (journal) emit('journal-saved', journal);
}
const fields = [
  { key: 'entryReason', label: '入场理由' },
  { key: 'exitReason', label: '退出理由（用户自述）' },
  { key: 'executionProblem', label: '执行问题' },
  { key: 'improvement', label: '改进事项' },
  { key: 'freeNote', label: '自由笔记' },
] as const;
function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
function tagLabel(id: string) {
  return journal.value?.tags.find((tag) => tag.id === id)?.name ?? '未知标签';
}
</script>

<template>
  <section v-if="accountId" class="review-page__detail" aria-labelledby="personal-notes-title">
    <h2 id="personal-notes-title" class="section-title">个人笔记 · 用户自述</h2>
    <p class="muted">笔记与风格标签是你确认的记录，独立于交易所事实及订单类型。</p>
    <p class="muted">
      模型风格推测见复盘报告，只有在此保存后才成为个人标签。分析时是否发送笔记需另行选择。
    </p>
    <div id="note-status" class="status" role="status" aria-live="polite">
      <p class="status__message">{{ status }}</p>
      <a v-if="relogin" class="button button--text button--link" href="/login">重新登录</a>
    </div>
    <button
      class="button button--secondary"
      type="button"
      :disabled="busy || relogin"
      @click="refresh"
    >
      重新读取笔记与标签
    </button>
    <p v-if="staleBasis" class="error">
      当前草稿的交易依据已变化；输入保留，请重新读取笔记并载入保存版本后编辑。原笔记如归属不明确，可在下方待确认档案查看。
    </p>
    <form v-if="trade && draft" class="review-notes__form" @submit.prevent="save">
      <p class="muted">
        {{ source === 'demo' ? '演示' : 'Binance' }} · {{ accountId }} · {{ trade.symbol }} ·
        {{ trade.id }}
      </p>
      <div v-for="field in fields" :key="field.key" class="field">
        <label class="field-label" :for="`note-${field.key}`">{{ field.label }}</label>
        <textarea
          :id="`note-${field.key}`"
          v-model="draft[field.key]"
          class="field-control review-notes__text"
          :maxlength="field.key === 'freeNote' ? 10000 : 2000"
          rows="3"
        />
      </div>
      <fieldset class="review-notes__tags">
        <legend class="field-label">交易风格标签 · 用户确认</legend>
        <label
          v-for="tag in journal?.tags.filter((tag) => tag.active || draft?.tagIds.includes(tag.id))"
          :key="tag.id"
          class="review-notes__tag"
        >
          <input
            v-model="draft.tagIds"
            type="checkbox"
            :value="tag.id"
            :disabled="!tag.active && !draft.tagIds.includes(tag.id)"
          />
          {{ tag.name }}{{ tag.active ? '' : '（已停用）' }}
        </label>
        <p v-if="!journal?.tags.length" class="muted">暂无标签，可在下方新建。</p>
      </fieldset>
      <p v-if="savedNote" class="muted">
        保存时间：{{ time(savedNote.updatedAt) }} · 版本 {{ savedNote.version }}
      </p>
      <div class="review-notes__actions">
        <button
          class="button button--primary"
          type="submit"
          :disabled="busy || relogin"
          :aria-busy="busy"
        >
          保存笔记
        </button>
        <button
          class="button button--secondary"
          type="button"
          :disabled="busy || relogin"
          @click="reloadSaved"
        >
          载入已保存版本
        </button>
      </div>
    </form>
    <p v-else class="muted">打开单笔交易详情后填写；持仓中和不完整记录也可保存笔记。</p>
    <details class="disclosure">
      <summary class="disclosure__summary">维护交易风格标签</summary>
      <form class="review-notes__form" @submit.prevent="saveTag()">
        <div class="field">
          <label class="field-label" for="style-tag-name">{{
            editingTag ? '标签名称' : '新标签名称'
          }}</label>
          <input
            id="style-tag-name"
            v-model="tagName"
            class="field-control"
            type="text"
            maxlength="40"
            required
            :disabled="busy || relogin"
          />
        </div>
        <div class="review-notes__actions">
          <button class="button button--secondary" type="submit" :disabled="busy || relogin">
            {{ editingTag ? '保存标签' : '新建标签' }}
          </button>
          <button
            v-if="editingTag?.active"
            class="button button--text"
            type="button"
            :disabled="busy || relogin"
            @click="saveTag(false)"
          >
            停用标签（保留历史）
          </button>
          <button
            v-if="editingTag"
            class="button button--text"
            type="button"
            :disabled="busy"
            @click="
              editingTag = null;
              tagName = '';
            "
          >
            取消编辑标签
          </button>
        </div>
      </form>
      <ul class="review-page__list">
        <li v-for="tag in journal?.tags" :key="tag.id" class="review-notes__tag">
          <span>{{ tag.name }}{{ tag.active ? '' : '（已停用）' }}</span>
          <button
            class="button button--text"
            type="button"
            :disabled="busy || relogin"
            :aria-label="`编辑标签 ${tag.name}`"
            @click="editTag(tag)"
          >
            编辑
          </button>
        </li>
      </ul>
      <p class="muted">重命名更新已应用标签的显示；停用后历史关联保留，不能再应用到新笔记。</p>
    </details>
    <details v-if="pendingNotes.length" class="disclosure">
      <summary class="disclosure__summary">归属待确认笔记 · {{ pendingNotes.length }} 条</summary>
      <article v-for="note in pendingNotes" :key="note.id" class="review-page__detail">
        <h3 class="section-title">{{ note.trade.symbol }} · 归属待确认</h3>
        <p class="muted">归并依据已变化，原笔记及原依据保留，未自动迁移。</p>
        <p class="muted">
          {{ note.trade.source }} · {{ note.trade.accountId }} · 原交易 {{ note.trade.id }} ·
          归并版本 {{ note.trade.groupingVersion }}
        </p>
        <p class="muted">保存时间：{{ time(note.updatedAt) }}</p>
        <p v-for="field in fields" :key="field.key" class="review-notes__content">
          {{ field.label }}：{{ note[field.key] || '未填写' }}
        </p>
        <p class="muted">用户确认标签：{{ note.tagIds.map(tagLabel).join('、') || '未填写' }}</p>
        <details class="disclosure">
          <summary class="disclosure__summary">保存时的交易依据</summary>
          <p class="review-notes__content">{{ JSON.stringify(note.trade) }}</p>
        </details>
      </article>
    </details>
  </section>
</template>
