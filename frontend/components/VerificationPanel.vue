<script setup lang="ts">
import type { Workbench } from '../useWorkbench';
import SelectControl from './SelectControl.vue';
const { workbench } = defineProps<{ workbench: Workbench }>();
const { fields, text, hidden, ui, verifyCurrentPlan, scenarioChanged, restoreInputs } = workbench;
</script>

<template>
  <section
    id="verification"
    :data-current="ui.verificationCurrent"
    :data-state="ui.verificationState"
    class="entry-card entry-card--verification"
    aria-labelledby="verification-title"
    :hidden="hidden['verification']"
  >
    <h3 id="verification-title" class="section-title">{{ text['verification-title'] }}</h3>
    <p class="help" id="verification-start">{{ text['verification-start'] }}</p>
    <div id="demo-verification" :hidden="hidden['demo-verification']">
      <label for="demo-scenario" class="field-label">模拟账户场景 · 不会执行交易</label>
      <SelectControl
        ><select
          id="demo-scenario"
          class="field-control field-control--select"
          v-model="fields['demo-scenario']"
          @change="scenarioChanged"
        >
          <option value="missing-stop">已成交，缺少止损</option>
          <option value="protected">全部成交，已补齐止损</option>
          <option value="final-only" data-two-only :disabled="!ui.cardTwo" :hidden="!ui.cardTwo">
            双层：仅最终整仓保护
          </option>
          <option value="near-filled" data-two-only :disabled="!ui.cardTwo" :hidden="!ui.cardTwo">
            双层：近端已执行，核验剩余仓位
          </option>
          <option
            value="final-canceled"
            data-two-only
            :disabled="!ui.cardTwo"
            :hidden="!ui.cardTwo"
          >
            双层：近端已执行，最终保护被取消
          </option>
          <option
            value="missing-attribution"
            data-two-only
            :disabled="!ui.cardTwo"
            :hidden="!ui.cardTwo"
          >
            双层：近端已执行，损益归属缺失
          </option>
          <option value="waiting">尚未成交 / 限价挂单中</option>
          <option value="partial" data-limit-only :disabled="!ui.cardLimit" :hidden="!ui.cardLimit">
            限价：首次部分成交，余单仍在
          </option>
          <option
            value="partial-more"
            data-limit-only
            :disabled="!ui.cardLimit"
            :hidden="!ui.cardLimit"
          >
            限价：再次部分成交，余单仍在
          </option>
          <option
            value="canceled-remainder"
            data-limit-only
            :disabled="!ui.cardLimit"
            :hidden="!ui.cardLimit"
          >
            限价：已人工撤余单，保留实际仓位
          </option>
          <option
            value="stop-first"
            data-limit-only
            :disabled="!ui.cardLimit"
            :hidden="!ui.cardLimit"
          >
            限价：止损先执行，入场余单仍在
          </option>
          <option value="failure">模拟查询失败</option>
        </select></SelectControl
      >
    </div>
    <button
      id="verify"
      @click="verifyCurrentPlan"
      type="button"
      class="button verification__refresh"
      :disabled="ui.verifyDisabled"
      :aria-busy="ui.verifyBusy || undefined"
    >
      {{ text['verify'] }}
    </button>
    <button id="restore-inputs" @click="restoreInputs" type="button" class="button button--text">
      恢复原方案输入并核验
    </button>
    <p id="verification-status" role="status" aria-live="polite" class="verification__status">
      {{ text['verification-status'] }}
    </p>
    <p id="verification-time" class="help">{{ text['verification-time'] }}</p>
    <ul id="verification-issues" class="verification__issues">
      <li v-for="(issue, index) in ui.issues" :key="index">{{ issue }}</li>
    </ul>
    <dl
      id="verification-details"
      class="details details--card"
      :hidden="hidden['verification-details']"
    >
      <div class="details__row">
        <dt class="details__term">关联开仓订单</dt>
        <dd id="verification-order" class="details__value">{{ text['verification-order'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">入场订单状态 / 累计成交</dt>
        <dd id="verification-entry-state" class="details__value">
          {{ text['verification-entry-state'] }}
        </dd>
      </div>
      <div class="details__row">
        <dt class="details__term">未成交入场委托</dt>
        <dd id="verification-pending" class="details__value">{{ text['verification-pending'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">实际方向 / 数量</dt>
        <dd id="verification-position" class="details__value">
          {{ text['verification-position'] }}
        </dd>
      </div>
      <div class="details__row">
        <dt class="details__term">实际成交均价</dt>
        <dd id="verification-entry" class="details__value">{{ text['verification-entry'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">实际 / 原方案杠杆</dt>
        <dd id="verification-leverage" class="details__value">
          {{ text['verification-leverage'] }}
        </dd>
      </div>
      <div class="details__row details__row--risk">
        <dt class="details__term">按原止损重算亏损 / 原预算</dt>
        <dd id="verification-risk" class="details__value">{{ text['verification-risk'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">预算超额</dt>
        <dd id="verification-excess" class="details__value">{{ text['verification-excess'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">已付手续费 / 资金费</dt>
        <dd id="verification-paid" class="details__value">{{ text['verification-paid'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">剩余资金费预留 / 退出手续费</dt>
        <dd id="verification-reserved" class="details__value">
          {{ text['verification-reserved'] }}
        </dd>
      </div>
      <div class="details__row">
        <dt class="details__term">当前强平价（实际持仓）</dt>
        <dd id="verification-liquidation" class="details__value">
          {{ text['verification-liquidation'] }}
        </dd>
      </div>
      <div class="details__row">
        <dt class="details__term">当前强平缓冲 / 最低要求</dt>
        <dd id="verification-buffer" class="details__value">{{ text['verification-buffer'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">止损覆盖方式</dt>
        <dd id="verification-coverage" class="details__value">
          {{ text['verification-coverage'] }}
        </dd>
      </div>
      <div
        id="verification-near-row"
        class="details__row"
        :hidden="hidden['verification-near-row']"
      >
        <dt class="details__term">近端执行 / 待退出数量</dt>
        <dd id="verification-near" class="details__value">{{ text['verification-near'] }}</dd>
      </div>
      <div class="details__row">
        <dt class="details__term">本单已实现损益</dt>
        <dd id="verification-realized" class="details__value">
          {{ text['verification-realized'] }}
        </dd>
      </div>
    </dl>
    <p class="help">
      始终沿用原预算与原绝对止损。资金费支出消耗原预留，收入不扩大风险预算。修改输入后需恢复原输入才能核验此卡；新方案需重新确认空仓起点。
    </p>
    <p class="notice">
      核验仅对应显示的查询时点，不代表持续监测，也不保证未来成交。修正由你在 Binance
      完成；部分退出需能关联原近端止损、成交及费用，否则无法完整核验。
    </p>
  </section>
</template>
