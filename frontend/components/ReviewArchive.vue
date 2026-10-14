<script setup lang="ts">
import type { useReviewPage } from '../useReviewPage';
import { reviewTime as time } from '../review-records';
const props = defineProps<{ review: ReturnType<typeof useReviewPage> }>();
const {
  list,
  busy,
  relogin,
  symbol,
  symbols,
  sync,
  startSync,
  evidence,
  readEvidence,
  archive,
  archiveIssue,
  startArchive,
} = props.review;
</script>

<template>
  <details class="disclosure review-archive">
    <summary class="disclosure__summary">归档管理 · 同步进度与原始证据</summary>
    <section class="review-page__detail" aria-labelledby="account-archive-title">
      <h2 id="account-archive-title" class="section-title">全账户历史归档</h2>
      <p class="muted">
        首次读取最近 3 个月；服务运行期间每 5 分钟增量归档。关闭页面继续，服务停止暂停，重启后补查。
      </p>
      <button
        class="button button--primary"
        type="button"
        :disabled="busy || relogin || archive?.status === 'running' || sync?.status === 'running'"
        :aria-busy="archive?.status === 'running'"
        @click="startArchive"
      >
        立即同步全账户
      </button>
      <p v-if="archiveIssue" class="error">后台归档暂停：{{ archiveIssue }}</p>
      <div v-if="archive">
        <p class="muted">
          本轮已读取合约：{{ archive.completedSymbols.length }} / {{ archive.symbols.length }} ·
          待完成 {{ archive.pendingSymbols.length }} 个
        </p>
        <p class="muted">
          归档范围：{{ time(new Date(archive.startTime).toISOString()) }} 至
          {{ time(new Date(archive.endTime).toISOString()) }}
        </p>
        <p class="muted">最后成功时间：{{ time(archive.lastSuccessAt) }}</p>
        <p class="muted">
          全账户发现：已读取 {{ archive.discovery.pages }} 页 ·
          {{ archive.discovery.pending.length }} 个待完成区间
        </p>
        <p v-for="item in archive.scopeMissing" :key="item" class="muted">{{ item }}</p>
        <p v-if="archive.missing.length" class="error">
          账户同步缺口：{{ archive.missing.join('；') }}
        </p>
        <p v-if="archive.discovery.missing.length" class="error">
          发现缺口：{{ archive.discovery.missing.join('；') }}
        </p>
        <details class="disclosure">
          <summary class="disclosure__summary">合约进度与缺失区间</summary>
          <p v-for="symbolName in archive.pendingSymbols" :key="symbolName" class="muted">
            {{ symbolName }} · 本轮尚未读完
          </p>
          <p
            v-for="(range, index) in archive.discovery.pending"
            :key="`discovery-${index}`"
            class="muted"
          >
            全账户 income · {{ time(new Date(range.startTime).toISOString()) }} 至
            {{ time(new Date(range.endTime).toISOString()) }} · 第 {{ range.page }} 页
          </p>
          <article v-for="contract in archive.contracts" :key="contract.symbol" class="review-fill">
            <h3 class="section-title">{{ contract.symbol }}</h3>
            <p class="muted">
              {{
                {
                  running: '读取中',
                  complete: '读取结束',
                  failed: '读取失败',
                  interrupted: '读取中断',
                }[contract.status]
              }}
              · {{ contract.pages }} 页 · {{ contract.pending.length }} 个待完成区间
            </p>
            <p class="muted">最后成功时间：{{ time(contract.lastSuccessAt) }}</p>
            <p v-if="contract.missing.length" class="error">{{ contract.missing.join('；') }}</p>
            <p
              v-for="(range, index) in [...contract.pending, ...(contract.unavailable ?? [])]"
              :key="index"
              class="muted"
            >
              {{ range.source }} · {{ time(new Date(range.startTime).toISOString()) }} 至
              {{ time(new Date(range.endTime).toISOString()) }} · 第 {{ range.page }} 页
            </p>
          </article>
        </details>
      </div>
      <p v-else class="muted">尚无全账户读取进度；身份或权限未确认时暂停新增归档。</p>
    </section>
    <section class="review-page__detail" aria-labelledby="history-sync-title">
      <h2 id="history-sync-title" class="section-title">同步单币种真实历史</h2>
      <p class="muted">最近 3 个月 · 可单独补查合约，包括已下架合约。与全账户归档协调执行。</p>
      <form class="review-page__sync" @submit.prevent="startSync">
        <div class="field">
          <label class="field-label" for="history-symbol">USDT 永续合约</label>
          <input
            id="history-symbol"
            v-model="symbol"
            class="field-control"
            list="history-symbols"
            type="text"
            maxlength="34"
            required
            :disabled="
              busy || relogin || sync?.status === 'running' || archive?.status === 'running'
            "
          />
          <datalist id="history-symbols">
            <option v-for="value in symbols" :key="value" :value="value" />
          </datalist>
        </div>
        <button
          class="button button--primary"
          type="submit"
          :disabled="busy || relogin || sync?.status === 'running' || archive?.status === 'running'"
          :aria-busy="busy || sync?.status === 'running'"
        >
          开始同步
        </button>
      </form>
      <div v-if="sync">
        <p class="muted">
          {{ sync.symbol }} · 查询范围：{{ time(new Date(sync.startTime).toISOString()) }} 至
          {{ time(new Date(sync.endTime).toISOString()) }}
        </p>
        <p class="muted">
          已读取 {{ sync.pages }} 页 · {{ sync.records }} 条原始记录（含分片重复） ·
          {{ sync.pending.length }} 个待完成区间
        </p>
        <p class="muted">最后成功时间：{{ time(sync.lastSuccessAt) }}</p>
        <p v-if="sync.missing.length" class="error">同步缺口：{{ sync.missing.join('；') }}</p>
        <details v-if="sync.pending.length" class="disclosure">
          <summary class="disclosure__summary">待补查区间</summary>
          <p v-for="(range, index) in sync.pending" :key="index" class="muted">
            {{ range.source }} · {{ time(new Date(range.startTime).toISOString()) }} 至
            {{ time(new Date(range.endTime).toISOString()) }} · 第 {{ range.page }} 页
          </p>
        </details>
      </div>
      <button
        class="button button--secondary"
        type="button"
        :disabled="busy || relogin || !list?.accountId"
        @click="readEvidence()"
      >
        查看所选合约原始证据
      </button>
      <section v-if="evidence" aria-label="原始历史证据">
        <h3 class="section-title">{{ evidence.symbol }} · 原始历史证据</h3>
        <p class="muted">收入流水按来源保留；未能唯一关联交易的资金费不计入已确认净盈亏。</p>
        <details
          v-for="record in evidence.records"
          :key="`${record.kind}-${record.id}`"
          class="disclosure"
        >
          <summary class="disclosure__summary">
            {{ record.kind }} · {{ record.id }} · {{ time(new Date(record.time).toISOString()) }}
          </summary>
          <p>{{ JSON.stringify(record.payload) }}</p>
        </details>
        <button
          v-if="evidence.nextOffset !== null"
          class="button button--secondary"
          type="button"
          :disabled="busy || relogin"
          @click="readEvidence(evidence.nextOffset)"
        >
          下一页原始证据
        </button>
      </section>
    </section>
  </details>
</template>
