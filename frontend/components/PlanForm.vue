<script setup lang="ts">
import type { Workbench } from '../useWorkbench';
import SelectControl from './SelectControl.vue';
const { workbench } = defineProps<{ workbench: Workbench }>();
const {
  fields,
  text,
  hidden,
  ui,
  inputChanged,
  symbolChanged,
  saveTemplate,
  selectTemplate,
  applyTemplate,
  deleteTemplate,
  renderDraft,
} = workbench;
</script>

<template>
  <form
    id="draft-form"
    @submit.prevent="renderDraft"
    novalidate
    class="draft-form"
    tabindex="-1"
    aria-label="本次计划参数"
  >
    <fieldset class="field-group">
      <legend class="field-group__title">交易方向</legend>
      <div class="field-grid">
        <div class="field">
          <label for="symbol" class="field-label">USDT 永续币种</label
          ><SelectControl
            ><select
              id="symbol"
              name="symbol"
              aria-describedby="symbol-help"
              class="field-control field-control--select"
              v-model="fields['symbol']"
              @change="
                inputChanged('输入已修改');
                symbolChanged();
              "
            >
              <option value="">仅查看账户</option>
              <option v-for="value in ui.symbols" :key="value" :value="value">{{ value }}</option>
            </select></SelectControl
          >
          <p id="symbol-help" class="help">
            选币后还会检查该合约是否空仓、逐仓、单向且无挂单；不符合时暂停开仓方案。
          </p>
        </div>
        <div class="field">
          <label for="side" class="field-label">方向</label
          ><SelectControl
            ><select
              id="side"
              name="side"
              class="field-control field-control--select"
              v-model="fields['side']"
              @change="inputChanged('输入已修改')"
            >
              <option value="">选择方向</option>
              <option value="long">做多</option>
              <option value="short">做空</option>
            </select></SelectControl
          >
        </div>
        <div class="field">
          <label for="entry-type" class="field-label">入场方式</label
          ><SelectControl
            ><select
              id="entry-type"
              name="entryType"
              class="field-control field-control--select"
              v-model="fields['entry-type']"
              @change="inputChanged('输入已修改')"
            >
              <option value="MARKET">市价</option>
              <option value="LIMIT">普通限价 · GTC</option>
            </select></SelectControl
          >
        </div>
        <div id="limit-field" class="field" :hidden="hidden['limit-field']">
          <label for="limit-price" class="field-label">限价委托价 · USDT</label
          ><input
            id="limit-price"
            :disabled="!ui.limit"
            :required="ui.limit"
            name="limitPrice"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="limit-help draft-error"
            maxlength="34"
            class="field-control"
            v-model="fields['limit-price']"
            @input="inputChanged('输入已修改')"
          />
          <p id="limit-help" class="help">
            仅用于本单；须符合价格步长，不自动改价。GTC 保持挂单直至成交、撤销或交易所失效。
          </p>
        </div>
      </div>
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-group__title">亏损预算</legend>
      <div class="field-grid">
        <div class="field">
          <label for="budget-mode" class="field-label">亏损预算方式</label
          ><SelectControl
            ><select
              id="budget-mode"
              name="budgetMode"
              class="field-control field-control--select"
              v-model="fields['budget-mode']"
              @change="inputChanged('输入已修改')"
            >
              <option value="amount">固定 USDT 金额</option>
              <option value="percent">账户权益百分比</option>
            </select></SelectControl
          >
        </div>
        <div class="field">
          <label for="budget" class="field-label"
            >亏损预算
            <span id="budget-unit" class="field-label__unit">{{ text['budget-unit'] }}</span></label
          ><input
            id="budget"
            name="budget"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="draft-error"
            maxlength="34"
            class="field-control"
            v-model="fields['budget']"
            @input="inputChanged('输入已修改')"
          />
        </div>
      </div>
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-group__title">止损设置</legend>
      <div class="field-grid">
        <div class="field">
          <label for="stop-levels" class="field-label">止损结构</label
          ><SelectControl
            ><select
              id="stop-levels"
              name="stopLevels"
              class="field-control field-control--select"
              v-model="fields['stop-levels']"
              @change="inputChanged('输入已修改')"
            >
              <option value="single">单层止损</option>
              <option value="two">双层止损</option>
            </select></SelectControl
          >
        </div>
        <div class="field">
          <label for="stop-mode" class="field-label">最终止损输入方式</label
          ><SelectControl
            ><select
              id="stop-mode"
              name="stopMode"
              class="field-control field-control--select"
              v-model="fields['stop-mode']"
              @change="inputChanged('输入已修改')"
            >
              <option value="percent">相对入场参考价的距离</option>
              <option value="price">绝对止损触发价</option>
            </select></SelectControl
          >
        </div>
        <div class="field">
          <label for="stop" class="field-label"
            >最终止损
            <span id="stop-unit" class="field-label__unit">{{ text['stop-unit'] }}</span></label
          ><input
            id="stop"
            name="stop"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="draft-error"
            maxlength="34"
            class="field-control"
            v-model="fields['stop']"
            @input="inputChanged('输入已修改')"
          />
        </div>
        <div data-two-input :hidden="!ui.two" class="field">
          <label for="near-stop-mode" class="field-label">近端止损输入方式</label
          ><SelectControl
            ><select
              id="near-stop-mode"
              :disabled="!ui.two"
              name="nearStopMode"
              class="field-control field-control--select"
              v-model="fields['near-stop-mode']"
              @change="inputChanged('输入已修改')"
            >
              <option value="percent">相对入场参考价的距离</option>
              <option value="price">绝对止损触发价</option>
            </select></SelectControl
          >
        </div>
        <div data-two-input :hidden="!ui.two" class="field">
          <label for="near-stop" class="field-label"
            >近端止损
            <span id="near-stop-unit" class="field-label__unit">{{
              text['near-stop-unit']
            }}</span></label
          ><input
            id="near-stop"
            :disabled="!ui.two"
            name="nearStop"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="draft-error"
            maxlength="34"
            class="field-control"
            v-model="fields['near-stop']"
            @input="inputChanged('输入已修改')"
          />
        </div>
        <div data-two-input :hidden="!ui.two" class="field">
          <label for="near-percent" class="field-label">近端退出比例 %</label
          ><input
            id="near-percent"
            :disabled="!ui.two"
            name="nearPercent"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="ratio-help draft-error"
            maxlength="34"
            class="field-control"
            v-model="fields['near-percent']"
            @input="inputChanged('输入已修改')"
          />
          <p id="ratio-help" class="help">
            最终剩余比例 <output id="final-percent">{{ text['final-percent'] }}</output
            >。两层均须大于零；数量取整后以卡片显示的实际比例为准。
          </p>
        </div>
      </div>
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-group__title">资金与杠杆</legend>
      <div class="field-grid">
        <div class="field">
          <label for="leverage" class="field-label">所选杠杆 · 倍</label
          ><input
            id="leverage"
            name="leverage"
            inputmode="numeric"
            autocomplete="off"
            aria-describedby="leverage-help entry-error"
            maxlength="3"
            class="field-control"
            v-model="fields['leverage']"
            @input="inputChanged('输入已修改')"
          />
          <p class="help" id="leverage-help">{{ text['leverage-help'] }}</p>
        </div>
        <div class="field">
          <label for="funding-cap" class="field-label">本单资金上限 USDT（可选）</label
          ><input
            id="funding-cap"
            name="fundingCap"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="cap-help entry-error"
            maxlength="34"
            class="field-control"
            v-model="fields['funding-cap']"
            @input="inputChanged('输入已修改')"
          />
          <p class="help" id="cap-help">包含保证金、开仓浮亏和手续费；留空使用可用余额。</p>
        </div>
      </div>
    </fieldset>
    <details id="templates-module" class="disclosure settings module" tabindex="-1">
      <summary class="disclosure__summary">我的止损模板</summary>
      <p class="help">
        仅保存在当前浏览器；复用个人参数不表示适合当前行情。应用只修改止损，正式建议仍需刷新生成。
      </p>
      <p id="template-preview" class="help" aria-live="polite">{{ text['template-preview'] }}</p>
      <button
        id="template-save"
        @click="saveTemplate"
        type="button"
        class="button button--secondary button--block template-save"
        :disabled="ui.templateSaveDisabled"
      >
        保存当前止损为模板
      </button>
      <label for="stop-template" class="field-label">选择已保存的模板</label>
      <SelectControl
        ><select
          id="stop-template"
          aria-describedby="template-list-error"
          class="field-control field-control--select"
          v-model="fields['stop-template']"
          @change="selectTemplate"
        >
          <option value="">选择模板</option>
          <option v-for="option in ui.templateOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select></SelectControl
      >
      <div class="field-grid template-actions">
        <button
          id="template-apply"
          @click="applyTemplate"
          type="button"
          class="button button--secondary"
          :disabled="ui.templateApplyDisabled"
        >
          应用模板
        </button>
        <button
          id="template-delete"
          @click="deleteTemplate"
          type="button"
          class="button button--text"
          :disabled="ui.templateDeleteDisabled"
        >
          {{ text['template-delete'] }}
        </button>
      </div>
      <p id="template-list-error" class="error" role="status">{{ text['template-list-error'] }}</p>
      <p id="template-status" class="help" role="status">{{ text['template-status'] }}</p>
    </details>
    <details id="cost-settings" :open="ui.costsOpen" class="disclosure settings">
      <summary class="disclosure__summary">成本与强平偏好</summary>
      <p class="muted settings__note">开仓与止损退出均按账户 taker 费率预留；不假定额外折扣。</p>
      <p class="fee-line">
        每次手续费率：<output id="fee">{{ text['fee'] }}</output>
      </p>
      <div class="field-grid">
        <div class="field">
          <label for="slippage" class="field-label">每次市价滑点预留 %</label
          ><input
            id="slippage"
            name="slippage"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="slippage-help draft-error"
            maxlength="34"
            class="field-control"
            v-model="fields['slippage']"
            @input="inputChanged('输入已修改')"
          />
          <p id="slippage-help" class="help">
            用于市价入场和止损退出；限价入场不额外加滑点。首次必填，可明确填写 0。
          </p>
        </div>
        <div class="field">
          <label for="funding" class="field-label">资金费预留 USDT（可选）</label
          ><input
            id="funding"
            name="funding"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="funding-help draft-error"
            maxlength="34"
            class="field-control"
            v-model="fields['funding']"
            @input="inputChanged('输入已修改')"
          />
          <p id="funding-help" class="help">整笔交易的固定预留；留空表示未预留。</p>
        </div>
        <div class="field">
          <label for="minimum-buffer" class="field-label">最低强平缓冲 · 入场价 %</label
          ><input
            id="minimum-buffer"
            name="minimumBuffer"
            inputmode="decimal"
            autocomplete="off"
            aria-describedby="buffer-help entry-error"
            maxlength="34"
            class="field-control"
            v-model="fields['minimum-buffer']"
            @input="inputChanged('输入已修改')"
          />
          <p id="buffer-help" class="help">
            最终止损到预估强平价的有方向间距；首次必填正数，不预设通用阈值。
          </p>
        </div>
      </div>
      <p class="help" id="save-status">{{ text['save-status'] }}</p>
    </details>
  </form>
</template>
