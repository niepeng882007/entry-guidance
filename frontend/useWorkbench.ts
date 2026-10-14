import { nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  generateDraft,
  generateEntryPreview,
  formatDecimal,
  parseDecimal,
  createStopTemplate,
  applyStopTemplate,
  type Snapshot,
  type EntryInput,
} from '../public/draft.js';
import type { SavedPlan } from '../src/server.ts';
import type { Plan, Verification } from '../src/verification.ts';
import type { readAccount } from '../src/account.ts';

class QueryFailure extends Error {
  attemptedAt?: string;
}

type Account = Omit<Awaited<ReturnType<typeof readAccount>>, 'source'> & {
  source: 'binance' | 'demo';
};
const fieldOptions: Partial<Record<FieldId, string[]>> = {
  symbol: [''],
  side: ['', 'long', 'short'],
  'entry-type': ['MARKET', 'LIMIT'],
  'budget-mode': ['amount', 'percent'],
  'stop-levels': ['single', 'two'],
  'stop-mode': ['percent', 'price'],
  'near-stop-mode': ['percent', 'price'],
  'stop-template': [''],
  'demo-scenario': [
    'missing-stop',
    'protected',
    'final-only',
    'near-filled',
    'final-canceled',
    'missing-attribution',
    'waiting',
    'partial',
    'partial-more',
    'canceled-remainder',
    'stop-first',
    'failure',
  ],
};
const defaults = {
  symbol: '',
  side: '',
  'entry-type': 'MARKET',
  'limit-price': '',
  'budget-mode': 'amount',
  budget: '',
  'stop-levels': 'single',
  'stop-mode': 'percent',
  stop: '',
  'near-stop-mode': 'percent',
  'near-stop': '',
  'near-percent': '70',
  leverage: '',
  'funding-cap': '',
  'stop-template': '',
  slippage: '',
  funding: '',
  'minimum-buffer': '',
  'demo-scenario': 'missing-stop',
};
type FieldId = keyof typeof defaults;

export function useWorkbench(source: string) {
  const fields = reactive({ ...defaults });
  const text = reactive<Record<string, string>>({
    source: '',
    status: '等待查询',
    message: '查询结果仅代表查询时点的账户状态。',
    'budget-unit': 'USDT',
    'stop-unit': '%',
    'near-stop-unit': '%',
    'final-percent': '30%',
    'template-preview': '',
    'template-delete': '删除所选模板',
    'template-list-error': '',
    'template-status': '',
    fee: '等待账户查询',
    'save-status': '预算、成本、常用杠杆与最低缓冲仅记在当前浏览器。',
    'draft-error': '选择币种并填写本次计划。',
    'draft-quantity': '—',
    'draft-budget': '—',
    'draft-notional': '—',
    'draft-stop': '—',
    'draft-distance': '—',
    'draft-near': '—',
    'draft-loss': '—',
    'draft-reference': '—',
    'draft-entry': '—',
    'draft-exit': '—',
    'draft-fees': '—',
    'draft-slippage': '—',
    'draft-funding': '—',
    'draft-condition': '',
    'draft-time': '',
    'preview-funding': '—',
    'preview-costs': '—',
    'preview-liquidation': '—',
    'leverage-liquidation': '—',
    'leverage-liquidation-note': '请先选择币种并刷新账户与行情。',
    'preview-buffer': '—',
    'entry-error': '',
    generate: '刷新并生成开仓卡',
    equity: '—',
    available: '—',
    wallet: '—',
    pnl: '—',
    queried: '尚无成功查询',
    attempted: '—',
    'account-error': '',
    refresh: '刷新账户与行情',
    'card-title': '本次开仓卡',
    'card-symbol': '—',
    'card-status': '',
    'card-check': '尚未检查。',
    'card-entry-type': '',
    'card-direction': '',
    'card-quantity': '—',
    'card-limitPrice': '—',
    'card-stopPrice': '—',
    'card-final-allocation': '',
    'card-exitMode': '整仓退出',
    'card-nearPrice': '—',
    'card-near-distance': '',
    'card-nearQuantity': '—',
    'card-near-ratio': '',
    'card-leverage': '—',
    'copy-status': '数量和价格仅复制数值，请核对上方单位。',
    'card-budget': '—',
    'card-notional': '—',
    'card-funding': '—',
    'card-margin': '—',
    'card-open-costs': '—',
    'card-loss': '—',
    'card-liquidation': '—',
    'card-buffer': '—',
    'card-assuming': '—',
    'card-estimates': '—',
    'card-fees': '—',
    'card-reserves': '—',
    'card-wallet': '—',
    'card-tier': '—',
    'card-limit': '—',
    'card-account-time': '—',
    'card-book-time': '—',
    'card-price-times': '—',
    'card-time': '—',
    'card-funding-model': '',
    'card-instructions': '',
    'verification-title': '成交后止损核验',
    'verification-start': '',
    verify: '返回后刷新核验',
    'verification-status': '待核验',
    'verification-time': '尚无完整查询',
    'verification-order': '—',
    'verification-entry-state': '—',
    'verification-pending': '—',
    'verification-position': '—',
    'verification-entry': '—',
    'verification-leverage': '—',
    'verification-risk': '—',
    'verification-excess': '—',
    'verification-paid': '—',
    'verification-reserved': '—',
    'verification-liquidation': '—',
    'verification-buffer': '—',
    'verification-coverage': '—',
    'verification-near': '—',
    'verification-realized': '—',
    'recovery-status': '本单仅保存在当前浏览器；页面关闭期间不持续监控。',
    'market-book': '—',
    'market-mark': '—',
    'market-steps': '—',
    'market-quantity': '—',
    'market-limit-quantity': '—',
    'market-minimum': '—',
    'market-book-time': '—',
    'market-mark-time': '—',
    'market-time': '—',
    'market-last': '—',
    'market-brackets': '—',
  });
  text.source = source;
  const hidden = reactive({
    relogin: true,
    'account-only': true,
    'limit-field': true,
    'draft-result': true,
    'draft-near-row': true,
    'entry-checks': true,
    'entry-card': true,
    'card-limit-row': true,
    'card-near': true,
    verification: true,
    'demo-verification': true,
    'verification-details': true,
    'verification-near-row': true,
    'market-details': true,
  });
  const ui = reactive({
    status: 'pending',
    draftState: 'pending',
    verificationState: 'pending',
    verificationCurrent: false,
    cardCurrent: false,
    entryCheckState: 'pending',
    refreshDisabled: false,
    generateDisabled: false,
    verifyDisabled: false,
    generateBusy: false,
    verifyBusy: false,
    templateSaveDisabled: true,
    templateApplyDisabled: true,
    templateDeleteDisabled: true,
    templateOptions: [] as { label: string; value: string }[],
    symbols: [] as string[],
    issues: [] as string[],
    limit: false,
    two: false,
    cardLimit: false,
    cardTwo: false,
    costsOpen: true,
  });
  const cardElement = ref<HTMLElement>();
  const settingIds: FieldId[] = [
    'symbol',
    'side',
    'entry-type',
    'budget-mode',
    'budget',
    'stop-mode',
    'stop-levels',
    'near-stop-mode',
    'near-percent',
    'slippage',
    'funding',
    'leverage',
    'minimum-buffer',
  ];
  const storageKey = 'entry-guidance.preferences.v1';
  const templateKey = 'entry-guidance.stop-templates.v1';
  const tradeKey = 'entry-guidance.current-trade.v1';
  const inputIds: FieldId[] = [...settingIds, 'stop', 'near-stop', 'limit-price', 'funding-cap'];
  let tradeReadError = '';
  let lastQueryAt = '';
  let symbolsLoaded = false;
  let templates: unknown[] = [];
  let templateReadError = '';
  let hasAccount = false;
  let requestId = 0;
  let pending: AbortController | undefined;
  let accountPending: AbortController | undefined;
  let snapshot: Snapshot | null = null;
  let entryPlan: SavedPlan | null = null;
  let planInputs = '';

  let inputVersion = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;

  function liquidationPrice(value: string) {
    const scaled = parseDecimal(value, '强平价');
    const cents = (scaled + 500_000n) / 1_000_000n;
    if (scaled > 0n && cents === 0n) return '<0.01';
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  }

  function scheduleRefresh(delay = 10_000) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (suspended || document.hidden || !navigator.onLine || !hidden.relogin || !fields.symbol)
      return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      resume();
    }, delay);
  }

  const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
  const show = (id: string, value: string) => {
    text[id] = value;
  };

  const message = (error: unknown) =>
    error instanceof Error && !['TimeoutError', 'TypeError', 'AbortError'].includes(error.name)
      ? error.message
      : '网络中断或查询超时，请稍后重试。';

  class LoginRequired extends Error {}

  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('记录格式无效');
    return value as Record<string, unknown>;
  }

  function showLogin(error: unknown) {
    if (error instanceof LoginRequired) hidden['relogin'] = false;
  }

  function saveTrade() {
    if (tradeReadError) return;
    try {
      localStorage.setItem(
        tradeKey,
        JSON.stringify({
          version: 1,
          fields: Object.fromEntries(inputIds.map((id) => [id, fields[id]])),
          recovery: entryPlan?.recovery ?? '',
          lastQueryAt,
          scenario: fields['demo-scenario'],
        }),
      );
      show(
        'recovery-status',
        '本次输入与原方案已保存在当前浏览器；返回后重新查询，页面关闭期间不监控。',
      );
    } catch {
      show('recovery-status', '无法保存本单；当前页面仍可继续，关闭或重新登录可能丢失本次计划。');
    }
  }

  function restoreFields(values: Record<string, unknown>) {
    for (const id of inputIds) {
      const value = values[id];
      if (typeof value !== 'string' || value.length > 34) throw new Error('本单输入记录损坏');
      if (id === 'symbol') {
        if (value && !/^[A-Z0-9]{1,30}USDT$/.test(value)) throw new Error('本单币种记录损坏');
      } else if (fieldOptions[id] && !fieldOptions[id].includes(value))
        throw new Error('本单选项记录损坏');
    }
    for (const id of inputIds) fields[id] = values[id] as string;
    if (fields.symbol && !ui.symbols.includes(fields.symbol)) ui.symbols.push(fields.symbol);
  }

  function restoreTrade() {
    try {
      const settings = record(JSON.parse(localStorage.getItem(storageKey) ?? '{}'));
      const preferences: Record<string, string> = Object.fromEntries(
        inputIds.map((id) => [id, fields[id]]),
      );
      for (const id of settingIds)
        if (typeof settings?.[id] === 'string') preferences[id] = settings[id];
      restoreFields(preferences);
    } catch {
      show('save-status', '无法读取保存的设置，请填写本次参数。');
    }
    try {
      const raw = localStorage.getItem(tradeKey);
      if (!raw) return;
      if (raw.length > 24_000) throw new Error('本单记录过大');
      const saved = record(JSON.parse(raw));
      if (
        !saved ||
        saved.version !== 1 ||
        !saved.fields ||
        typeof saved.recovery !== 'string' ||
        typeof saved.lastQueryAt !== 'string' ||
        (saved.lastQueryAt && !Number.isFinite(Date.parse(saved.lastQueryAt)))
      )
        throw new Error('本单记录格式损坏');
      if (saved.recovery) {
        // This local copy is display-only until the server authenticates the recovery envelope.
        const payload = (saved.recovery.split('.')[0] ?? '').replace(/-/g, '+').replace(/_/g, '/');
        const envelope = record(
          JSON.parse(
            new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))),
          ),
        );
        const plan = record(envelope.plan);
        if (
          envelope.version !== 1 ||
          !plan ||
          !['demo', 'binance'].includes(String(plan.source)) ||
          !plan.execution ||
          !plan.account ||
          !envelope.input ||
          !['id', 'symbol', 'budget', 'quantity', 'stopPrice', 'queriedAt', 'startedAt'].every(
            (key) => typeof plan[key] === 'string',
          ) ||
          (plan.nearStop && typeof plan.nearStop !== 'object')
        )
          throw new Error('原方案记录损坏');
        entryPlan = { ...plan, input: envelope.input, recovery: saved.recovery } as SavedPlan;
        planInputs = JSON.stringify(envelope.input);
      }
      restoreFields(record(saved.fields));
      lastQueryAt = saved.lastQueryAt;
      if (entryPlan) {
        renderCard();
        renderAccount(entryPlan.account);
        invalidateCard('已恢复本地副本，须确认原方案并重新查询');
      }
      if (typeof saved.scenario === 'string' && scenarioAllowed(saved.scenario))
        fields['demo-scenario'] = saved.scenario;
      show('recovery-status', '已恢复本次输入与旧参数；旧结果不证明当前状态，正在重新查询。');
    } catch (error) {
      entryPlan = null;
      planInputs = '';
      hidden['entry-card'] = hidden['verification'] = true;
      tradeReadError = `无法恢复本单：${error instanceof SyntaxError ? '本单记录格式损坏' : message(error)}。未覆盖原记录，可清除本单记录后重新开始。`;
      show('recovery-status', tradeReadError);
    }
  }

  function cancelQuery(reason: string) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    requestId++;
    pending?.abort();
    accountPending?.abort();
    pending = undefined;
    ui.generateBusy = false;
    ui.verifyBusy = false;
    show('generate', '刷新并生成开仓卡');
    show('verify', '返回后刷新核验');
    ui.refreshDisabled = false;
    ui.generateDisabled = !navigator.onLine;
    invalidateCard(reason);
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(Object.fromEntries(settingIds.map((id) => [id, fields[id]]))),
      );
    } catch {
      show('save-status', '浏览器无法保存设置，本次输入仍可使用。');
    }
  }

  function readInput() {
    const two = fields['stop-levels'] === 'two';
    return {
      symbol: fields.symbol,
      side: fields['side'],
      entryType: fields['entry-type'],
      limitPrice: fields['entry-type'] === 'LIMIT' ? fields['limit-price'].trim() : '',
      budgetMode: fields['budget-mode'],
      budget: fields['budget'].trim(),
      stopMode: fields['stop-mode'],
      stop: fields['stop'].trim(),
      stopLevels: fields['stop-levels'],
      nearStopMode: two ? fields['near-stop-mode'] : '',
      nearStop: two ? fields['near-stop'].trim() : '',
      nearPercent: two ? fields['near-percent'].trim() : '',
      slippage: fields['slippage'].trim(),
      funding: fields['funding'].trim(),
      leverage: fields['leverage'].trim(),
      minimumBuffer: fields['minimum-buffer'].trim(),
      fundingCap: fields['funding-cap'].trim(),
    };
  }

  function templateLabel(value: unknown) {
    const input = applyStopTemplate(readInput(), value);
    return input.stopLevels === 'two'
      ? `双层 · ${input.nearStop}% / ${input.stop}% · ${input.nearPercent}/${formatDecimal(10_000_000_000n - parseDecimal(input.nearPercent, '近端比例'))}`
      : `单层 · ${input.stop}% · 全部退出`;
  }

  function templateReference() {
    if (snapshot) return snapshot;
    const input = readInput();
    if (
      !entryPlan ||
      input.symbol !== entryPlan.symbol ||
      input.side !== entryPlan.side ||
      input.entryType !== entryPlan.execution.entryType
    )
      return null;
    return {
      symbol: entryPlan.symbol,
      ask: entryPlan.referencePrice,
      bid: entryPlan.referencePrice,
      queriedAt: entryPlan.queriedAt,
    };
  }

  function renderTemplatePreview() {
    try {
      const input = readInput();
      const quote = templateReference();
      const template = createStopTemplate(input, quote);
      const absolute =
        input.stopMode === 'price' ||
        (input.stopLevels === 'two' && input.nearStopMode === 'price');
      const reference =
        input.entryType === 'LIMIT'
          ? input.limitPrice
          : input.side === 'long'
            ? quote?.ask
            : quote?.bid;
      show(
        'template-preview',
        `将保存：${templateLabel(template)}。${absolute ? `按原输入与入场参考价 ${reference} USDT 换算（${input.entryType === 'LIMIT' ? '本单限价' : '参考数据时间 ' + time(quote?.queriedAt ?? '')}），截取至最多 8 位小数；不保存绝对价格。` : '保存输入百分比；应用后按当前币种取整。'}`,
      );
      ui.templateSaveDisabled = !!templateReadError;
    } catch (error) {
      show('template-preview', `暂不能保存：${message(error)} 可继续手动输入。`);
      ui.templateSaveDisabled = true;
    }
  }

  function renderTemplates(selected = '') {
    const errors = templateReadError ? [templateReadError] : [];
    ui.templateOptions = templates.map((value, index) => {
      let label;
      try {
        label = templateLabel(value);
      } catch (error) {
        label = `无效模板 ${index + 1}：${message(error)}`;
        errors.push(label);
      }
      return { label, value: String(index) };
    });
    fields['stop-template'] = selected;
    ui.templateApplyDisabled = !selected;
    ui.templateDeleteDisabled = !templateReadError && !selected;
    show('template-delete', templateReadError ? '清除损坏模板记录' : '删除所选模板');
    show(
      'template-list-error',
      errors.length ? `${errors.join('；')}。无效记录不会应用，可删除或继续手动输入。` : '',
    );
  }

  function loadTemplates() {
    try {
      const value = JSON.parse(localStorage.getItem(templateKey) ?? '[]');
      if (!Array.isArray(value)) throw new Error('模板列表格式损坏，须为列表');
      templates = value;
    } catch (error) {
      templateReadError =
        error instanceof SyntaxError ? '模板记录不是有效 JSON' : `无法读取模板：${message(error)}`;
    }
    renderTemplates();
  }

  function inputChanged(reason: string) {
    inputVersion++;
    snapshot = null;
    cancelQuery(reason);
    saveSettings();
    saveTrade();
    renderDraft();
    if (fields.symbol && navigator.onLine && !suspended)
      show('leverage-liquidation-note', '更新中 · 等待输入完成后读取账户与行情。');
    scheduleRefresh(500);
  }

  function saveTemplate() {
    if (templateReadError) return;
    try {
      const template = createStopTemplate(readInput(), templateReference());
      const label = templateLabel(template);
      const duplicate = templates.findIndex((value) => {
        try {
          return templateLabel(value) === label;
        } catch {
          return false;
        }
      });
      if (duplicate >= 0) {
        renderTemplates(String(duplicate));
        show('template-status', `已有相同模板：${label}。`);
        return;
      }
      const next = [...templates, template];
      localStorage.setItem(templateKey, JSON.stringify(next));
      templates = next;
      renderTemplates(String(templates.length - 1));
      show('template-status', `已保存在当前浏览器：${label}。`);
    } catch (error) {
      show('template-status', `保存失败：${message(error)} 本次手动输入保留。`);
    }
  }
  function selectTemplate() {
    renderTemplates(fields['stop-template']);
    show('template-status', '选择后点击“应用模板”才会修改本单。');
  }
  function applyTemplate() {
    if (!fields['stop-template'] || templateReadError) return;
    try {
      const input = applyStopTemplate(readInput(), templates[Number(fields['stop-template'])]);
      for (const [id, value] of Object.entries({
        'stop-levels': input.stopLevels,
        'stop-mode': input.stopMode,
        stop: input.stop,
        'near-stop-mode': input.nearStopMode,
        'near-stop': input.nearStop,
        'near-percent': input.nearPercent,
      }))
        fields[id as FieldId] = value;
      inputChanged('已应用止损模板');
      show(
        'template-status',
        '模板已应用，预算、杠杆与资金上限保持不变；请检查试算及实际比例，再刷新生成开仓卡。',
      );
      if (!snapshot && fields.symbol) void load();
    } catch (error) {
      show('template-status', `无法应用：${message(error)} 本次手动输入保留。`);
    }
  }
  function deleteTemplate() {
    if (!fields['stop-template'] && !templateReadError) return;
    try {
      const next = templates.filter((_, index) => index !== Number(fields['stop-template']));
      if (templateReadError) localStorage.removeItem(templateKey);
      else localStorage.setItem(templateKey, JSON.stringify(next));
      templates = templateReadError ? [] : next;
      templateReadError = '';
      renderTemplates();
      renderTemplatePreview();
      show('template-status', '模板记录已删除，本次表单保持不变。');
    } catch (error) {
      show('template-status', `删除失败：${message(error)}`);
    }
  }

  function invalidateCard(reason: string) {
    invalidateVerification(reason);
    ui.cardCurrent = false;
    ui.entryCheckState = 'pending';
    show('card-check', `待检查 · ${reason}。`);
    if (!entryPlan) return;
    show(
      'card-status',
      `旧方案 · ${reason}；生成时间 ${time(entryPlan.queriedAt)}。原参数保留，复制已停用。`,
    );
  }

  function invalidateVerification(reason: string) {
    if (!entryPlan) return;
    ui.verificationCurrent = false;
    ui.verificationState = 'pending';
    show(
      'verification-status',
      `${entryPlan.source === 'demo' ? '模拟数据 · ' : ''}待核验 · ${reason}。原方案与上次时间保留。`,
    );
    hidden['verification-details'] = true;
    ui.issues = [];
    if (lastQueryAt)
      show('verification-time', `上次完整查询 ${time(lastQueryAt)}（已失效，需重新核验）。`);
    ui.verifyDisabled = JSON.stringify(readInput()) !== planInputs || ui.generateBusy;
  }

  function renderAccount(account: Snapshot['account']) {
    show('equity', account.equity);
    show('available', account.availableBalance);
    show('wallet', `${account.walletBalance} USDT`);
    show('pnl', `${account.unrealizedProfit} USDT`);
    show('queried', time(account.queriedAt));
    show('account-error', '');
    hasAccount = true;
  }

  async function refreshAccountSnapshot() {
    if (
      suspended ||
      document.hidden ||
      !navigator.onLine ||
      !hidden.relogin ||
      pending ||
      accountPending
    )
      return;
    const id = requestId;
    const controller = new AbortController();
    accountPending = controller;
    try {
      const account = await read<Account>(
        '/api/account',
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (id !== requestId || controller.signal.aborted) return;
      if (
        !['binance', 'demo'].includes(account.source) ||
        (snapshot && account.source !== snapshot.source) ||
        (entryPlan && account.source !== entryPlan.source) ||
        !Number.isFinite(Date.parse(account.queriedAt)) ||
        Math.abs(Date.now() - Date.parse(account.queriedAt)) > 30_000
      )
        throw new Error('账户快照来源或查询时间无效，请刷新。');
      const changed =
        hasAccount &&
        (account.equity !== text.equity || account.availableBalance !== text.available);
      renderAccount(account);
      show(
        'attempted',
        time(
          'attemptedAt' in account && typeof account.attemptedAt === 'string'
            ? account.attemptedAt
            : account.queriedAt,
        ),
      );
      if (changed && (snapshot || ui.cardCurrent || ui.verificationCurrent)) {
        snapshot = null;
        invalidateCard('账户余额已变化，需完整查询后重新确认');
        renderDraft();
      }
    } catch (error) {
      if (id !== requestId || controller.signal.aborted) return;
      showLogin(error);
      show(
        'account-error',
        `账户刷新失败 · ${message(error)}${hasAccount ? ' 上次快照已过期，原数值与查询时间保留。' : ''}`,
      );
      show(
        'attempted',
        time(
          error instanceof QueryFailure && error.attemptedAt
            ? error.attemptedAt
            : new Date().toISOString(),
        ),
      );
      snapshot = null;
      invalidateCard('账户刷新失败，当前结果已失效');
      renderDraft();
    } finally {
      if (accountPending === controller) accountPending = undefined;
    }
  }

  function renderVerification(result: Verification, plan: Plan) {
    lastQueryAt = result.queriedAt;
    show(
      'card-status',
      `原方案 · 成交后状态已另行查询；生成时间 ${time(plan.queriedAt)}。原参数保留，开仓复制已停用。`,
    );
    const states = {
      waiting: '待成交',
      ended: '已结束',
      incomplete: '无法完整核验',
      'needs-action': '需处理',
      verified: '已核验 · 本次流程完成',
    };
    show(
      'verification-status',
      `${result.source === 'demo' ? '模拟数据 · ' : ''}${states[result.status]}`,
    );
    show(
      'verification-time',
      `完整查询时间 ${time(result.queriedAt)}；只代表此时点。${result.reviewRetention === 'legacy-unbound' ? '旧方案缺少历史账户身份，未保存复盘关联证据。' : ''}`,
    );
    ui.verificationCurrent = result.status === 'verified';
    ui.verificationState = result.status;
    ui.issues = result.issues;
    const entryStates: Record<string, string> = {
      NEW: '挂单中',
      PARTIALLY_FILLED: '部分成交',
      FILLED: '全部成交',
      CANCELED: '已撤销余单',
      EXPIRED: '已失效',
      EXPIRED_IN_MATCH: '已失效',
      REJECTED: '已拒绝',
    };
    const outputs = {
      order: result.orderId ?? '尚未可靠关联',
      position: `${result.side === 'long' ? '做多' : result.side === 'short' ? '做空' : '空仓'} / ${result.quantity ?? '—'} ${plan.baseAsset}`,
      'entry-state': `${entryStates[result.entryStatus ?? ''] ?? (result.orderId ? '已关联' : '未确认')} / ${result.filledQuantity ?? '—'} ${plan.baseAsset}`,
      pending: result.pendingEntries
        ? result.pendingEntries
            .map(
              (order) =>
                `订单 ${order.orderId}：已成交 ${order.filledQuantity}，未成交 ${order.remainingQuantity} ${plan.baseAsset}`,
            )
            .join('；') || '本次查询未发现入场余单'
        : '未完整确认',
      entry: `${result.entryPrice ?? '—'} USDT`,
      leverage: `${result.leverage ?? '—'} / ${plan.leverage} 倍`,
      risk: `${result.plannedLoss ?? '未完整核算'} / ${plan.budget} USDT（原止损 ${plan.stopPrice}）`,
      excess: `${result.excess ?? '—'} USDT`,
      paid: `${result.paidCommission ?? '—'} / ${result.paidFunding ?? '—'} USDT`,
      reserved: `${result.remainingFunding ?? '—'} / ${result.exitFee ?? '—'} USDT`,
      liquidation: `${result.liquidationPrice ? liquidationPrice(result.liquidationPrice) : '—'} USDT`,
      buffer: `${result.liquidationBuffer ?? '—'}% / ${plan.minimumBuffer}%`,
      coverage: result.coverage ?? '未确认有效覆盖',
      near: `${result.nearStatus ?? '未确认'} / ${result.nearQuantity ?? '—'} ${plan.baseAsset}（按累计入场量分配的实际比例 ${result.nearActualPercent ?? '—'}%）`,
      realized: `${result.realizedPnl ?? '未完整核算'} USDT`,
    };
    hidden['verification-near-row'] = !plan.nearStop;
    for (const [id, value] of Object.entries(outputs)) show(`verification-${id}`, value);
    hidden['verification-details'] = false;
    if (result.account) renderAccount(result.account);
    const checked = result.entryCheck;
    ui.entryCheckState = 'inactive';
    show('card-check', '已进入成交核验或尚未确认空仓，不能据此继续开仓；请查看下方核验结果。');
    show('leverage-liquidation-note', '原方案参数已固定；请查看原卡最新检查或成交后实际强平价。');
    if (checked) {
      if (
        result.status !== 'waiting' ||
        result.quantity !== '0' ||
        result.orderId ||
        result.pendingEntries?.length !== 0 ||
        !['ready', 'needs-action', 'incomplete'].includes(checked.status) ||
        typeof checked.issue !== 'string' ||
        !Number.isFinite(Date.parse(checked.queriedAt)) ||
        Math.abs(Date.now() - Date.parse(checked.queriedAt)) > 30_000 ||
        Math.abs(Date.parse(checked.queriedAt) - Date.parse(result.queriedAt)) > 30_000
      )
        throw new Error('原卡检查响应不完整、过期或与成交状态不一致。');
      if (
        checked.status === 'ready' &&
        (checked.issue ||
          parseDecimal(checked.liquidationPrice, '预估强平价') <= 0n ||
          parseDecimal(checked.plannedLoss, '当前计划亏损') > parseDecimal(plan.budget, '原预算') ||
          parseDecimal(checked.liquidationBuffer, '当前强平缓冲') <
            parseDecimal(plan.minimumBuffer, '最低强平缓冲') ||
          parseDecimal(checked.fundingRequired, '当前资金需求') <= 0n)
      )
        throw new Error('原卡检查缺少有效的价格、风险或资金结果。');
      ui.entryCheckState = checked.status;
      ui.cardCurrent = checked.status === 'ready';
      const label =
        checked.status === 'ready'
          ? '本次查询仍符合开仓约束'
          : checked.status === 'needs-action'
            ? '需重新生成'
            : '无法确认，请刷新';
      show(
        'card-check',
        `${plan.source === 'demo' ? '模拟 · ' : ''}${label} · ${checked.issue || `原数量、预算与止损保持不变；最新预计止损亏损 ${checked.plannedLoss} USDT。`}`,
      );
      show('card-status', `原方案 · 参数固定于 ${time(plan.queriedAt)}；适用性请看下方最新检查。`);
      if (checked.liquidationPrice) {
        const price = `${liquidationPrice(checked.liquidationPrice)} USDT${plan.source === 'demo' ? '（模拟）' : ''}`;
        show('leverage-liquidation', price);
        show('card-check', `${text['card-check']} 最新预估强平价 ${price}。`);
      }
      show(
        'leverage-liquidation-note',
        checked.issue || `按原卡固定数量估算；有方向缓冲 ${checked.liquidationBuffer}%。`,
      );
    }
    saveTrade();
  }

  async function verifyCurrentPlan() {
    if (!entryPlan || ui.generateBusy) return;
    if (JSON.stringify(readInput()) !== planInputs) {
      invalidateVerification('输入已修改，请恢复原输入后核验此卡');
      return;
    }
    let plan = entryPlan;
    clearTimeout(refreshTimer);
    const version = inputVersion,
      id = ++requestId;
    pending?.abort();
    accountPending?.abort();
    pending = new AbortController();
    const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]);
    snapshot = null;
    invalidateCard('正在查询成交后的实际状态');
    renderDraft();
    ui.verifyDisabled = ui.refreshDisabled = ui.generateDisabled = true;
    ui.verifyBusy = true;
    show('verify', '正在刷新核验…');
    show('status', '正在重新核验');
    show('message', '保留原方案与上次查询时间，等待本次完整数据。');
    ui.status = 'loading';
    try {
      const scenario =
        plan.source === 'demo' ? `&demo=${encodeURIComponent(fields['demo-scenario'])}` : '';
      const restored = await read<SavedPlan>('/api/plan/recover', signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recovery: plan.recovery }),
      });
      if (id !== requestId || version !== inputVersion || entryPlan !== plan) return;
      if (restored.id !== plan.id || restored.source !== plan.source)
        throw new Error('恢复的方案或数据来源不一致，无法完整核验。');
      entryPlan = plan = restored;
      planInputs = JSON.stringify(plan.input);
      const selectedScenario = fields['demo-scenario'];
      renderCard();
      fields['demo-scenario'] = selectedScenario;
      invalidateCard('原方案已确认，正在重新查询');
      ui.verifyDisabled = true;
      if (JSON.stringify(readInput()) !== planInputs)
        throw new Error('输入与原方案不一致，请恢复原输入后核验。');
      await loadSymbols(signal, id);
      if (id !== requestId) return;
      const result = await read<Verification & { account?: Account }>(
        `/api/verification?planId=${encodeURIComponent(plan.id)}${scenario}`,
        signal,
      );
      if (id !== requestId || version !== inputVersion || entryPlan !== plan) return;
      if (
        result.source !== plan.source ||
        !['waiting', 'ended', 'incomplete', 'needs-action', 'verified'].includes(result.status) ||
        !Array.isArray(result.issues) ||
        !Number.isFinite(Date.parse(result.queriedAt)) ||
        Math.abs(Date.now() - Date.parse(result.queriedAt)) > 30_000 ||
        result.account?.source !== plan.source ||
        !Number.isFinite(Date.parse(result.account?.queriedAt ?? '')) ||
        Math.abs(Date.parse(result.queriedAt) - Date.parse(result.account?.queriedAt ?? '')) >
          10_000
      )
        throw new Error('核验响应不完整或查询时间不一致，请重新查询。');
      renderVerification(result, plan);
      show('status', plan.source === 'demo' ? '模拟核验查询完成' : '实际仓位查询完成');
      show('message', '请查看下方成交后核验结果，开仓前估值保留在原卡。');
      show('attempted', time(result.queriedAt));
      ui.status = result.status === 'verified' ? 'success' : 'error';
    } catch (error) {
      if (id !== requestId || version !== inputVersion) return;
      showLogin(error);
      invalidateCard('本次查询失败，原卡适用性未确认');
      show('leverage-liquidation', '—');
      show('leverage-liquidation-note', `查询失败 · ${message(error)}`);
      invalidateVerification('本次查询失败，上次结果已失效');
      ui.verificationState = 'incomplete';
      show(
        'card-status',
        `原方案 · 本次核验查询失败；生成时间 ${time(plan.queriedAt)}。原参数保留，复制已停用。`,
      );
      show(
        'verification-status',
        `${plan.source === 'demo' ? '模拟数据 · ' : ''}无法完整核验 · ${message(error)}`,
      );
      show(
        'verification-time',
        `${lastQueryAt ? '上次完整查询 ' + time(lastQueryAt) + '（已过期）' : '尚无完整查询'}；本次尝试 ${time(new Date().toISOString())}。`,
      );
      show('status', '需处理 · 本次核验查询失败');
      show('message', message(error));
      ui.status = 'error';
    } finally {
      if (id === requestId) {
        pending = undefined;
        ui.refreshDisabled = false;
        ui.generateDisabled = !navigator.onLine;
        ui.verifyDisabled = JSON.stringify(readInput()) !== planInputs;
        ui.verifyBusy = false;
        show('verify', '返回后刷新核验');
        scheduleRefresh();
      }
    }
  }

  function renderDraft() {
    renderTemplatePreview();
    ui.draftState = snapshot ? 'error' : 'pending';
    const limit = fields['entry-type'] === 'LIMIT';
    const two = fields['stop-levels'] === 'two';
    ui.two = two;
    show('near-stop-unit', fields['near-stop-mode'] === 'percent' ? '%' : 'USDT');
    try {
      const ratio = parseDecimal(fields['near-percent'].trim(), '近端比例');
      show(
        'final-percent',
        ratio > 0n && ratio < 10_000_000_000n ? `${formatDecimal(10_000_000_000n - ratio)}%` : '—',
      );
    } catch {
      show('final-percent', '—');
    }
    hidden['limit-field'] = !limit;
    ui.limit = limit;
    hidden['draft-result'] = true;
    hidden['entry-checks'] = true;
    show('leverage-liquidation', '—');
    show('leverage-liquidation-note', '等待当前币种的完整账户与行情快照，请选择币种或刷新。');
    show('entry-error', '');
    show('budget-unit', fields['budget-mode'] === 'percent' ? '%' : 'USDT');
    show('stop-unit', fields['stop-mode'] === 'percent' ? '%' : 'USDT');
    if (!snapshot) {
      show(
        'draft-error',
        entryPlan
          ? '原开仓方案保留在下方；成交后请使用“返回后刷新核验”。'
          : fields.symbol
            ? '等待完整账户与行情快照，查询失败后请刷新。'
            : '选择币种并填写本次计划。',
      );
      return;
    }
    try {
      const input = readInput();
      let plan = generateDraft(input, snapshot);
      try {
        const checked = generateEntryPreview(input, snapshot);
        show(
          'leverage-liquidation',
          `${liquidationPrice(checked.liquidationPrice)} USDT${snapshot.source === 'demo' ? '（模拟）' : ''}`,
        );
        show('leverage-liquidation-note', `有方向缓冲 ${checked.liquidationBuffer}%。`);
        if (checked.liquidationIssue) throw new Error(checked.liquidationIssue);
        plan = checked;
        show('preview-funding', `${checked.fundingRequired} / ${checked.fundingLimit} USDT`);
        show(
          'preview-costs',
          `${checked.initialMargin} / ${checked.openLoss} / ${checked.openFeeReserve} USDT`,
        );
        show(
          'preview-liquidation',
          `${liquidationPrice(checked.liquidationPrice)} USDT（假设逐仓本金 ${checked.isolatedWalletAssumption} USDT）`,
        );
        show('preview-buffer', `${checked.liquidationBuffer}% / ${checked.minimumBuffer}%`);
        hidden['entry-checks'] = false;
      } catch (error) {
        show('leverage-liquidation-note', `需处理 · ${message(error)}`);
        show('entry-error', `需处理 · ${message(error)} 当前试算仅包含价格风险约束。`);
      }
      const outputs = {
        quantity: `${plan.quantity} ${snapshot.baseAsset}`,
        budget: `${plan.budget} USDT`,
        notional: `${plan.notional} USDT`,
        stop: `${plan.stopPrice} USDT / 约 ${plan.stopDistance}%`,
        distance: plan.nearStop
          ? `近端 ${plan.nearStop.quantity} ${snapshot.baseAsset} / ${plan.nearStop.actualPercent}%；最终剩余 ${plan.finalQuantity} / ${plan.finalPercent}%`
          : '全部仓位 / 100%',
        loss: `${plan.plannedLoss} USDT`,
        near: plan.nearStop ? `${plan.nearStop.price} USDT / 约 ${plan.nearStop.distance}%` : '—',
        reference: `${plan.referencePrice} USDT（${limit ? '用户委托价' : fields['side'] === 'long' ? '卖一' : '买一'}）`,
        entry: `${plan.entryEstimate} USDT`,
        exit: `${plan.exitEstimate} USDT`,
        fees: `${plan.entryFee} / ${plan.exitFee} USDT`,
        slippage: `${plan.slippagePercent}%`,
        funding: plan.fundingReserved ? `${plan.funding} USDT` : '未预留资金费',
        condition: `标记价 ${fields['side'] === 'long' ? '≤' : '≥'} ${plan.stopPrice} USDT 时触发最终止损市价，退出全部剩余仓位；触发价不等于成交价。${plan.nearStop ? '总仓位按全部落到最终止损计算，不依赖近端退出成功。' : ''}`,
        time: `${plan.source === 'demo' ? '模拟数据' : 'Binance 只读快照'} · ${time(plan.queriedAt)}；按此快照试算，行情变化后请刷新。`,
      };
      for (const [id, value] of Object.entries(outputs)) show(`draft-${id}`, value);
      hidden['draft-near-row'] = !plan.nearStop;
      show('draft-error', '');
      hidden['draft-result'] = false;
    } catch (error) {
      show('draft-error', message(error));
      show('leverage-liquidation-note', `待计算 · ${message(error)}`);
    }
  }

  function renderCard() {
    if (!entryPlan) return;
    const plan = entryPlan;
    const limit = plan.execution.entryType === 'LIMIT';
    const outputs = {
      symbol: plan.symbol,
      direction: plan.side === 'long' ? '· 做多' : '· 做空',
      quantity: `${plan.quantity} ${plan.baseAsset}`,
      'entry-type': limit ? '普通限价入场 · GTC · 按 taker 费率预留' : '市价入场',
      limitPrice: plan.limitPrice,
      stopPrice: plan.stopPrice,
      exitMode: `${plan.exitMode} · 止损${plan.execution.stopSide === 'SELL' ? '卖出' : '买入'}，不填写固定退出数量`,
      leverage: `所选杠杆 ${plan.leverage} 倍`,
      'final-allocation': `实际距离约 ${plan.stopDistance}%${plan.nearStop ? `；近端成功退出后预计剩余 ${plan.finalQuantity} ${plan.baseAsset} / ${plan.finalPercent}%。最终单始终选择整仓退出。` : ''}`,
      nearPrice: plan.nearStop?.price ?? '—',
      nearQuantity: plan.nearStop ? `${plan.nearStop.quantity} ${plan.baseAsset}` : '—',
      'near-distance': plan.nearStop
        ? `实际距离约 ${plan.nearStop.distance}%；标记价触发、止损市价、关闭价格保护。`
        : '',
      'near-ratio': plan.nearStop
        ? `原输入 ${plan.nearStop.percent}%，取整后实际 ${plan.nearStop.actualPercent}%。`
        : '',
      budget: `${plan.budget} USDT`,
      notional: `${plan.notional} USDT`,
      loss: `${plan.plannedLoss} USDT`,
      funding: `${plan.fundingRequired} / ${plan.fundingLimit} USDT`,
      margin: `${plan.initialMargin} USDT`,
      'open-costs': `${plan.openLoss} / ${plan.openFeeReserve} USDT`,
      liquidation: `${liquidationPrice(plan.liquidationPrice)} USDT`,
      buffer: `${plan.liquidationBuffer}% / ${plan.minimumBuffer}%`,
      assuming: `${plan.assumingPrice} USDT`,
      estimates: `${plan.entryEstimate} / ${plan.exitEstimate} USDT`,
      fees: `${plan.entryFee} / ${plan.exitFee} USDT`,
      reserves: `${plan.slippagePercent}% / ${plan.fundingReserved ? plan.funding + ' USDT' : '未预留资金费'}`,
      wallet: `${plan.isolatedWalletAssumption} USDT`,
      tier: `${plan.liquidationTier} / ${plan.maintenanceRate}% / ${plan.maintenanceAmount} USDT`,
      limit: `${plan.notionalLimit} USDT`,
      'account-time': time(plan.accountTime),
      'book-time': time(plan.bookTime),
      'price-times': `${time(plan.markTime)} / ${time(plan.lastTime)}`,
      time: time(plan.queriedAt),
      instructions: `在 Binance 采用逐仓、单向持仓、${plan.leverage} 倍杠杆；${limit ? `普通限价（GTC，委托价 ${plan.limitPrice} USDT）` : '市价'}${plan.side === 'long' ? '买入做多' : '卖出做空'} ${plan.quantity} ${plan.baseAsset}。先附带并确认最终止损市价：绝对触发价 ${plan.stopPrice} USDT、标记价触发、关闭价格保护、整仓退出。${plan.nearStop ? `确认整仓保护有效后，再补近端 ${plan.nearStop.price} USDT、${plan.nearStop.quantity} ${plan.baseAsset} 的止损市价，只减仓、标记价触发、关闭价格保护；保留最终整仓保护。仅有最终单还未完成双层计划。` : ''}${limit ? '部分成交后先人工撤余单，再返回刷新核验；近端数量按实际累计入场量与原比例复算，止损执行不代表余单已撤。' : '请确认这些设置后手动执行。'}`,
      'funding-model': `${limit ? '限价多头保证金按委托价；空头按最新成交价 × 1.0015、标记价、委托价中的较大值。开仓浮亏按委托价与标记价的不利差计算。' : '市价下单资金估值采用最新成交价 × 1.0015。'}费用按下单估值与不利成交估值中的较大名义价值预留。名义价值上限同时约束标记价、下单估值和不利成交估值。`,
    };
    for (const [id, value] of Object.entries(outputs)) show(`card-${id}`, value);
    hidden['card-limit-row'] = !limit;
    hidden['card-near'] = !plan.nearStop;
    ui.cardLimit = limit;
    ui.cardTwo = !!plan.nearStop;
    fields['demo-scenario'] = limit ? 'waiting' : 'missing-stop';
    show('card-title', plan.source === 'demo' ? '模拟开仓卡 · 不可用于真实交易' : '本次开仓卡');
    show('card-status', `${plan.notice} 数据截至 ${time(plan.queriedAt)}。`);
    show('copy-status', '数量和价格仅复制数值，请核对上方单位。');
    ui.cardCurrent = true;
    ui.entryCheckState = 'ready';
    show('card-check', '生成时检查通过；页面可见且联网时每 10 秒重新检查，原卡参数保持固定。');
    hidden['entry-card'] = false;
    hidden['verification'] = false;
    ui.verificationCurrent = false;
    ui.verificationState = 'pending';
    hidden['demo-verification'] = plan.source !== 'demo';
    hidden['verification-details'] = true;
    ui.issues = [];
    show(
      'verification-start',
      `本单空仓起点 ${time(plan.startedAt)} · ${plan.symbol} · 原预算 ${plan.budget} USDT · 原最终止损 ${plan.stopPrice} USDT${plan.nearStop ? ` · 原近端止损 ${plan.nearStop.price} USDT` : ''}`,
    );
    show('verification-status', '待核验 · 在 Binance 手动执行后，返回此处刷新。');
    show('verification-time', '尚无完整查询');
    show('refresh', '刷新账户与核验原方案');
    hidden['draft-result'] = true;
    hidden['entry-checks'] = true;
  }

  async function generateCard() {
    if (ui.generateBusy) return;
    clearTimeout(refreshTimer);
    const input = readInput(),
      version = inputVersion;
    const id = ++requestId;
    pending?.abort();
    accountPending?.abort();
    pending = new AbortController();
    ui.generateBusy = true;
    ui.generateDisabled = true;
    show('generate', '正在刷新并生成…');
    show('status', '正在生成开仓卡');
    show('message', '正在刷新账户、行情及规则，请等待本次完整结果。');
    ui.status = 'loading';
    invalidateCard('正在重新生成方案');
    ui.refreshDisabled = true;
    snapshot = null;
    renderDraft();
    try {
      const plan = await read<SavedPlan>(
        '/api/plan',
        AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (id !== requestId) return;
      if (version !== inputVersion) throw new Error('查询期间输入已变化，请重新生成开仓卡。');
      entryPlan = plan;
      planInputs = JSON.stringify(input);
      lastQueryAt = '';
      renderAccount(plan.account);
      renderCard();
      show(
        'leverage-liquidation',
        `${liquidationPrice(plan.liquidationPrice)} USDT${plan.source === 'demo' ? '（模拟）' : ''}`,
      );
      show(
        'leverage-liquidation-note',
        `按原卡固定数量估算；有方向缓冲 ${plan.liquidationBuffer}%。`,
      );
      saveTrade();
      renderTemplatePreview();
      show('draft-error', '');
      show('status', plan.source === 'demo' ? '模拟方案已生成' : '正式方案已生成 · 待执行与核验');
      show('message', '本单预算与止损已固定；到 Binance 手动执行后，返回刷新核验。');
      show('attempted', time(plan.queriedAt));
      ui.status = 'success';
      await nextTick();
      if (id !== requestId) return;
      cardElement.value?.focus({ preventScroll: true });
      cardElement.value?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: 'start',
      });
      show('entry-error', '');
    } catch (error) {
      if (id === requestId) {
        showLogin(error);
        show('entry-error', `需处理 · ${message(error)}`);
        show('status', '需处理 · 本次方案未生成');
        show('message', message(error));
        ui.status = 'error';
      }
    } finally {
      if (id === requestId) {
        pending = undefined;
        ui.generateBusy = false;
        show('generate', '刷新并生成开仓卡');
        ui.generateDisabled = !navigator.onLine;
        ui.refreshDisabled = false;
        ui.verifyDisabled = !entryPlan || JSON.stringify(readInput()) !== planInputs;
        scheduleRefresh();
      }
    }
  }

  async function read<T>(path: string, signal: AbortSignal, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { ...options, cache: 'no-store', signal });
    if (response.status === 401) throw new LoginRequired('登录已过期，请重新登录后继续本单。');
    const data: unknown = await response.json();
    if (!response.ok) {
      const error = record(data);
      const retry =
        typeof error.retryAt === 'string' && Number.isFinite(Date.parse(error.retryAt))
          ? ` 下次允许读取：${time(error.retryAt)}。`
          : '';
      const failure = new QueryFailure(
        `${typeof error.error === 'string' ? error.error : '查询失败，请重试。'}${retry}`,
        {
          cause: response.status === 409 ? error.code : undefined,
        },
      );
      if (typeof error.attemptedAt === 'string' && Number.isFinite(Date.parse(error.attemptedAt)))
        failure.attemptedAt = error.attemptedAt;
      throw failure;
    }
    return data as T;
  }

  async function loadSymbols(signal: AbortSignal, id: number) {
    if (symbolsLoaded) return;
    const data = await read<{ symbols: unknown }>('/api/symbols', signal);
    if (id !== requestId) return;
    if (
      !Array.isArray(data.symbols) ||
      !data.symbols.every((value: unknown) => typeof value === 'string')
    )
      throw new Error('币种列表无效。');
    ui.symbols = [...new Set([...ui.symbols, ...(data.symbols as string[])])];
    symbolsLoaded = true;
  }

  async function load() {
    clearTimeout(refreshTimer);
    const id = ++requestId;
    pending?.abort();
    accountPending?.abort();
    pending = new AbortController();
    const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]);
    snapshot = null;
    invalidateCard('数据正在刷新，原卡不代表当前状态');
    hidden['account-only'] = true;
    hidden['market-details'] = true;
    show('fee', '等待账户查询');
    renderDraft();
    show('leverage-liquidation-note', '更新中 · 正在读取账户与行情。');
    ui.refreshDisabled = true;
    ui.generateDisabled = true;
    ui.status = 'loading';
    show('status', '正在查询');
    show('message', hasAccount ? '保留上次账户快照，正在读取本次数据…' : '正在读取账户与合约数据…');
    try {
      await loadSymbols(signal, id);
      if (id !== requestId) return;
      const selected = fields.symbol;
      const data = selected
        ? await read<Snapshot>(`/api/market?symbol=${encodeURIComponent(selected)}`, signal)
        : await read<Account>('/api/account', signal);
      if (id !== requestId || fields.symbol !== selected) return;
      if (
        'account' in data &&
        (data.symbol !== selected ||
          [
            data.queriedAt,
            data.account.queriedAt,
            data.bookTime,
            data.markTime,
            data.lastTime,
          ].some(
            (value) =>
              !Number.isFinite(Date.parse(value)) ||
              Math.abs(Date.now() - Date.parse(value)) > 30_000,
          ))
      )
        throw new Error('账户或行情数据缺失、币种不一致或已过期，请刷新。');
      const account = 'account' in data ? data.account : data;
      renderAccount(account);
      show('attempted', time(data.queriedAt));
      show(
        'source',
        data.source === 'demo'
          ? '模拟数据 · 仅用于界面与流程验证'
          : '真实模式 · 数据由 Binance 只读接口查询',
      );
      show('status', data.source === 'demo' ? '模拟查询成功' : '已连接 · 只读查询成功');
      show(
        'message',
        selected
          ? '当前快照符合空仓、逐仓与单向持仓条件；正式生成前还会刷新并检查资金与强平缓冲。'
          : '选择币种后读取适用费率、行情和开仓前账户条件。',
      );
      ui.status = 'success';
      hasAccount = true;
      if ('account' in data) {
        snapshot = data;
        show(
          'fee',
          `${formatDecimal(parseDecimal(snapshot.takerRate, '账户费率') * 100n)}% · ${snapshot.source === 'demo' ? '模拟费率' : 'Binance 账户读取'}`,
        );
        show('market-book', `${snapshot.bid} / ${snapshot.ask} USDT`);
        show('market-mark', `${snapshot.mark} USDT`);
        show(
          'market-steps',
          `${snapshot.rules.tickSize} USDT / ${snapshot.rules.stepSize} ${snapshot.baseAsset}`,
        );
        show(
          'market-quantity',
          `${snapshot.rules.minQty}–${snapshot.rules.maxQty} ${snapshot.baseAsset}`,
        );
        show(
          'market-limit-quantity',
          `${snapshot.rules.lotSize.minQty}–${snapshot.rules.lotSize.maxQty} / ${snapshot.rules.lotSize.stepSize} ${snapshot.baseAsset}`,
        );
        show('market-minimum', `${snapshot.rules.minNotional} USDT（市价按标记价，限价按委托价）`);
        show('market-book-time', time(snapshot.bookTime));
        show('market-mark-time', time(snapshot.markTime));
        show('market-time', time(snapshot.queriedAt));
        show('market-last', `${snapshot.last} USDT / ${time(snapshot.lastTime)}`);
        show(
          'market-brackets',
          snapshot.brackets
            .map((tier) => `${tier.floor}–${tier.cap} USDT：最高 ${tier.maxLeverage} 倍`)
            .join('；'),
        );
        hidden['market-details'] = false;
      }
      renderDraft();
      invalidateCard('已读取新快照；原卡未重新生成');
      return snapshot;
    } catch (error) {
      if (id !== requestId) return;
      showLogin(error);
      snapshot = null;
      renderDraft();
      const marginConflict = error instanceof Error && error.cause === 'unsupported_margin';
      show(
        'status',
        marginConflict
          ? '该币种暂不能开仓 · 需设置逐仓'
          : hasAccount
            ? '需处理 · 下方账户快照已过期'
            : '需处理 · 查询未成功',
      );
      show(
        'message',
        message(error) +
          (marginConflict && hasAccount ? ' 下方保留的是上次账户快照，可单独刷新账户。' : ''),
      );
      hidden['account-only'] = !marginConflict;
      show('draft-error', message(error));
      show('leverage-liquidation-note', `查询失败 · ${message(error)}`);
      ui.draftState = 'error';
      show(
        'entry-error',
        marginConflict
          ? '请先处理该币种的保证金模式，再刷新生成开仓卡。'
          : '关键数据查询失败，暂停生成新开仓卡。',
      );
      invalidateCard('数据已过期，关键查询失败');
      show(
        'attempted',
        time(
          error instanceof QueryFailure && error.attemptedAt
            ? error.attemptedAt
            : new Date().toISOString(),
        ),
      );
      ui.status = 'error';
    } finally {
      if (id === requestId) {
        pending = undefined;
        ui.refreshDisabled = false;
        ui.generateDisabled = ui.generateBusy || !navigator.onLine;
        scheduleRefresh();
      }
    }
  }

  function accountOnly() {
    fields.symbol = '';
    inputChanged('输入已修改');
    symbolChanged();
    document.getElementById('symbol-trigger')?.focus();
  }
  function symbolChanged() {
    if (fields['stop-mode'] === 'price') fields.stop = '';
    if (fields['near-stop-mode'] === 'price') fields['near-stop'] = '';
    fields['limit-price'] = '';
    saveSettings();
    saveTrade();
    void load();
  }
  function refreshAccount() {
    void (entryPlan && JSON.stringify(readInput()) === planInputs ? verifyCurrentPlan() : load());
  }
  function scenarioChanged() {
    inputVersion++;
    cancelQuery('模拟场景已变化，请刷新');
    saveTrade();
    scheduleRefresh(500);
  }
  async function copyValue(key: string) {
    if (!entryPlan || !ui.cardCurrent) return;
    const values = {
      quantity: entryPlan.quantity,
      limitPrice: entryPlan.limitPrice,
      stopPrice: entryPlan.stopPrice,
      nearPrice: entryPlan.nearStop?.price ?? '',
      nearQuantity: entryPlan.nearStop?.quantity ?? '',
      leverage: entryPlan.leverage,
      exitMode: entryPlan.exitMode,
    };
    if (
      key !== 'quantity' &&
      key !== 'limitPrice' &&
      key !== 'stopPrice' &&
      key !== 'nearPrice' &&
      key !== 'nearQuantity' &&
      key !== 'leverage' &&
      key !== 'exitMode'
    )
      return;
    try {
      await navigator.clipboard.writeText(values[key]);
      show(
        'copy-status',
        `已复制：${values[key]}${key === 'quantity' || key === 'nearQuantity' ? '（单位 ' + entryPlan.baseAsset + '）' : key === 'stopPrice' || key === 'nearPrice' || key === 'limitPrice' ? '（USDT 绝对价格）' : ''}`,
      );
    } catch {
      show('copy-status', '浏览器无法复制，请长按卡片中的参数手动复制。');
    }
  }
  function resume() {
    if (suspended || document.hidden || !hidden.relogin || pending) return;
    if (!navigator.onLine) {
      suspend('网络已断开，请联网后重试');
      return;
    }
    void (entryPlan && JSON.stringify(readInput()) === planInputs ? verifyCurrentPlan() : load());
  }

  function suspend(reason: string) {
    suspended = true;
    snapshot = null;
    cancelQuery(reason);
    saveTrade();
    renderDraft();
    show('status', entryPlan ? '待核验 · 原查询已失效' : '草稿 · 等待重新查询');
    show('message', reason);
    ui.status = 'error';
  }

  function restoreInputs() {
    if (!entryPlan) return;
    const input = entryPlan.input;
    for (const id of inputIds) {
      const key = id.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      ) as keyof EntryInput;
      const value = input[key];
      if (typeof value === 'string' && (!fieldOptions[id] || fieldOptions[id].includes(value)))
        fields[id] = value;
    }
    inputChanged('已恢复原方案输入，请重新核验');
    resume();
  }
  function clearTrade() {
    if (
      !confirm(
        '清除本单记录并开始新一单？不会改变 Binance 仓位或挂单；原计划将无法从当前浏览器恢复。',
      )
    )
      return;
    try {
      localStorage.removeItem(tradeKey);
    } catch {
      show('recovery-status', '清除失败，本单记录保留。');
      return;
    }
    cancelQuery('已清除本单');
    entryPlan = null;
    planInputs = lastQueryAt = tradeReadError = '';
    hidden['entry-card'] = hidden['verification'] = true;
    for (const id of ['stop', 'near-stop', 'limit-price', 'funding-cap'] as const) fields[id] = '';
    show('refresh', '刷新账户与行情');
    show('recovery-status', '已清除本单记录；新方案仍须确认空仓起点。');
    void load();
  }

  function scenarioAllowed(value: string) {
    const limitOnly = ['partial', 'partial-more', 'canceled-remainder', 'stop-first'];
    const twoOnly = ['final-only', 'near-filled', 'final-canceled', 'missing-attribution'];
    return (
      fieldOptions['demo-scenario']!.includes(value) &&
      (!limitOnly.includes(value) || ui.cardLimit) &&
      (!twoOnly.includes(value) || ui.cardTwo)
    );
  }
  onMounted(() => {
    const events = new AbortController();
    const options = { signal: events.signal };
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) suspend('页面已离开；返回后重新查询，离开期间不监控');
        else {
          suspended = false;
          resume();
        }
      },
      options,
    );
    window.addEventListener('pagehide', () => suspend('页面已关闭或离开；重新打开后查询'), options);
    window.addEventListener(
      'pageshow',
      (event) => {
        if (event.persisted) {
          suspend('已返回页面；原查询已失效');
          suspended = false;
          resume();
        }
      },
      options,
    );
    window.addEventListener('offline', () => suspend('网络已断开，请联网后重试'), options);
    window.addEventListener(
      'online',
      () => {
        suspended = false;
        resume();
      },
      options,
    );
    const accountTimer = setInterval(() => void refreshAccountSnapshot(), 3_000);
    cleanup = () => {
      events.abort();
      clearTimeout(refreshTimer);
      clearInterval(accountTimer);
      requestId++;
      pending?.abort();
      accountPending?.abort();
    };
    restoreTrade();
    ui.costsOpen = !fields.slippage || !fields['minimum-buffer'];
    loadTemplates();
    renderDraft();
    resume();
  });
  let cleanup = () => {};
  onUnmounted(() => cleanup());
  return {
    fields,
    text,
    hidden,
    ui,
    cardElement,
    inputChanged,
    symbolChanged,
    saveTemplate,
    selectTemplate,
    applyTemplate,
    deleteTemplate,
    renderDraft,
    generateCard,
    verifyCurrentPlan,
    refreshAccount,
    scenarioChanged,
    copyValue,
    restoreInputs,
    clearTrade,
    accountOnly,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
