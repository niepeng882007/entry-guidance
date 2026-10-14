<script setup lang="ts">
import type { Workbench } from '../useWorkbench';
const { workbench } = defineProps<{ workbench: Workbench }>();
const { text, hidden, ui, cardElement, copyValue } = workbench;
</script>

<template>
  <section
    id="entry-card"
    ref="cardElement"
    :data-current="ui.cardCurrent"
    class="entry-card"
    tabindex="-1"
    aria-labelledby="card-title"
    :hidden="hidden['entry-card']"
  >
    <div class="section-heading">
      <h3 id="card-title" class="section-title">{{ text['card-title'] }}</h3>
      <span class="tag" id="card-symbol">{{ text['card-symbol'] }}</span>
    </div>
    <p id="card-status" role="status" aria-live="polite">{{ text['card-status'] }}</p>
    <p
      id="card-check"
      class="help"
      :data-state="ui.entryCheckState"
      role="status"
      aria-live="polite"
    >
      <strong>原卡最新检查：</strong>{{ text['card-check'] }}
    </p>
    <p id="card-entry-type" class="muted">{{ text['card-entry-type'] }}</p>
    <div class="copy-row">
      <div class="copy-row__content">
        <p class="muted copy-row__text">
          开仓数量 <span id="card-direction">{{ text['card-direction'] }}</span>
        </p>
        <p class="amount amount--card amount--copy" id="card-quantity">
          {{ text['card-quantity'] }}
        </p>
      </div>
      <button
        type="button"
        data-copy="quantity"
        @click="copyValue('quantity')"
        :disabled="!ui.cardCurrent"
        aria-label="复制开仓数量"
        class="button button--copy"
      >
        复制数量
      </button>
    </div>
    <div id="card-limit-row" class="copy-row" :hidden="hidden['card-limit-row']">
      <div class="copy-row__content">
        <p class="muted copy-row__text">限价委托价 · USDT</p>
        <p class="amount amount--card amount--copy" id="card-limitPrice">
          {{ text['card-limitPrice'] }}
        </p>
      </div>
      <button
        type="button"
        data-copy="limitPrice"
        @click="copyValue('limitPrice')"
        :disabled="!ui.cardCurrent"
        aria-label="复制限价委托价"
        class="button button--copy"
      >
        复制委托价
      </button>
    </div>
    <div class="copy-row">
      <div class="copy-row__content">
        <p class="muted copy-row__text">① 最终止损触发价 · USDT</p>
        <p class="amount amount--card amount--copy amount--risk" id="card-stopPrice">
          {{ text['card-stopPrice'] }}
        </p>
        <p id="card-final-allocation" class="help copy-row__text">
          {{ text['card-final-allocation'] }}
        </p>
      </div>
      <button
        type="button"
        data-copy="stopPrice"
        @click="copyValue('stopPrice')"
        :disabled="!ui.cardCurrent"
        aria-label="复制绝对止损触发价"
        class="button button--copy"
      >
        复制止损价
      </button>
    </div>
    <div class="copy-row">
      <p id="card-exitMode" class="copy-row__text">{{ text['card-exitMode'] }}</p>
      <button
        type="button"
        data-copy="exitMode"
        @click="copyValue('exitMode')"
        :disabled="!ui.cardCurrent"
        aria-label="复制整仓退出方式"
        class="button button--copy"
      >
        复制退出方式
      </button>
    </div>
    <div id="card-near" :hidden="hidden['card-near']">
      <div class="copy-row">
        <div class="copy-row__content">
          <p class="muted copy-row__text">② 近端止损触发价 · USDT</p>
          <p class="amount amount--card amount--copy" id="card-nearPrice">
            {{ text['card-nearPrice'] }}
          </p>
          <p id="card-near-distance" class="help copy-row__text">
            {{ text['card-near-distance'] }}
          </p>
        </div>
        <button
          type="button"
          data-copy="nearPrice"
          @click="copyValue('nearPrice')"
          :disabled="!ui.cardCurrent"
          aria-label="复制近端止损触发价"
          class="button button--copy"
        >
          复制近端价
        </button>
      </div>
      <div class="copy-row">
        <div class="copy-row__content">
          <p class="muted copy-row__text">近端退出数量 · 只减仓</p>
          <p class="amount amount--card amount--copy" id="card-nearQuantity">
            {{ text['card-nearQuantity'] }}
          </p>
          <p id="card-near-ratio" class="help copy-row__text">{{ text['card-near-ratio'] }}</p>
        </div>
        <button
          type="button"
          data-copy="nearQuantity"
          @click="copyValue('nearQuantity')"
          :disabled="!ui.cardCurrent"
          aria-label="复制近端退出数量"
          class="button button--copy"
        >
          复制近端量
        </button>
      </div>
    </div>
    <div class="copy-row">
      <p id="card-leverage" class="copy-row__text">{{ text['card-leverage'] }}</p>
      <button
        type="button"
        data-copy="leverage"
        @click="copyValue('leverage')"
        :disabled="!ui.cardCurrent"
        aria-label="复制杠杆倍数"
        class="button button--copy"
      >
        复制杠杆
      </button>
    </div>
    <p id="copy-status" class="help" role="status" aria-live="polite">{{ text['copy-status'] }}</p>
    <dl class="details details--card">
      <div class="details__row details__row--risk">
        <dt class="details__term">固定本单预算</dt>
        <dd id="card-budget" class="details__value">{{ text['card-budget'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">
          名义价值
          <details class="disclosure disclosure--help">
            <summary class="disclosure__summary" aria-label="开仓卡名义价值说明">说明</summary>
            <p class="help">按入场参考价计算的仓位价值，不等于保证金。</p>
          </details>
        </dt>
        <dd id="card-notional" class="details__value">{{ text['card-notional'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">资金需求 / 可用上限</dt>
        <dd id="card-funding" class="details__value">{{ text['card-funding'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">初始保证金</dt>
        <dd id="card-margin" class="details__value">{{ text['card-margin'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">开仓浮亏 / 费用预留</dt>
        <dd id="card-open-costs" class="details__value">{{ text['card-open-costs'] }}</dd>
      </div>
      <div class="details__row details__row--risk">
        <dt class="details__term">计划止损亏损</dt>
        <dd id="card-loss" class="details__value">{{ text['card-loss'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">生成时预估强平价</dt>
        <dd id="card-liquidation" class="details__value">{{ text['card-liquidation'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">有方向缓冲 / 最低要求</dt>
        <dd id="card-buffer" class="details__value">{{ text['card-buffer'] }}</dd>
      </div>
    </dl>
    <details class="disclosure">
      <summary class="disclosure__summary">本单假设与数据时间</summary>
      <dl class="details details--card">
        <div class="details__row">
          <dt class="details__term">下单资金估值价格</dt>
          <dd id="card-assuming" class="details__value">{{ text['card-assuming'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">不利入场 / 退出估值</dt>
          <dd id="card-estimates" class="details__value">{{ text['card-estimates'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">开仓 / 退出计划手续费</dt>
          <dd id="card-fees" class="details__value">{{ text['card-fees'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">每次滑点 / 资金费预留</dt>
          <dd id="card-reserves" class="details__value">{{ text['card-reserves'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">假设逐仓本金（扣费后）</dt>
          <dd id="card-wallet" class="details__value">{{ text['card-wallet'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">强平档位 / 维持率 / 速算额</dt>
          <dd id="card-tier" class="details__value">{{ text['card-tier'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">所选杠杆名义价值上限</dt>
          <dd id="card-limit" class="details__value">{{ text['card-limit'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">账户查询</dt>
          <dd id="card-account-time" class="details__value">{{ text['card-account-time'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">买卖报价</dt>
          <dd id="card-book-time" class="details__value">{{ text['card-book-time'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">标记价 / 最新成交价</dt>
          <dd id="card-price-times" class="details__value">{{ text['card-price-times'] }}</dd>
        </div>
        <div class="details__row">
          <dt class="details__term">本次规则读取完成</dt>
          <dd id="card-time" class="details__value">{{ text['card-time'] }}</dd>
        </div>
      </dl>
      <p id="card-funding-model" class="help">{{ text['card-funding-model'] }}</p>
      <p class="help">
        强平模型：逐仓本金＝不利成交名义价值÷所选杠杆－开仓手续费；不计额外或自动追加保证金及未来资金费变化。这是成交前假设，不是交易所实际逐仓余额，也不保证是其下界。
      </p>
    </details>
    <p id="card-instructions">{{ text['card-instructions'] }}</p>
    <p class="notice">实际亏损可能超过预算，交易所仍可能拒单；成交后须检查真实仓位与止损。</p>
  </section>
</template>
