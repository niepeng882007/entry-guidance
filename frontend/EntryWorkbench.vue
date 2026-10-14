<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useWorkbench } from './useWorkbench';
import PlanForm from './components/PlanForm.vue';
import EntryCard from './components/EntryCard.vue';
import VerificationPanel from './components/VerificationPanel.vue';
const { source } = defineProps<{ source: string }>();
const workbench = useWorkbench(source);
const { text, hidden, ui, accountOnly, refreshAccount, generateCard, clearTrade } = workbench;
let cleanup = () => {};

const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function markModuleLink(links: Element[], currentId: string | null) {
  for (const link of links) {
    if (currentId && link.getAttribute('href') === `#${currentId}`)
      link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

function moduleScrollTop(target: HTMLElement) {
  const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const next = window.scrollY + target.getBoundingClientRect().top - margin;
  const limit = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return Math.min(Math.max(0, next), limit);
}

function scrollKeyReleasesNavigation(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (!scrollKeys.has(event.key)) return false;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  if (event.key === ' ' && target.closest('a, button, summary')) return false;
  return true;
}

function syncModuleCurrent(modules: HTMLElement[], links: Element[]) {
  const navigation = document.querySelector('.module-nav');
  const sticky = navigation && getComputedStyle(navigation).position === 'sticky';
  const offset = (sticky ? navigation.getBoundingClientRect().bottom : 0) + 24;
  const root = document.documentElement;
  const atBottom =
    root.scrollHeight > window.innerHeight + 1 &&
    root.scrollHeight - window.scrollY - window.innerHeight <= 1;
  const positions = modules.map((target) => ({ target, top: target.getBoundingClientRect().top }));
  const passed = positions.filter((item) => item.top <= offset).sort((a, b) => b.top - a.top);
  let current: HTMLElement | null = passed[0]?.target ?? document.getElementById('plan-module');
  if (atBottom) {
    const hashed = positions.find((item) => item.target.id === location.hash.slice(1));
    // A short section at the end of the page cannot reach the activation line.
    if (hashed && hashed.top > offset && hashed.top < window.innerHeight) current = hashed.target;
    else {
      const visible = positions
        .filter(
          (item) => item.top < window.innerHeight && item.target.getBoundingClientRect().bottom > 0,
        )
        .sort((a, b) => b.top - a.top);
      if (visible[0]) current = visible[0].target;
    }
  }
  markModuleLink(links, current?.id ?? null);
}

onMounted(() => {
  const events = new AbortController();
  const links = Array.from(document.querySelectorAll('.module-nav__link'));
  const modules = links
    .map((link) => document.getElementById(link.getAttribute('href')?.slice(1) ?? ''))
    .filter((target): target is HTMLElement => target instanceof HTMLElement);
  let lockedModuleId: string | null = null;
  const sync = () => {
    if (lockedModuleId) {
      markModuleLink(links, lockedModuleId);
      return;
    }
    syncModuleCurrent(modules, links);
  };
  const releaseLock = () => {
    if (!lockedModuleId) return;
    lockedModuleId = null;
    sync();
  };
  const finishLockedScroll = () => {
    releaseLock();
    sync();
  };
  const engageLock = (target: HTMLElement) => {
    const id = target.id;
    lockedModuleId = id;
    markModuleLink(links, id);
    requestAnimationFrame(() => {
      if (lockedModuleId !== id) return;
      if (Math.abs(moduleScrollTop(target) - window.scrollY) <= 1) {
        releaseLock();
        sync();
      }
    });
  };
  for (const link of document.querySelectorAll('a[href^="#"]'))
    link.addEventListener(
      'click',
      (event) => {
        if (
          event instanceof MouseEvent &&
          (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        )
          return;
        const target = document.getElementById(link.getAttribute('href')?.slice(1) ?? '');
        if (target instanceof HTMLDetailsElement) target.open = true;
        if (!(target instanceof HTMLElement) || !link.closest('.module-nav')) return;
        if (!modules.includes(target)) return;
        event.preventDefault();
        if (location.hash !== `#${target.id}`) history.pushState(null, '', `#${target.id}`);
        target.focus({ preventScroll: true });
        if (Math.abs(moduleScrollTop(target) - window.scrollY) <= 1) {
          releaseLock();
          requestAnimationFrame(sync);
          return;
        }
        engageLock(target);
        window.scrollTo({
          top: moduleScrollTop(target),
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        });
      },
      { signal: events.signal },
    );
  const observer = new IntersectionObserver(sync, {
    rootMargin: '-120px 0px -55% 0px',
    threshold: [0, 1],
  });
  for (const target of modules) observer.observe(target);
  window.addEventListener('scroll', sync, { passive: true, signal: events.signal });
  window.addEventListener('scrollend', finishLockedScroll, { signal: events.signal });
  window.addEventListener('wheel', releaseLock, { passive: true, signal: events.signal });
  window.addEventListener('touchmove', releaseLock, { passive: true, signal: events.signal });
  window.addEventListener(
    'keydown',
    (event) => {
      if (scrollKeyReleasesNavigation(event)) releaseLock();
    },
    { signal: events.signal },
  );
  window.addEventListener(
    'popstate',
    () => {
      releaseLock();
      sync();
    },
    { signal: events.signal },
  );
  window.addEventListener('resize', sync, { signal: events.signal });
  sync();
  cleanup = () => {
    events.abort();
    observer.disconnect();
  };
});
onUnmounted(() => cleanup());
</script>

<template>
  <div class="entry-workbench">
    <nav class="module-nav" aria-label="开仓卡章节">
      <div class="module-nav__links">
        <a class="module-nav__link" href="#plan-module">本次计划</a>
        <a class="module-nav__link" href="#execution-module">开仓卡</a>
        <a class="module-nav__link" href="#review-module">成交核验</a>
        <a class="module-nav__link" href="#account-module">账户摘要</a>
        <a class="module-nav__link" href="#templates-module">止损模板</a>
        <a class="module-nav__link" href="#preview-module">试算结果</a>
      </div>
    </nav>
    <div class="entry-workbench__content">
      <div class="heading workspace__heading">
        <div>
          <h1 class="page-title">开仓卡</h1>
          <p class="workspace__intro">明确本单风险，再执行交易。</p>
        </div>
        <span class="tag">只读 · 手动执行</span>
      </div>
      <p id="source" class="source">{{ text['source'] }}</p>
      <section :data-state="ui.status" class="status" aria-live="polite" aria-atomic="true">
        <div class="status__heading">
          <span class="status__indicator" aria-hidden="true"></span>
          <h2 id="status" class="section-title">{{ text['status'] }}</h2>
        </div>
        <p id="message" class="status__message">{{ text['message'] }}</p>
        <p id="relogin" class="status__message" :hidden="hidden['relogin']">
          <a href="/login">重新登录并继续本单</a>；原输入与止损参数保留。
        </p>
        <button
          id="account-only"
          @click="accountOnly"
          type="button"
          class="button button--secondary"
          :hidden="hidden['account-only']"
        >
          清空币种，仅查看账户
        </button>
      </section>
      <section
        id="plan-module"
        class="plan-module module"
        tabindex="-1"
        aria-labelledby="plan-title"
      >
        <div class="section-heading">
          <h2 id="plan-title" class="module-title">本次计划</h2>
          <span class="muted section-heading__note">输入参数 → 试算 → 生成开仓卡</span>
        </div>
        <div class="plan-workspace">
          <PlanForm :workbench="workbench" />
          <aside
            id="preview-module"
            class="preview-panel module"
            tabindex="-1"
            aria-labelledby="preview-title"
          >
            <div class="section-heading">
              <h3 id="preview-title" class="section-title">试算结果</h3>
              <span class="tag">草稿</span>
            </div>
            <p
              id="draft-error"
              :data-state="ui.draftState"
              class="error preview-panel__message"
              role="status"
              aria-live="polite"
            >
              {{ text['draft-error'] }}
            </p>
            <section
              class="draft-result"
              id="draft-result"
              aria-live="polite"
              :hidden="hidden['draft-result']"
            >
              <p class="muted">开仓数量</p>
              <p class="amount amount--draft" id="draft-quantity">{{ text['draft-quantity'] }}</p>
              <dl class="details details--draft">
                <div class="details__row details__row--risk">
                  <dt class="details__term">本单亏损预算</dt>
                  <dd id="draft-budget" class="details__value">{{ text['draft-budget'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">仓位名义价值</dt>
                  <dd id="draft-notional" class="details__value">{{ text['draft-notional'] }}</dd>
                </div>
                <div class="details__row details__row--risk">
                  <dt class="details__term">最终触发价 / 实际距离</dt>
                  <dd id="draft-stop" class="details__value">{{ text['draft-stop'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">分层退出数量 / 实际比例</dt>
                  <dd id="draft-distance" class="details__value">{{ text['draft-distance'] }}</dd>
                </div>
                <div id="draft-near-row" class="details__row" :hidden="hidden['draft-near-row']">
                  <dt class="details__term">近端触发价 / 实际距离</dt>
                  <dd id="draft-near" class="details__value">{{ text['draft-near'] }}</dd>
                </div>
                <div class="details__row details__row--risk">
                  <dt class="details__term">计划止损亏损</dt>
                  <dd id="draft-loss" class="details__value">{{ text['draft-loss'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">入场参考价</dt>
                  <dd id="draft-reference" class="details__value">{{ text['draft-reference'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">不利入场估值</dt>
                  <dd id="draft-entry" class="details__value">{{ text['draft-entry'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">不利退出估值</dt>
                  <dd id="draft-exit" class="details__value">{{ text['draft-exit'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">开仓 / 退出手续费</dt>
                  <dd id="draft-fees" class="details__value">{{ text['draft-fees'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">每次滑点假设</dt>
                  <dd id="draft-slippage" class="details__value">{{ text['draft-slippage'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">资金费预留</dt>
                  <dd id="draft-funding" class="details__value">{{ text['draft-funding'] }}</dd>
                </div>
              </dl>
              <p id="draft-condition">{{ text['draft-condition'] }}</p>
              <p id="draft-time" class="help">{{ text['draft-time'] }}</p>
            </section>
            <section
              id="entry-checks"
              aria-live="polite"
              class="entry-checks"
              :hidden="hidden['entry-checks']"
            >
              <h3 class="section-title">资金与强平预检查</h3>
              <dl class="details details--checks">
                <div class="details__row">
                  <dt class="details__term">资金需求 / 可用上限</dt>
                  <dd id="preview-funding" class="details__value">{{ text['preview-funding'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">保证金 / 开仓浮亏 / 费用</dt>
                  <dd id="preview-costs" class="details__value">{{ text['preview-costs'] }}</dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">预估强平价</dt>
                  <dd id="preview-liquidation" class="details__value">
                    {{ text['preview-liquidation'] }}
                  </dd>
                </div>
                <div class="details__row">
                  <dt class="details__term">有方向缓冲 / 最低要求</dt>
                  <dd id="preview-buffer" class="details__value">{{ text['preview-buffer'] }}</dd>
                </div>
              </dl>
            </section>
            <p id="entry-error" class="error" role="status" aria-live="polite">
              {{ text['entry-error'] }}
            </p>
            <button
              id="generate"
              @click="generateCard"
              type="button"
              class="button button--block"
              :disabled="ui.generateDisabled"
              :aria-busy="ui.generateBusy || undefined"
            >
              {{ text['generate'] }}
            </button>
            <p class="help">
              生成时刷新账户、行情及规则，固定本单 USDT 预算与绝对止损；普通刷新不改写已生成的卡片。
            </p>
          </aside>
        </div>
      </section>
      <section
        id="account-module"
        class="account-module module"
        tabindex="-1"
        aria-labelledby="account-title"
      >
        <div class="section-heading">
          <h2 id="account-title" class="section-title">账户快照</h2>
          <a class="button button--text button--link" href="/account">查看账户详情</a>
        </div>
        <p class="muted section-heading__note">前台每 3 秒刷新</p>
        <p id="account-error" class="error" role="status" :hidden="!text['account-error']">
          {{ text['account-error'] }}
        </p>
        <div class="balances balances--compact">
          <section class="balance">
            <h3 class="section-title">账户权益 <span class="balance__unit">USDT</span></h3>
            <p class="amount" id="equity">{{ text['equity'] }}</p>
            <p class="muted balance__caption">钱包余额 + 未实现盈亏</p>
          </section>
          <section class="balance">
            <h3 class="section-title">可用余额 <span class="balance__unit">USDT</span></h3>
            <p class="amount" id="available">{{ text['available'] }}</p>
            <p class="muted balance__caption">采用交易所返回值，不重复扣除占款</p>
          </section>
        </div>
        <div class="account-module__actions">
          <details class="disclosure account-details">
            <summary class="disclosure__summary">账户快照详情</summary>
            <dl class="details details--account">
              <div class="details__row">
                <dt class="details__term">钱包余额</dt>
                <dd id="wallet" class="details__value">{{ text['wallet'] }}</dd>
              </div>
              <div class="details__row">
                <dt class="details__term">未实现盈亏</dt>
                <dd id="pnl" class="details__value">{{ text['pnl'] }}</dd>
              </div>
              <div class="details__row">
                <dt class="details__term">账户查询时间</dt>
                <dd id="queried" class="details__value">{{ text['queried'] }}</dd>
              </div>
              <div class="details__row">
                <dt class="details__term">最近尝试时间</dt>
                <dd id="attempted" class="details__value">{{ text['attempted'] }}</dd>
              </div>
            </dl>
          </details>
          <button
            id="refresh"
            @click="refreshAccount"
            type="button"
            class="button button--secondary button--mobile-full"
            :disabled="ui.refreshDisabled"
          >
            {{ text['refresh'] }}
          </button>
        </div>
      </section>
      <section
        id="execution-module"
        class="module result-module"
        tabindex="-1"
        aria-labelledby="execution-title"
      >
        <div class="section-heading">
          <h2 id="execution-title" class="module-title">开仓卡</h2>
          <span class="muted section-heading__note">固定参数 · 手动执行</span>
        </div>
        <div class="empty-state">
          <p class="empty-state__title">尚未生成开仓卡</p>
          <p class="muted">填写本次计划并刷新生成后，在这里复制数量与止损价格。</p>
          <a class="inline-link" href="#draft-form">填写本次计划 →</a>
        </div>
        <EntryCard :workbench="workbench" />
      </section>
      <section
        id="review-module"
        class="module result-module"
        tabindex="-1"
        aria-labelledby="review-title"
      >
        <div class="section-heading">
          <h2 id="review-title" class="module-title">成交核验</h2>
          <span class="muted section-heading__note">执行后返回 · 只读核对</span>
        </div>
        <div class="empty-state">
          <p class="empty-state__title">尚无可核验的方案</p>
          <p class="muted">生成开仓卡后，在 Binance 手动执行，再返回刷新成交与止损状态。</p>
          <a class="inline-link" href="#plan-module">查看本次计划 →</a>
        </div>
        <VerificationPanel :workbench="workbench" />
      </section>
      <footer class="workspace__footer">
        <p id="recovery-status" class="help" role="status">{{ text['recovery-status'] }}</p>
        <button id="clear-trade" @click="clearTrade" type="button" class="button button--secondary">
          清除本单记录
        </button>
        <p class="notice">
          草稿按最近成功快照估算。正式开仓卡须另行刷新生成；工具不会下单或调整账户设置。
        </p>
        <details id="market-details" class="disclosure" :hidden="hidden['market-details']">
          <summary class="disclosure__summary">本次行情与交易规则</summary>
          <dl class="details">
            <div class="details__row">
              <dt class="details__term">买一 / 卖一</dt>
              <dd id="market-book" class="details__value">{{ text['market-book'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">标记价</dt>
              <dd id="market-mark" class="details__value">{{ text['market-mark'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">价格 / 数量步长</dt>
              <dd id="market-steps" class="details__value">{{ text['market-steps'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">市价数量范围</dt>
              <dd id="market-quantity" class="details__value">{{ text['market-quantity'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">普通限价数量范围 / 步长</dt>
              <dd id="market-limit-quantity" class="details__value">
                {{ text['market-limit-quantity'] }}
              </dd>
            </div>
            <div class="details__row">
              <dt class="details__term">最小开仓名义价值</dt>
              <dd id="market-minimum" class="details__value">{{ text['market-minimum'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">报价数据时间</dt>
              <dd id="market-book-time" class="details__value">{{ text['market-book-time'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">标记价数据时间</dt>
              <dd id="market-mark-time" class="details__value">{{ text['market-mark-time'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">本次读取完成</dt>
              <dd id="market-time" class="details__value">{{ text['market-time'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">最新成交价 / 数据时间</dt>
              <dd id="market-last" class="details__value">{{ text['market-last'] }}</dd>
            </div>
            <div class="details__row">
              <dt class="details__term">账户杠杆档位</dt>
              <dd id="market-brackets" class="details__value">{{ text['market-brackets'] }}</dd>
            </div>
          </dl>
        </details>
        <p class="footnote">
          名义价值按入场参考价计算，不等于保证金。止损均为标记价触发的止损市价、关闭价格保护；最终止损整仓退出，双层近端按固定数量只减仓。工具不会下单或修改账户。
        </p>
      </footer>
      <noscript>请启用 JavaScript 以读取账户状态。</noscript>
    </div>
  </div>
</template>
