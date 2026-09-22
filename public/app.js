import { generateDraft, generateEntryPlan, formatDecimal, parseDecimal, createStopTemplate, applyStopTemplate } from './draft.js';

/** @param {string} id */
function element(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error('页面元素缺失');
  return el;
}
/** @param {string} id */
function field(id) {
  const el = element(id);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) throw new Error('输入控件缺失');
  return el;
}
const refresh = element('refresh');
if (!(refresh instanceof HTMLButtonElement)) throw new Error('刷新按钮缺失');
const generate = element('generate');
if (!(generate instanceof HTMLButtonElement)) throw new Error('生成按钮缺失');
const verify = element('verify');
if (!(verify instanceof HTMLButtonElement)) throw new Error('核验按钮缺失');
const statusBox = element('status').closest('section');
const form = element('draft-form');
const symbol = field('symbol');
const settingIds = ['symbol', 'side', 'entry-type', 'budget-mode', 'budget', 'stop-mode', 'stop-levels', 'near-stop-mode', 'near-percent', 'slippage', 'funding', 'leverage', 'minimum-buffer'];
const storageKey = 'entry-guidance.preferences.v1';
const templateKey = 'entry-guidance.stop-templates.v1';
const tradeKey = 'entry-guidance.current-trade.v1';
const inputIds = [...settingIds, 'stop', 'near-stop', 'limit-price', 'funding-cap'];
let tradeReadError = '';
let lastQueryAt = '';
let symbolsLoaded = false;
/** @type {unknown[]} */
let templates = [];
let templateReadError = '';
let hasAccount = false;
let requestId = 0;
/** @type {AbortController | undefined} */
let pending;
/** @type {import('./draft.js').Snapshot | null} */
let snapshot = null;
/** @type {import('../src/server.ts').SavedPlan | null} */
let entryPlan = null;
let planInputs = '';
let cardCurrent = false;
let inputVersion = 0;
let generating = false;

/** @param {string} value */
const time = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });
/** @param {string} id @param {string} value */
const show = (id, value) => { element(id).textContent = value; };
/** @param {unknown} error */
const message = (error) => error instanceof Error && !['TimeoutError', 'TypeError', 'AbortError'].includes(error.name) ? error.message : '网络中断或查询超时，请稍后重试。';

class LoginRequired extends Error {}

/** @param {unknown} error */
function showLogin(error) {
  if (error instanceof LoginRequired) element('relogin').hidden = false;
}

function saveTrade() {
  if (tradeReadError) return;
  try {
    localStorage.setItem(tradeKey, JSON.stringify({ version: 1, fields: Object.fromEntries(inputIds.map((id) => [id, field(id).value])), recovery: entryPlan?.recovery ?? '', lastQueryAt, scenario: field('demo-scenario').value }));
    show('recovery-status', '本次输入与原方案已保存在当前浏览器；返回后重新查询，页面关闭期间不监控。');
  } catch { show('recovery-status', '无法保存本单；当前页面仍可继续，关闭或重新登录可能丢失本次计划。'); }
}

/** @param {Record<string, unknown>} values */
function restoreFields(values) {
  for (const id of inputIds) {
    const value = values[id];
    if (typeof value !== 'string' || value.length > 34) throw new Error('本单输入记录损坏');
    const control = field(id);
    if (id === 'symbol') {
      if (value && !/^[A-Z0-9]{1,30}USDT$/.test(value)) throw new Error('本单币种记录损坏');
    } else if (control instanceof HTMLSelectElement && !Array.from(control.options).some((option) => option.value === value)) throw new Error('本单选项记录损坏');
  }
  for (const id of inputIds) {
    const value = /** @type {string} */ (values[id]);
    if (id === 'symbol' && symbol instanceof HTMLSelectElement && value && !Array.from(symbol.options).some((option) => option.value === value)) symbol.add(new Option(value, value));
    field(id).value = value;
  }
}

function restoreTrade() {
  try {
    const settings = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    const fields = Object.fromEntries(inputIds.map((id) => [id, field(id).value]));
    for (const id of settingIds) if (typeof settings?.[id] === 'string') fields[id] = settings[id];
    restoreFields(fields);
  } catch { show('save-status', '无法读取保存的设置，请填写本次参数。'); }
  try {
    const raw = localStorage.getItem(tradeKey);
    if (!raw) return;
    if (raw.length > 24_000) throw new Error('本单记录过大');
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || !saved.fields || typeof saved.recovery !== 'string' || typeof saved.lastQueryAt !== 'string' || (saved.lastQueryAt && !Number.isFinite(Date.parse(saved.lastQueryAt)))) throw new Error('本单记录格式损坏');
    if (saved.recovery) {
      // This local copy is display-only until the server authenticates the recovery envelope.
      const payload = saved.recovery.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const envelope = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))));
      const plan = envelope?.plan;
      if (envelope.version !== 1 || !plan || !['demo', 'binance'].includes(plan.source) || !plan.execution || !plan.account || !envelope.input || !['id', 'symbol', 'budget', 'quantity', 'stopPrice', 'queriedAt', 'startedAt'].every((key) => typeof plan[key] === 'string') || (plan.nearStop && typeof plan.nearStop !== 'object')) throw new Error('原方案记录损坏');
      entryPlan = { ...plan, input: envelope.input, recovery: saved.recovery };
      planInputs = JSON.stringify(envelope.input);
    }
    restoreFields(saved.fields);
    lastQueryAt = saved.lastQueryAt;
    if (entryPlan) {
      renderCard();
      renderAccount(entryPlan.account);
      invalidateCard('已恢复本地副本，须确认原方案并重新查询');
    }
    if (typeof saved.scenario === 'string' && Array.from(/** @type {HTMLSelectElement} */ (field('demo-scenario')).options).some((option) => option.value === saved.scenario && !option.disabled)) field('demo-scenario').value = saved.scenario;
    show('recovery-status', '已恢复本次输入与旧参数；旧结果不证明当前状态，正在重新查询。');
  } catch (error) {
    entryPlan = null;
    planInputs = '';
    element('entry-card').hidden = element('verification').hidden = true;
    tradeReadError = `无法恢复本单：${error instanceof SyntaxError ? '本单记录格式损坏' : message(error)}。未覆盖原记录，可清除本单记录后重新开始。`;
    show('recovery-status', tradeReadError);
  }
}

/** @param {string} reason */
function cancelQuery(reason) {
  requestId++;
  pending?.abort();
  pending = undefined;
  generating = false;
  if (refresh instanceof HTMLButtonElement) refresh.disabled = false;
  if (generate instanceof HTMLButtonElement) generate.disabled = !navigator.onLine;
  invalidateCard(reason);
}

function saveSettings() {
  try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(settingIds.map((id) => [id, field(id).value])))); }
  catch { show('save-status', '浏览器无法保存设置，本次输入仍可使用。'); }
}

function readInput() {
  const two = field('stop-levels').value === 'two';
  return { symbol: symbol.value, side: field('side').value, entryType: field('entry-type').value, limitPrice: field('entry-type').value === 'LIMIT' ? field('limit-price').value.trim() : '', budgetMode: field('budget-mode').value, budget: field('budget').value.trim(), stopMode: field('stop-mode').value, stop: field('stop').value.trim(), stopLevels: field('stop-levels').value, nearStopMode: two ? field('near-stop-mode').value : '', nearStop: two ? field('near-stop').value.trim() : '', nearPercent: two ? field('near-percent').value.trim() : '', slippage: field('slippage').value.trim(), funding: field('funding').value.trim(), leverage: field('leverage').value.trim(), minimumBuffer: field('minimum-buffer').value.trim(), fundingCap: field('funding-cap').value.trim() };
}

/** @param {unknown} value */
function templateLabel(value) {
  const input = applyStopTemplate(readInput(), value);
  return input.stopLevels === 'two' ? `双层 · ${input.nearStop}% / ${input.stop}% · ${input.nearPercent}/${formatDecimal(10_000_000_000n - parseDecimal(input.nearPercent, '近端比例'))}` : `单层 · ${input.stop}% · 全部退出`;
}

function templateReference() {
  if (snapshot) return snapshot;
  const input = readInput();
  if (!entryPlan || input.symbol !== entryPlan.symbol || input.side !== entryPlan.side || input.entryType !== entryPlan.execution.entryType) return null;
  return { symbol: entryPlan.symbol, ask: entryPlan.referencePrice, bid: entryPlan.referencePrice, queriedAt: entryPlan.queriedAt };
}

function renderTemplatePreview() {
  const button = element('template-save');
  if (!(button instanceof HTMLButtonElement)) return;
  try {
    const input = readInput();
    const quote = templateReference();
    const template = createStopTemplate(input, quote);
    const absolute = input.stopMode === 'price' || (input.stopLevels === 'two' && input.nearStopMode === 'price');
    const reference = input.entryType === 'LIMIT' ? input.limitPrice : input.side === 'long' ? quote?.ask : quote?.bid;
    show('template-preview', `将保存：${templateLabel(template)}。${absolute ? `按原输入与入场参考价 ${reference} USDT 换算（${input.entryType === 'LIMIT' ? '本单限价' : '参考数据时间 ' + time(quote?.queriedAt ?? '')}），截取至最多 8 位小数；不保存绝对价格。` : '保存输入百分比；应用后按当前币种取整。'}`);
    button.disabled = !!templateReadError;
  } catch (error) {
    show('template-preview', `暂不能保存：${message(error)} 可继续手动输入。`);
    button.disabled = true;
  }
}

/** @param {string} [selected] */
function renderTemplates(selected = '') {
  const select = field('stop-template');
  if (!(select instanceof HTMLSelectElement)) return;
  const errors = templateReadError ? [templateReadError] : [];
  const options = templates.map((value, index) => {
    let label;
    try { label = templateLabel(value); }
    catch (error) { label = `无效模板 ${index + 1}：${message(error)}`; errors.push(label); }
    return new Option(label, String(index));
  });
  select.replaceChildren(new Option('选择模板', ''), ...options);
  select.value = selected;
  for (const id of ['template-apply', 'template-delete']) {
    const button = element(id);
    if (button instanceof HTMLButtonElement) button.disabled = id === 'template-delete' && !!templateReadError ? false : !select.value;
  }
  show('template-delete', templateReadError ? '清除损坏模板记录' : '删除所选模板');
  show('template-list-error', errors.length ? `${errors.join('；')}。无效记录不会应用，可删除或继续手动输入。` : '');
}

function loadTemplates() {
  try {
    const value = JSON.parse(localStorage.getItem(templateKey) ?? '[]');
    if (!Array.isArray(value)) throw new Error('模板列表格式损坏，须为列表');
    templates = value;
  } catch (error) {
    templateReadError = error instanceof SyntaxError ? '模板记录不是有效 JSON' : `无法读取模板：${message(error)}`;
  }
  renderTemplates();
}

/** @param {string} reason */
function inputChanged(reason) {
  inputVersion++;
  cancelQuery(reason);
  saveSettings();
  saveTrade();
  renderDraft();
}

element('template-save').addEventListener('click', () => {
  if (templateReadError) return;
  try {
    const template = createStopTemplate(readInput(), templateReference());
    const label = templateLabel(template);
    const duplicate = templates.findIndex((value) => { try { return templateLabel(value) === label; } catch { return false; } });
    if (duplicate >= 0) { renderTemplates(String(duplicate)); show('template-status', `已有相同模板：${label}。`); return; }
    const next = [...templates, template];
    localStorage.setItem(templateKey, JSON.stringify(next));
    templates = next;
    renderTemplates(String(templates.length - 1));
    show('template-status', `已保存在当前浏览器：${label}。`);
  } catch (error) { show('template-status', `保存失败：${message(error)} 本次手动输入保留。`); }
});
field('stop-template').addEventListener('change', () => { renderTemplates(field('stop-template').value); show('template-status', '选择后点击“应用模板”才会修改本单。'); });
element('template-apply').addEventListener('click', () => {
  if (!field('stop-template').value || templateReadError) return;
  try {
    const input = applyStopTemplate(readInput(), templates[Number(field('stop-template').value)]);
    for (const [id, value] of Object.entries({ 'stop-levels': input.stopLevels, 'stop-mode': input.stopMode, stop: input.stop, 'near-stop-mode': input.nearStopMode, 'near-stop': input.nearStop, 'near-percent': input.nearPercent })) field(id).value = value;
    inputChanged('已应用止损模板');
    show('template-status', '模板已应用，预算、杠杆与资金上限保持不变；请检查试算及实际比例，再刷新生成开仓卡。');
    if (!snapshot && symbol.value) void load();
  } catch (error) { show('template-status', `无法应用：${message(error)} 本次手动输入保留。`); }
});
element('template-delete').addEventListener('click', () => {
  if (!field('stop-template').value && !templateReadError) return;
  try {
    const next = templates.filter((_, index) => index !== Number(field('stop-template').value));
    if (templateReadError) localStorage.removeItem(templateKey);
    else localStorage.setItem(templateKey, JSON.stringify(next));
    templates = templateReadError ? [] : next;
    templateReadError = '';
    renderTemplates();
    renderTemplatePreview();
    show('template-status', '模板记录已删除，本次表单保持不变。');
  } catch (error) { show('template-status', `删除失败：${message(error)}`); }
});

/** @param {string} reason */
function invalidateCard(reason) {
  invalidateVerification(reason);
  cardCurrent = false;
  if (!entryPlan) return;
  element('entry-card').dataset.current = 'false';
  show('card-status', `旧方案 · ${reason}；生成时间 ${time(entryPlan.queriedAt)}。原参数保留，复制已停用。`);
  for (const button of document.querySelectorAll('[data-copy]')) if (button instanceof HTMLButtonElement) button.disabled = true;
}

/** @param {string} reason */
function invalidateVerification(reason) {
  if (!entryPlan) return;
  element('verification').dataset.current = 'false';
  show('verification-status', `${entryPlan.source === 'demo' ? '模拟数据 · ' : ''}待核验 · ${reason}。原方案与上次时间保留。`);
  element('verification-details').hidden = true;
  element('verification-issues').replaceChildren();
  if (lastQueryAt) show('verification-time', `上次完整查询 ${time(lastQueryAt)}（已失效，需重新核验）。`);
  if (verify instanceof HTMLButtonElement) verify.disabled = JSON.stringify(readInput()) !== planInputs || generating;
}

/** @param {import('./draft.js').Snapshot['account']} account */
function renderAccount(account) {
  show('equity', account.equity);
  show('available', account.availableBalance);
  show('wallet', `${account.walletBalance} USDT`);
  show('pnl', `${account.unrealizedProfit} USDT`);
  show('queried', time(account.queriedAt));
  hasAccount = true;
}

/** @param {import('../src/verification.ts').Verification} result @param {import('../src/verification.ts').Plan} plan */
function renderVerification(result, plan) {
  lastQueryAt = result.queriedAt;
  show('card-status', `原方案 · 成交后状态已另行查询；生成时间 ${time(plan.queriedAt)}。原参数保留，开仓复制已停用。`);
  const states = { waiting: '待成交', ended: '已结束', incomplete: '无法完整核验', 'needs-action': '需处理', verified: '已核验 · 本次流程完成' };
  show('verification-status', `${result.source === 'demo' ? '模拟数据 · ' : ''}${states[result.status]}`);
  show('verification-time', `完整查询时间 ${time(result.queriedAt)}；只代表此时点。`);
  element('verification').dataset.current = result.status === 'verified' ? 'true' : 'false';
  const items = result.issues.map((issue) => { const li = document.createElement('li'); li.textContent = issue; return li; });
  element('verification-issues').replaceChildren(...items);
  /** @type {Record<string, string>} */
  const entryStates = { NEW: '挂单中', PARTIALLY_FILLED: '部分成交', FILLED: '全部成交', CANCELED: '已撤销余单', EXPIRED: '已失效', EXPIRED_IN_MATCH: '已失效', REJECTED: '已拒绝' };
  const outputs = {
    order: result.orderId ?? '尚未可靠关联', position: `${result.side === 'long' ? '做多' : result.side === 'short' ? '做空' : '空仓'} / ${result.quantity ?? '—'} ${plan.baseAsset}`,
    'entry-state': `${entryStates[result.entryStatus ?? ''] ?? (result.orderId ? '已关联' : '未确认')} / ${result.filledQuantity ?? '—'} ${plan.baseAsset}`,
    pending: result.pendingEntries ? result.pendingEntries.map((order) => `订单 ${order.orderId}：已成交 ${order.filledQuantity}，未成交 ${order.remainingQuantity} ${plan.baseAsset}`).join('；') || '本次查询未发现入场余单' : '未完整确认',
    entry: `${result.entryPrice ?? '—'} USDT`, leverage: `${result.leverage ?? '—'} / ${plan.leverage} 倍`,
    risk: `${result.plannedLoss ?? '未完整核算'} / ${plan.budget} USDT（原止损 ${plan.stopPrice}）`, excess: `${result.excess ?? '—'} USDT`,
    paid: `${result.paidCommission ?? '—'} / ${result.paidFunding ?? '—'} USDT`, reserved: `${result.remainingFunding ?? '—'} / ${result.exitFee ?? '—'} USDT`,
    liquidation: `${result.liquidationPrice ?? '—'} USDT`, buffer: `${result.liquidationBuffer ?? '—'}% / ${plan.minimumBuffer}%`, coverage: result.coverage ?? '未确认有效覆盖',
    near: `${result.nearStatus ?? '未确认'} / ${result.nearQuantity ?? '—'} ${plan.baseAsset}（按累计入场量分配的实际比例 ${result.nearActualPercent ?? '—'}%）`,
    realized: `${result.realizedPnl ?? '未完整核算'} USDT`,
  };
  element('verification-near-row').hidden = !plan.nearStop;
  for (const [id, value] of Object.entries(outputs)) show(`verification-${id}`, value);
  element('verification-details').hidden = false;
  if (result.account) renderAccount(result.account);
  saveTrade();
}

async function verifyCurrentPlan() {
  if (!entryPlan || generating || !(verify instanceof HTMLButtonElement) || !(refresh instanceof HTMLButtonElement) || !(generate instanceof HTMLButtonElement)) return;
  if (JSON.stringify(readInput()) !== planInputs) { invalidateVerification('输入已修改，请恢复原输入后核验此卡'); return; }
  let plan = entryPlan;
  const version = inputVersion, id = ++requestId;
  pending?.abort();
  pending = new AbortController();
  const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]);
  snapshot = null;
  invalidateCard('正在查询成交后的实际状态');
  renderDraft();
  verify.disabled = refresh.disabled = generate.disabled = true;
  show('status', '正在重新核验');
  show('message', '保留原方案与上次查询时间，等待本次完整数据。');
  if (statusBox) statusBox.dataset.state = 'loading';
  try {
    const scenario = plan.source === 'demo' ? `&demo=${encodeURIComponent(field('demo-scenario').value)}` : '';
    const restored = await read('/api/plan/recover', signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recovery: plan.recovery }) });
    if (id !== requestId || version !== inputVersion || entryPlan !== plan) return;
    if (restored.id !== plan.id || restored.source !== plan.source) throw new Error('恢复的方案或数据来源不一致，无法完整核验。');
    entryPlan = plan = /** @type {import('../src/server.ts').SavedPlan} */ (restored);
    planInputs = JSON.stringify(plan.input);
    const selectedScenario = field('demo-scenario').value;
    renderCard();
    field('demo-scenario').value = selectedScenario;
    invalidateCard('原方案已确认，正在重新查询');
    verify.disabled = true;
    if (JSON.stringify(readInput()) !== planInputs) throw new Error('输入与原方案不一致，请恢复原输入后核验。');
    await loadSymbols(signal, id);
    if (id !== requestId) return;
    const result = await read(`/api/verification?planId=${encodeURIComponent(plan.id)}${scenario}`, signal);
    if (id !== requestId || version !== inputVersion || entryPlan !== plan) return;
    if (result.source !== plan.source || !['waiting', 'ended', 'incomplete', 'needs-action', 'verified'].includes(result.status) || !Array.isArray(result.issues)
      || !Number.isFinite(Date.parse(result.queriedAt)) || result.account?.source !== plan.source || !Number.isFinite(Date.parse(result.account.queriedAt))
      || Math.abs(Date.parse(result.queriedAt) - Date.parse(result.account.queriedAt)) > 10_000) throw new Error('核验响应不完整或查询时间不一致，请重新查询。');
    renderVerification(result, plan);
    show('status', plan.source === 'demo' ? '模拟核验查询完成' : '实际仓位查询完成');
    show('message', '请查看下方成交后核验结果，开仓前估值保留在原卡。');
    show('attempted', time(result.queriedAt));
    if (statusBox) statusBox.dataset.state = result.status === 'verified' ? 'success' : 'error';
  } catch (error) {
    if (id !== requestId || version !== inputVersion) return;
    showLogin(error);
    invalidateVerification('本次查询失败，上次结果已失效');
    show('card-status', `原方案 · 本次核验查询失败；生成时间 ${time(plan.queriedAt)}。原参数保留，复制已停用。`);
    show('verification-status', `${plan.source === 'demo' ? '模拟数据 · ' : ''}无法完整核验 · ${message(error)}`);
    show('verification-time', `${lastQueryAt ? '上次完整查询 ' + time(lastQueryAt) + '（已过期）' : '尚无完整查询'}；本次尝试 ${time(new Date().toISOString())}。`);
    show('status', '需处理 · 本次核验查询失败');
    show('message', message(error));
    if (statusBox) statusBox.dataset.state = 'error';
  } finally {
    if (id === requestId) { pending = undefined; refresh.disabled = false; generate.disabled = !navigator.onLine; verify.disabled = JSON.stringify(readInput()) !== planInputs; }
  }
}

function renderDraft() {
  renderTemplatePreview();
  const limit = field('entry-type').value === 'LIMIT';
  const two = field('stop-levels').value === 'two';
  for (const row of document.querySelectorAll('[data-two-input]')) if (row instanceof HTMLElement) row.hidden = !two;
  for (const id of ['near-stop', 'near-stop-mode', 'near-percent']) field(id).disabled = !two;
  show('near-stop-unit', field('near-stop-mode').value === 'percent' ? '%' : 'USDT');
  try {
    const ratio = parseDecimal(field('near-percent').value.trim(), '近端比例');
    show('final-percent', ratio > 0n && ratio < 10_000_000_000n ? `${formatDecimal(10_000_000_000n - ratio)}%` : '—');
  } catch { show('final-percent', '—'); }
  element('limit-field').hidden = !limit;
  field('limit-price').disabled = !limit;
  field('limit-price').required = limit;
  element('draft-result').hidden = true;
  element('entry-checks').hidden = true;
  show('entry-error', '');
  show('budget-unit', field('budget-mode').value === 'percent' ? '%' : 'USDT');
  show('stop-unit', field('stop-mode').value === 'percent' ? '%' : 'USDT');
  if (!snapshot) {
    show('draft-error', entryPlan ? '原开仓方案保留在下方；成交后请使用“返回后刷新核验”。' : symbol.value ? '等待完整账户与行情快照，查询失败后请刷新。' : '选择币种并填写本次计划。');
    return;
  }
  try {
    const input = readInput();
    let plan = generateDraft(input, snapshot);
    try {
      const checked = generateEntryPlan(input, snapshot);
      plan = checked;
      show('preview-funding', `${checked.fundingRequired} / ${checked.fundingLimit} USDT`);
      show('preview-costs', `${checked.initialMargin} / ${checked.openLoss} / ${checked.openFeeReserve} USDT`);
      show('preview-liquidation', `${checked.liquidationPrice} USDT（假设逐仓本金 ${checked.isolatedWalletAssumption} USDT）`);
      show('preview-buffer', `${checked.liquidationBuffer}% / ${checked.minimumBuffer}%`);
      element('entry-checks').hidden = false;
    } catch (error) { show('entry-error', `需处理 · ${message(error)} 当前试算仅包含价格风险约束。`); }
    const outputs = {
      quantity: `${plan.quantity} ${snapshot.baseAsset}`, budget: `${plan.budget} USDT`, notional: `${plan.notional} USDT`,
      stop: `${plan.stopPrice} USDT / 约 ${plan.stopDistance}%`, distance: plan.nearStop ? `近端 ${plan.nearStop.quantity} ${snapshot.baseAsset} / ${plan.nearStop.actualPercent}%；最终剩余 ${plan.finalQuantity} / ${plan.finalPercent}%` : '全部仓位 / 100%', loss: `${plan.plannedLoss} USDT`,
      near: plan.nearStop ? `${plan.nearStop.price} USDT / 约 ${plan.nearStop.distance}%` : '—',
      reference: `${plan.referencePrice} USDT（${limit ? '用户委托价' : field('side').value === 'long' ? '卖一' : '买一'}）`, entry: `${plan.entryEstimate} USDT`, exit: `${plan.exitEstimate} USDT`,
      fees: `${plan.entryFee} / ${plan.exitFee} USDT`, slippage: `${plan.slippagePercent}%`, funding: plan.fundingReserved ? `${plan.funding} USDT` : '未预留资金费',
      condition: `标记价 ${field('side').value === 'long' ? '≤' : '≥'} ${plan.stopPrice} USDT 时触发最终止损市价，退出全部剩余仓位；触发价不等于成交价。${plan.nearStop ? '总仓位按全部落到最终止损计算，不依赖近端退出成功。' : ''}`,
      time: `${plan.source === 'demo' ? '模拟数据' : 'Binance 只读快照'} · ${time(plan.queriedAt)}；按此快照试算，行情变化后请刷新。`,
    };
    for (const [id, value] of Object.entries(outputs)) show(`draft-${id}`, value);
    element('draft-near-row').hidden = !plan.nearStop;
    show('draft-error', '');
    element('draft-result').hidden = false;
  } catch (error) { show('draft-error', message(error)); }
}

function renderCard() {
  if (!entryPlan) return;
  const plan = entryPlan;
  const limit = plan.execution.entryType === 'LIMIT';
  const outputs = {
    symbol: plan.symbol, direction: plan.side === 'long' ? '· 做多' : '· 做空', quantity: `${plan.quantity} ${plan.baseAsset}`,
    'entry-type': limit ? '普通限价入场 · GTC · 按 taker 费率预留' : '市价入场', limitPrice: plan.limitPrice,
    stopPrice: plan.stopPrice, exitMode: `${plan.exitMode} · 止损${plan.execution.stopSide === 'SELL' ? '卖出' : '买入'}，不填写固定退出数量`, leverage: `所选杠杆 ${plan.leverage} 倍`,
    'final-allocation': `实际距离约 ${plan.stopDistance}%${plan.nearStop ? `；近端成功退出后预计剩余 ${plan.finalQuantity} ${plan.baseAsset} / ${plan.finalPercent}%。最终单始终选择整仓退出。` : ''}`,
    nearPrice: plan.nearStop?.price ?? '—', nearQuantity: plan.nearStop ? `${plan.nearStop.quantity} ${plan.baseAsset}` : '—',
    'near-distance': plan.nearStop ? `实际距离约 ${plan.nearStop.distance}%；标记价触发、止损市价、关闭价格保护。` : '',
    'near-ratio': plan.nearStop ? `原输入 ${plan.nearStop.percent}%，取整后实际 ${plan.nearStop.actualPercent}%。` : '',
    budget: `${plan.budget} USDT`, notional: `${plan.notional} USDT`, loss: `${plan.plannedLoss} USDT`,
    funding: `${plan.fundingRequired} / ${plan.fundingLimit} USDT`, margin: `${plan.initialMargin} USDT`, 'open-costs': `${plan.openLoss} / ${plan.openFeeReserve} USDT`,
    liquidation: `${plan.liquidationPrice} USDT`, buffer: `${plan.liquidationBuffer}% / ${plan.minimumBuffer}%`,
    assuming: `${plan.assumingPrice} USDT`, estimates: `${plan.entryEstimate} / ${plan.exitEstimate} USDT`, fees: `${plan.entryFee} / ${plan.exitFee} USDT`,
    reserves: `${plan.slippagePercent}% / ${plan.fundingReserved ? plan.funding + ' USDT' : '未预留资金费'}`,
    wallet: `${plan.isolatedWalletAssumption} USDT`, tier: `${plan.liquidationTier} / ${plan.maintenanceRate}% / ${plan.maintenanceAmount} USDT`, limit: `${plan.notionalLimit} USDT`,
    'account-time': time(plan.accountTime), 'book-time': time(plan.bookTime), 'price-times': `${time(plan.markTime)} / ${time(plan.lastTime)}`, time: time(plan.queriedAt),
    instructions: `在 Binance 采用逐仓、单向持仓、${plan.leverage} 倍杠杆；${limit ? `普通限价（GTC，委托价 ${plan.limitPrice} USDT）` : '市价'}${plan.side === 'long' ? '买入做多' : '卖出做空'} ${plan.quantity} ${plan.baseAsset}。先附带并确认最终止损市价：绝对触发价 ${plan.stopPrice} USDT、标记价触发、关闭价格保护、整仓退出。${plan.nearStop ? `确认整仓保护有效后，再补近端 ${plan.nearStop.price} USDT、${plan.nearStop.quantity} ${plan.baseAsset} 的止损市价，只减仓、标记价触发、关闭价格保护；保留最终整仓保护。仅有最终单还未完成双层计划。` : ''}${limit ? '部分成交后先人工撤余单，再返回刷新核验；近端数量按实际累计入场量与原比例复算，止损执行不代表余单已撤。' : '请确认这些设置后手动执行。'}`,
    'funding-model': `${limit ? '限价多头保证金按委托价；空头按最新成交价 × 1.0015、标记价、委托价中的较大值。开仓浮亏按委托价与标记价的不利差计算。' : '市价下单资金估值采用最新成交价 × 1.0015。'}费用按下单估值与不利成交估值中的较大名义价值预留。名义价值上限同时约束标记价、下单估值和不利成交估值。`,
  };
  for (const [id, value] of Object.entries(outputs)) show(`card-${id}`, value);
  element('card-limit-row').hidden = !limit;
  element('card-near').hidden = !plan.nearStop;
  for (const option of document.querySelectorAll('[data-limit-only]')) if (option instanceof HTMLOptionElement) option.disabled = option.hidden = !limit;
  for (const option of document.querySelectorAll('[data-two-only]')) if (option instanceof HTMLOptionElement) option.disabled = option.hidden = !plan.nearStop;
  field('demo-scenario').value = limit ? 'waiting' : 'missing-stop';
  show('card-title', plan.source === 'demo' ? '模拟开仓卡 · 不可用于真实交易' : '本次开仓卡');
  show('card-status', `${plan.notice} 数据截至 ${time(plan.queriedAt)}。`);
  show('copy-status', '数量和价格仅复制数值，请核对上方单位。');
  cardCurrent = true;
  element('entry-card').dataset.current = 'true';
  element('entry-card').hidden = false;
  element('verification').hidden = false;
  element('demo-verification').hidden = plan.source !== 'demo';
  element('verification-details').hidden = true;
  element('verification-issues').replaceChildren();
  show('verification-start', `本单空仓起点 ${time(plan.startedAt)} · ${plan.symbol} · 原预算 ${plan.budget} USDT · 原最终止损 ${plan.stopPrice} USDT${plan.nearStop ? ` · 原近端止损 ${plan.nearStop.price} USDT` : ''}`);
  show('verification-status', '待核验 · 在 Binance 手动执行后，返回此处刷新。');
  show('verification-time', '尚无完整查询');
  show('refresh', '刷新账户与核验原方案');
  element('draft-result').hidden = true;
  element('entry-checks').hidden = true;
  for (const button of document.querySelectorAll('[data-copy]')) if (button instanceof HTMLButtonElement) button.disabled = false;
}

async function generateCard() {
  if (!(generate instanceof HTMLButtonElement) || generating) return;
  const input = readInput(), version = inputVersion;
  const id = ++requestId;
  pending?.abort();
  pending = new AbortController();
  generating = true;
  generate.disabled = true;
  invalidateCard('正在重新生成方案');
  if (refresh instanceof HTMLButtonElement) refresh.disabled = true;
  snapshot = null;
  renderDraft();
  try {
    const plan = await read('/api/plan', AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (id !== requestId) return;
    if (version !== inputVersion) throw new Error('查询期间输入已变化，请重新生成开仓卡。');
    entryPlan = /** @type {import('../src/server.ts').SavedPlan} */ (plan);
    planInputs = JSON.stringify(input);
    lastQueryAt = '';
    renderAccount(plan.account);
    renderCard();
    saveTrade();
    renderTemplatePreview();
    show('draft-error', '');
    show('status', plan.source === 'demo' ? '模拟方案已生成' : '正式方案已生成 · 待执行与核验');
    show('message', '本单预算与止损已固定；到 Binance 手动执行后，返回刷新核验。');
    show('attempted', time(plan.queriedAt));
    if (statusBox) statusBox.dataset.state = 'success';
    element('entry-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    show('entry-error', '');
  } catch (error) {
    if (id === requestId) {
      showLogin(error);
      show('entry-error', `需处理 · ${message(error)}`);
      show('status', '需处理 · 本次方案未生成');
      show('message', message(error));
      if (statusBox) statusBox.dataset.state = 'error';
    }
  }
  finally {
    if (id === requestId) {
      pending = undefined;
      generating = false;
      generate.disabled = !navigator.onLine;
      if (refresh instanceof HTMLButtonElement) refresh.disabled = false;
      if (verify instanceof HTMLButtonElement) verify.disabled = !entryPlan || JSON.stringify(readInput()) !== planInputs;
    }
  }
}

/** @param {string} path @param {AbortSignal} signal @param {RequestInit} [options] */
async function read(path, signal, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', signal });
  if (response.status === 401) throw new LoginRequired('登录已过期，请重新登录后继续本单。');
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '查询失败，请重试。');
  return data;
}

/** @param {AbortSignal} signal @param {number} id */
async function loadSymbols(signal, id) {
  if (symbolsLoaded || !(symbol instanceof HTMLSelectElement)) return;
  const data = await read('/api/symbols', signal);
  if (id !== requestId) return;
  if (!Array.isArray(data.symbols) || !data.symbols.every((/** @type {unknown} */ value) => typeof value === 'string')) throw new Error('币种列表无效。');
  for (const value of data.symbols) if (!Array.from(symbol.options).some((option) => option.value === value)) symbol.add(new Option(value, value));
  symbolsLoaded = true;
}

async function load() {
  if (!(refresh instanceof HTMLButtonElement) || !(symbol instanceof HTMLSelectElement) || !statusBox) return;
  const id = ++requestId;
  pending?.abort();
  pending = new AbortController();
  const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]);
  snapshot = null;
  invalidateCard('数据正在刷新，原卡不代表当前状态');
  element('market-details').hidden = true;
  show('fee', '等待账户查询');
  renderDraft();
  refresh.disabled = true;
  if (generate instanceof HTMLButtonElement) generate.disabled = true;
  statusBox.dataset.state = 'loading';
  show('status', '正在查询');
  show('message', hasAccount ? '保留上次账户快照，正在读取本次数据…' : '正在读取账户与合约数据…');
  try {
    await loadSymbols(signal, id);
    if (id !== requestId) return;
    const selected = symbol.value;
    const data = await read(selected ? `/api/market?symbol=${encodeURIComponent(selected)}` : '/api/account', signal);
    if (id !== requestId || symbol.value !== selected) return;
    const account = selected ? data.account : data;
    renderAccount(account);
    show('attempted', time(data.queriedAt));
    show('source', data.source === 'demo' ? '模拟数据 · 仅用于界面与流程验证' : '真实模式 · 数据由 Binance 只读接口查询');
    show('status', data.source === 'demo' ? '模拟查询成功' : '已连接 · 只读查询成功');
    show('message', selected ? '当前快照符合空仓、逐仓与单向持仓条件；正式生成前还会刷新并检查资金与强平缓冲。' : '选择币种后读取适用费率、行情和开仓前账户条件。');
    statusBox.dataset.state = 'success';
    hasAccount = true;
    if (selected) {
      snapshot = /** @type {import('./draft.js').Snapshot} */ (data);
      show('fee', `${formatDecimal(parseDecimal(snapshot.takerRate, '账户费率') * 100n)}% · ${snapshot.source === 'demo' ? '模拟费率' : 'Binance 账户读取'}`);
      show('market-book', `${snapshot.bid} / ${snapshot.ask} USDT`);
      show('market-mark', `${snapshot.mark} USDT`);
      show('market-steps', `${snapshot.rules.tickSize} USDT / ${snapshot.rules.stepSize} ${snapshot.baseAsset}`);
      show('market-quantity', `${snapshot.rules.minQty}–${snapshot.rules.maxQty} ${snapshot.baseAsset}`);
      show('market-limit-quantity', `${snapshot.rules.lotSize.minQty}–${snapshot.rules.lotSize.maxQty} / ${snapshot.rules.lotSize.stepSize} ${snapshot.baseAsset}`);
      show('market-minimum', `${snapshot.rules.minNotional} USDT（市价按标记价，限价按委托价）`);
      show('market-book-time', time(snapshot.bookTime));
      show('market-mark-time', time(snapshot.markTime));
      show('market-time', time(snapshot.queriedAt));
      show('market-last', `${snapshot.last} USDT / ${time(snapshot.lastTime)}`);
      show('market-brackets', snapshot.brackets.map((tier) => `${tier.floor}–${tier.cap} USDT：最高 ${tier.maxLeverage} 倍`).join('；'));
      show('leverage-help', `此账户该币种最高 ${Math.max(...snapshot.brackets.map((tier) => tier.maxLeverage))} 倍；实际名义价值还受各档位约束。`);
      element('market-details').hidden = false;
    }
    renderDraft();
    invalidateCard('已读取新快照；原卡未重新生成');
    return snapshot;
  } catch (error) {
    if (id !== requestId) return;
    showLogin(error);
    snapshot = null;
    renderDraft();
    show('status', hasAccount ? '需处理 · 下方账户快照已过期' : '需处理 · 查询未成功');
    show('message', message(error));
    show('draft-error', message(error));
    show('entry-error', '关键数据查询失败，暂停生成新开仓卡。');
    invalidateCard('数据已过期，关键查询失败');
    show('attempted', time(new Date().toISOString()));
    statusBox.dataset.state = 'error';
  } finally {
    if (id === requestId) {
      pending = undefined;
      refresh.disabled = false;
      if (generate instanceof HTMLButtonElement) generate.disabled = generating || !navigator.onLine;
    }
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); renderDraft(); });
form.addEventListener('input', (event) => { if (event.target !== field('stop-template')) inputChanged('输入已修改'); });
symbol.addEventListener('change', () => {
  if (field('stop-mode').value === 'price') field('stop').value = '';
  if (field('near-stop-mode').value === 'price') field('near-stop').value = '';
  field('limit-price').value = '';
  saveSettings();
  saveTrade();
  void load();
});
refresh.addEventListener('click', () => { void (entryPlan && JSON.stringify(readInput()) === planInputs ? verifyCurrentPlan() : load()); });
generate.addEventListener('click', () => { void generateCard(); });
verify.addEventListener('click', () => { void verifyCurrentPlan(); });
field('demo-scenario').addEventListener('change', () => { inputVersion++; cancelQuery('模拟场景已变化，请刷新'); saveTrade(); });
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', async () => {
  if (!(button instanceof HTMLButtonElement) || !entryPlan || !cardCurrent) return;
  const values = { quantity: entryPlan.quantity, limitPrice: entryPlan.limitPrice, stopPrice: entryPlan.stopPrice, nearPrice: entryPlan.nearStop?.price ?? '', nearQuantity: entryPlan.nearStop?.quantity ?? '', leverage: entryPlan.leverage, exitMode: entryPlan.exitMode };
  const key = button.dataset.copy;
  if (key !== 'quantity' && key !== 'limitPrice' && key !== 'stopPrice' && key !== 'nearPrice' && key !== 'nearQuantity' && key !== 'leverage' && key !== 'exitMode') return;
  try {
    await navigator.clipboard.writeText(values[key]);
    show('copy-status', `已复制：${values[key]}${key === 'quantity' || key === 'nearQuantity' ? '（单位 ' + entryPlan.baseAsset + '）' : key === 'stopPrice' || key === 'nearPrice' || key === 'limitPrice' ? '（USDT 绝对价格）' : ''}`);
  } catch { show('copy-status', '浏览器无法复制，请长按卡片中的参数手动复制。'); }
});
function resume() {
  if (document.hidden || pending) return;
  if (!navigator.onLine) { suspend('网络已断开，请联网后重试'); return; }
  void (entryPlan && JSON.stringify(readInput()) === planInputs ? verifyCurrentPlan() : load());
}

/** @param {string} reason */
function suspend(reason) {
  snapshot = null;
  cancelQuery(reason);
  saveTrade();
  renderDraft();
  show('status', entryPlan ? '待核验 · 原查询已失效' : '草稿 · 等待重新查询');
  show('message', reason);
  if (statusBox) statusBox.dataset.state = 'error';
}

document.addEventListener('visibilitychange', () => { if (document.hidden) suspend('页面已离开；返回后重新查询，离开期间不监控'); else resume(); });
window.addEventListener('pagehide', () => { suspend('页面已关闭或离开；重新打开后查询'); });
window.addEventListener('pageshow', (event) => { if (event.persisted) { suspend('已返回页面；原查询已失效'); resume(); } });
window.addEventListener('offline', () => { suspend('网络已断开，请联网后重试'); });
window.addEventListener('online', resume);
element('restore-inputs').addEventListener('click', () => {
  if (!entryPlan) return;
  const controls = /** @type {HTMLFormElement} */ (form).elements;
  for (const [key, value] of Object.entries(entryPlan.input)) {
    const control = controls.namedItem(key);
    if (control instanceof HTMLInputElement || (control instanceof HTMLSelectElement && Array.from(control.options).some((option) => option.value === value))) control.value = value;
  }
  inputChanged('已恢复原方案输入，请重新核验');
  resume();
});
element('clear-trade').addEventListener('click', () => {
  if (!confirm('清除本单记录并开始新一单？不会改变 Binance 仓位或挂单；原计划将无法从当前浏览器恢复。')) return;
  try { localStorage.removeItem(tradeKey); }
  catch { show('recovery-status', '清除失败，本单记录保留。'); return; }
  cancelQuery('已清除本单');
  entryPlan = null;
  planInputs = lastQueryAt = tradeReadError = '';
  element('entry-card').hidden = element('verification').hidden = true;
  for (const id of ['stop', 'near-stop', 'limit-price', 'funding-cap']) field(id).value = '';
  show('refresh', '刷新账户与行情');
  show('recovery-status', '已清除本单记录；新方案仍须确认空仓起点。');
  void load();
});
restoreTrade();
const costs = element('cost-settings');
if (costs instanceof HTMLDetailsElement) costs.open = !field('slippage').value || !field('minimum-buffer').value;
loadTemplates();
renderDraft();
resume();
