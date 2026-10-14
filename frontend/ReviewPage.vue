<script setup lang="ts">
import type { ReviewTrade } from '../src/review-ledger.ts';
import { nextTick } from 'vue';
import { useReviewPage } from './useReviewPage.ts';
const { source, expectedSource } = defineProps<{
  source: string;
  expectedSource: 'binance' | 'demo';
}>();
const {
  list,
  trade,
  busy,
  relogin,
  status,
  refresh,
  open,
  symbol,
  symbols,
  sync,
  startSync,
  evidence,
  readEvidence,
  archive,
  archiveIssue,
  startArchive,
} = useReviewPage(expectedSource);
const orderTypes: Record<string, string> = {
  LIMIT: '限价单',
  MARKET: '市价单',
  STOP: '止损限价单',
  STOP_MARKET: '止损市价单',
  TAKE_PROFIT: '止盈限价单',
  TAKE_PROFIT_MARKET: '止盈市价单',
  TRAILING_STOP_MARKET: '追踪止损单',
};
const events = { entry: '开仓', add: '加仓', reduce: '减仓', exit: '平仓' };
function executionType(value: ReviewTrade, entry: boolean) {
  const fills = value.evidence.fills.filter((fill) =>
    value.groupingVersion === 2
      ? entry
        ? fill.event === 'entry' || fill.event === 'add'
        : fill.event === 'reduce' || fill.event === 'exit'
      : value.side !== null && (fill.side === (value.side === 'long' ? 'BUY' : 'SELL')) === entry,
  );
  const types = [
    ...new Set(
      fills.map((fill) => {
        const type = value.evidence.orders.find((order) => order.id === fill.orderId)?.type;
        return type ? (orderTypes[type] ?? type) : '未知';
      }),
    ),
  ];
  return types.length > 1 ? `混合（${types.join('、')}）` : (types[0] ?? '未知');
}
function time(value: string | null) {
  return value === null ? '待确认' : new Date(value).toLocaleString('zh-CN', { hour12: false });
}
function amount(value: string | null, asset: string | null = 'USDT') {
  return value === null ? '待确认' : `${value} ${asset ?? '未知资产'}`;
}
function duration(opened: string | null, closed: string | null) {
  if (!opened || !closed) return '待确认';
  const minutes = Math.floor((Date.parse(closed) - Date.parse(opened)) / 60_000);
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
async function show(id: string) {
  await open(id);
  await nextTick();
  if (trade.value) document.getElementById('trade-detail')?.focus();
}
</script>

<template>
  <main class="page review-page">
    <nav class="review-page__nav" aria-label="复盘页面">
      <a class="button button--text button--link" href="/">返回工作台</a>
      <a class="button button--text button--link" href="/account">账户快照</a>
      <form action="/logout" method="post">
        <button class="button button--text" type="submit">退出登录</button>
      </form>
    </nav>
    <header class="page-header">
      <h1 class="page-title">交易复盘</h1>
      <span class="tag">长期归档 · 只读</span>
    </header>
    <p class="source">{{ source }}</p>
    <div class="status" role="status" aria-live="polite">
      <p class="status__message">{{ status }}</p>
      <a v-if="relogin" class="button button--text button--link" href="/login">重新登录</a>
    </div>
    <section
      v-if="expectedSource === 'binance'"
      class="review-page__detail"
      aria-labelledby="account-archive-title"
    >
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
    <section
      v-if="expectedSource === 'binance'"
      class="review-page__detail"
      aria-labelledby="history-sync-title"
    >
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
    <div class="section-heading">
      <h2 class="section-title">{{ list ? `${list.trades.length} 笔归档交易` : '交易列表' }}</h2>
      <button
        class="button button--secondary"
        type="button"
        :disabled="busy || relogin"
        :aria-busy="busy"
        @click="refresh"
      >
        重新读取
      </button>
    </div>
    <p v-if="list && !list.trades.length" class="muted">
      {{
        sync || archive
          ? '当前没有可归并的成交记录；查询范围与缺口见同步状态。'
          : '尚未同步，无真实交易归档。请选择合约并开始同步。'
      }}
    </p>
    <ul v-if="list?.trades.length" class="review-page__list">
      <li v-for="item in list.trades" :key="item.id" class="review-page__record">
        <div class="section-heading">
          <h3 class="section-title">
            {{ item.symbol }} ·
            {{ item.side === null ? '方向待确认' : item.side === 'long' ? '做多' : '做空' }}
          </h3>
          <span class="tag">{{
            item.status === 'closed' ? '已结束' : item.status === 'open' ? '持仓中' : '数据不完整'
          }}</span>
        </div>
        <p class="amount review-page__amount">{{ amount(item.netPnl) }}</p>
        <p class="muted">复盘净盈亏 · 已实现盈亏 − 手续费 + 资金费净收支</p>
        <dl class="details details--card">
          <div class="details__row">
            <dt class="details__term">开仓时间</dt>
            <dd class="details__value">{{ time(item.openedAt) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">平仓时间</dt>
            <dd class="details__value">{{ time(item.closedAt) }}</dd>
          </div>
          <div class="details__row">
            <dt class="details__term">持仓时长</dt>
            <dd class="details__value">
              {{ duration(item.openedAt, item.closedAt ?? item.observedAt ?? null) }}
            </dd>
          </div>
        </dl>
        <button
          class="button button--secondary"
          type="button"
          :disabled="busy || relogin"
          :aria-label="`查看 ${item.symbol} 交易详情`"
          aria-controls="trade-detail"
          @click="show(item.id)"
        >
          查看交易详情
        </button>
      </li>
    </ul>
    <section
      v-if="trade"
      id="trade-detail"
      class="review-page__detail"
      tabindex="-1"
      aria-labelledby="trade-detail-title"
    >
      <h2 id="trade-detail-title" class="section-title">{{ trade.symbol }} · 单笔交易详情</h2>
      <p class="muted">
        {{ trade.source === 'demo' ? '演示' : 'Binance' }} · {{ trade.accountId }}
      </p>
      <p class="muted">交易身份：{{ trade.id }} · 归并版本 {{ trade.groupingVersion }}</p>
      <p class="muted">
        {{
          trade.evidence.startPosition === '0' &&
          trade.evidence.endPosition === '0' &&
          trade.evidence.fillsComplete
            ? '已对账空仓起点与终点'
            : trade.status === 'open'
              ? '持仓中 · 已对账空仓起点与查询时点持仓'
              : '交易片段 · 起点或退出待确认'
        }}
        · {{ trade.side === null ? '方向待确认' : trade.side === 'long' ? '做多' : '做空' }}
      </p>
      <p class="muted">
        退出原因：{{
          trade.exitReason === 'LIQUIDATION' ? '强平' : trade.exitReason === 'ADL' ? 'ADL' : '未知'
        }}
      </p>
      <p class="muted">
        入场类型：{{ executionType(trade, true) }} · 退出类型：{{ executionType(trade, false) }}
      </p>
      <p class="muted">开仓：{{ time(trade.openedAt) }} · 平仓：{{ time(trade.closedAt) }}</p>
      <p class="muted">
        持仓时长：{{ duration(trade.openedAt, trade.closedAt ?? trade.observedAt ?? null)
        }}<span v-if="!trade.closedAt && trade.observedAt"
          >（截至 {{ time(trade.observedAt) }}）</span
        >
      </p>
      <p class="muted">历史杠杆：未知 · 保证金模式：未知 · 原方案：未关联</p>
      <dl class="details details--card">
        <div class="details__row">
          <dt class="details__term">已实现盈亏</dt>
          <dd class="details__value">{{ amount(trade.realizedPnl) }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">手续费（扣除）</dt>
          <dd class="details__value">{{ amount(trade.commission) }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">资金费净收支</dt>
          <dd class="details__value">{{ amount(trade.fundingNet) }}</dd>
        </div>
        <div v-if="!trade.closedAt && trade.groupingVersion === 2" class="details__row">
          <dt class="details__term">查询时点浮动盈亏</dt>
          <dd class="details__value">
            {{ amount(trade.unrealizedPnl ?? null)
            }}<span v-if="trade.unrealizedAt"> · {{ time(trade.unrealizedAt) }}</span>
          </dd>
        </div>
        <div class="details__row details__row--risk">
          <dt class="details__term">复盘净盈亏</dt>
          <dd id="review-net-pnl" class="details__value">{{ amount(trade.netPnl) }}</dd>
        </div>
      </dl>
      <p v-if="trade.missing.length" class="error">待确认：{{ trade.missing.join('；') }}</p>
      <details class="disclosure">
        <summary class="disclosure__summary">
          订单证据 · {{ trade.evidence.orders.length }} 张
        </summary>
        <article v-for="order in trade.evidence.orders" :key="order.id" class="review-order">
          <h3 class="section-title">{{ order.id }}</h3>
          <p>{{ order.symbol }} · {{ order.side === 'BUY' ? '买入' : '卖出' }}</p>
          <p>
            {{ order.type === null ? '订单类型：未知' : (orderTypes[order.type] ?? order.type) }}
          </p>
          <p v-if="order.algoId" class="muted">条件订单：{{ order.algoId }}</p>
          <p>{{ order.quantity }} {{ trade.baseAsset }} · {{ time(order.time) }}</p>
        </article>
      </details>
      <details v-if="trade.evidence.raw?.length" class="disclosure">
        <summary class="disclosure__summary">
          关联原始证据 · {{ trade.evidence.raw.length }} 条
        </summary>
        <article
          v-for="record in trade.evidence.raw"
          :key="`${record.kind}-${record.id}`"
          class="review-fill"
        >
          <h3 class="section-title">{{ record.kind }} · {{ record.id }}</h3>
          <p class="muted">{{ time(new Date(record.time).toISOString()) }}</p>
          <p>{{ JSON.stringify(record.payload) }}</p>
        </article>
      </details>
      <details class="disclosure">
        <summary class="disclosure__summary">
          逐笔成交 · {{ trade.evidence.fills.length }} 条
        </summary>
        <article v-for="fill in trade.evidence.fills" :key="fill.id" class="review-fill">
          <h3 class="section-title">{{ fill.id }}</h3>
          <p>
            原始成交：{{ fill.id
            }}<span v-if="fill.allocation">
              · {{ fill.allocation === 'close' ? '反手平仓分配' : '反手开仓分配' }}</span
            >
          </p>
          <p v-if="fill.event">{{ events[fill.event] }}</p>
          <p>订单：{{ fill.orderId }} · {{ fill.symbol }}</p>
          <p>{{ fill.side === 'BUY' ? '买入' : '卖出' }} · {{ time(fill.time) }}</p>
          <p>{{ fill.quantity }} {{ trade.baseAsset }} × {{ fill.price }} USDT</p>
          <p>已实现盈亏：{{ amount(fill.realizedPnl) }}</p>
          <p>手续费：{{ amount(fill.commission, fill.commissionAsset) }}</p>
        </article>
      </details>
      <details class="disclosure">
        <summary class="disclosure__summary">
          资金费流水 · {{ trade.evidence.funding.length }} 条
        </summary>
        <article v-for="fee in trade.evidence.funding" :key="fee.id" class="review-funding">
          <h3 class="section-title">{{ fee.id }}</h3>
          <p>{{ fee.symbol }} · {{ time(fee.time) }}</p>
          <p>{{ amount(fee.amount, fee.asset) }}</p>
          <p v-if="fee.attribution === 'ambiguous'" class="muted">
            归属待确认 · 不计入已确认净盈亏
          </p>
          <p class="muted">正数为收入，负数为支出</p>
        </article>
      </details>
    </section>
    <p class="footnote">
      一笔交易可包含多张订单和多条成交。归档独立于当前本单；退出登录、清除本单和服务重启保留历史。
    </p>
  </main>
</template>
