import { generateDraft, generateEntryPlan, formatDecimal, parseDecimal } from './draft.js';

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
const settingIds = ['symbol', 'side', 'budget-mode', 'budget', 'stop-mode', 'slippage', 'funding', 'leverage', 'minimum-buffer'];
const storageKey = 'entry-guidance.preferences.v1';
let hasAccount = false;
let requestId = 0;
/** @type {AbortController | undefined} */
let pending;
/** @type {import('./draft.js').Snapshot | null} */
let snapshot = null;
/** @type {import('../src/verification.ts').Plan | null} */
let entryPlan = null;
let planInputs = '';
/** @type {import('../src/verification.ts').Verification | null} */
let verification = null;
let cardCurrent = false;
let inputVersion = 0;
let generating = false;

/** @param {string} value */
const time = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });
/** @param {string} id @param {string} value */
const show = (id, value) => { element(id).textContent = value; };
/** @param {unknown} error */
const message = (error) => error instanceof Error && !['TimeoutError', 'TypeError', 'AbortError'].includes(error.name) ? error.message : '网络中断或查询超时，请稍后重试。';

function saveSettings() {
  try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(settingIds.map((id) => [id, field(id).value])))); }
  catch { show('save-status', '浏览器无法保存设置，本次输入仍可使用。'); }
}

function readInput() {
  return { symbol: symbol.value, side: field('side').value, budgetMode: field('budget-mode').value, budget: field('budget').value.trim(), stopMode: field('stop-mode').value, stop: field('stop').value.trim(), slippage: field('slippage').value.trim(), funding: field('funding').value.trim(), leverage: field('leverage').value.trim(), minimumBuffer: field('minimum-buffer').value.trim(), fundingCap: field('funding-cap').value.trim() };
}

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
  show('verification-status', `待核验 · ${reason}。原方案与上次时间保留。`);
  if (verification) show('verification-time', `上次完整查询 ${time(verification.queriedAt)}（已失效，需重新核验）。`);
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
  verification = result;
  show('card-status', `原方案 · 成交后状态已另行查询；生成时间 ${time(plan.queriedAt)}。原参数保留，开仓复制已停用。`);
  const states = { waiting: '待成交', ended: '已结束', incomplete: '无法完整核验', 'needs-action': '需处理', verified: '已核验 · 本次流程完成' };
  show('verification-status', `${result.source === 'demo' ? '模拟数据 · ' : ''}${states[result.status]}`);
  show('verification-time', `完整查询时间 ${time(result.queriedAt)}；只代表此时点。`);
  element('verification').dataset.current = result.status === 'verified' ? 'true' : 'false';
  const items = result.issues.map((issue) => { const li = document.createElement('li'); li.textContent = issue; return li; });
  element('verification-issues').replaceChildren(...items);
  const outputs = {
    order: result.orderId ?? '尚未可靠关联', position: `${result.side === 'long' ? '做多' : result.side === 'short' ? '做空' : '空仓'} / ${result.quantity ?? '—'} ${plan.baseAsset}`,
    entry: `${result.entryPrice ?? '—'} USDT`, leverage: `${result.leverage ?? '—'} / ${plan.leverage} 倍`,
    risk: `${result.plannedLoss ?? '未完整核算'} / ${plan.budget} USDT（原止损 ${plan.stopPrice}）`, excess: `${result.excess ?? '—'} USDT`,
    paid: `${result.paidCommission ?? '—'} / ${result.paidFunding ?? '—'} USDT`, reserved: `${result.remainingFunding ?? '—'} / ${result.exitFee ?? '—'} USDT`,
    liquidation: `${result.liquidationPrice ?? '—'} USDT`, buffer: `${result.liquidationBuffer ?? '—'}% / ${plan.minimumBuffer}%`, coverage: result.coverage ?? '未确认有效覆盖',
  };
  for (const [id, value] of Object.entries(outputs)) show(`verification-${id}`, value);
  element('verification-details').hidden = false;
  if (result.account) renderAccount(result.account);
}

async function verifyCurrentPlan() {
  if (!entryPlan || generating || !(verify instanceof HTMLButtonElement) || !(refresh instanceof HTMLButtonElement) || !(generate instanceof HTMLButtonElement)) return;
  if (JSON.stringify(readInput()) !== planInputs) { invalidateVerification('输入已修改，请恢复原输入后核验此卡'); return; }
  const plan = entryPlan, version = inputVersion, id = ++requestId;
  pending?.abort();
  pending = new AbortController();
  const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]);
  snapshot = null;
  invalidateCard('正在查询成交后的实际状态');
  renderDraft();
  verify.disabled = refresh.disabled = generate.disabled = true;
  try {
    const scenario = plan.source === 'demo' ? `&demo=${encodeURIComponent(field('demo-scenario').value)}` : '';
    const result = await read(`/api/verification?planId=${encodeURIComponent(plan.id)}${scenario}`, signal);
    if (id !== requestId || version !== inputVersion || entryPlan !== plan) return;
    if (result.source !== plan.source || !['waiting', 'ended', 'incomplete', 'needs-action', 'verified'].includes(result.status) || !Array.isArray(result.issues)) throw new Error('核验响应不完整，请重新查询。');
    renderVerification(result, plan);
    show('status', plan.source === 'demo' ? '模拟核验查询完成' : '实际仓位查询完成');
    show('message', '请查看下方成交后核验结果，开仓前估值保留在原卡。');
    show('attempted', time(result.queriedAt));
    if (statusBox) statusBox.dataset.state = result.status === 'verified' ? 'success' : 'error';
  } catch (error) {
    if (id !== requestId || version !== inputVersion) return;
    invalidateVerification('本次查询失败，上次结果已失效');
    show('card-status', `原方案 · 本次核验查询失败；生成时间 ${time(plan.queriedAt)}。原参数保留，复制已停用。`);
    show('verification-status', `无法完整核验 · ${message(error)}`);
    show('verification-time', `${verification ? '上次完整查询 ' + time(verification.queriedAt) + '（已过期）' : '尚无完整查询'}；本次尝试 ${time(new Date().toISOString())}。`);
    show('status', '需处理 · 本次核验查询失败');
    show('message', message(error));
    if (statusBox) statusBox.dataset.state = 'error';
  } finally {
    if (id === requestId) { refresh.disabled = generate.disabled = false; verify.disabled = JSON.stringify(readInput()) !== planInputs; }
  }
}

function renderDraft() {
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
      stop: `${plan.stopPrice} USDT`, distance: `约 ${plan.stopDistance}%`, loss: `${plan.plannedLoss} USDT`,
      reference: `${plan.referencePrice} USDT（${field('side').value === 'long' ? '卖一' : '买一'}）`, entry: `${plan.entryEstimate} USDT`, exit: `${plan.exitEstimate} USDT`,
      fees: `${plan.entryFee} / ${plan.exitFee} USDT`, slippage: `${plan.slippagePercent}%`, funding: plan.fundingReserved ? `${plan.funding} USDT` : '未预留资金费',
      condition: `标记价 ${field('side').value === 'long' ? '≤' : '≥'} ${plan.stopPrice} USDT 时触发止损市价，退出全部仓位；触发价不等于成交价。`,
      time: `${plan.source === 'demo' ? '模拟数据' : 'Binance 只读快照'} · ${time(plan.queriedAt)}；按此快照试算，行情变化后请刷新。`,
    };
    for (const [id, value] of Object.entries(outputs)) show(`draft-${id}`, value);
    show('draft-error', '');
    element('draft-result').hidden = false;
  } catch (error) { show('draft-error', message(error)); }
}

function renderCard() {
  if (!entryPlan) return;
  const plan = entryPlan;
  const outputs = {
    symbol: plan.symbol, direction: plan.side === 'long' ? '· 做多' : '· 做空', quantity: `${plan.quantity} ${plan.baseAsset}`,
    stopPrice: plan.stopPrice, exitMode: `${plan.exitMode} · 止损${plan.execution.stopSide === 'SELL' ? '卖出' : '买入'}，不填写固定退出数量`, leverage: `所选杠杆 ${plan.leverage} 倍`,
    budget: `${plan.budget} USDT`, notional: `${plan.notional} USDT`, loss: `${plan.plannedLoss} USDT`,
    funding: `${plan.fundingRequired} / ${plan.fundingLimit} USDT`, margin: `${plan.initialMargin} USDT`, 'open-costs': `${plan.openLoss} / ${plan.openFeeReserve} USDT`,
    liquidation: `${plan.liquidationPrice} USDT`, buffer: `${plan.liquidationBuffer}% / ${plan.minimumBuffer}%`,
    assuming: `${plan.assumingPrice} USDT`, estimates: `${plan.entryEstimate} / ${plan.exitEstimate} USDT`, fees: `${plan.entryFee} / ${plan.exitFee} USDT`,
    reserves: `${plan.slippagePercent}% / ${plan.fundingReserved ? plan.funding + ' USDT' : '未预留资金费'}`,
    wallet: `${plan.isolatedWalletAssumption} USDT`, tier: `${plan.liquidationTier} / ${plan.maintenanceRate}% / ${plan.maintenanceAmount} USDT`, limit: `${plan.notionalLimit} USDT`,
    'account-time': time(plan.accountTime), 'book-time': time(plan.bookTime), 'price-times': `${time(plan.markTime)} / ${time(plan.lastTime)}`, time: time(plan.queriedAt),
    instructions: `在 Binance 采用逐仓、单向持仓、${plan.leverage} 倍杠杆；市价${plan.side === 'long' ? '买入做多' : '卖出做空'} ${plan.quantity} ${plan.baseAsset}。附带止损市价：绝对触发价 ${plan.stopPrice} USDT、标记价触发、关闭价格保护、整仓退出。请确认这些设置后手动执行。`,
  };
  for (const [id, value] of Object.entries(outputs)) show(`card-${id}`, value);
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
  show('verification-start', `本单空仓起点 ${time(plan.startedAt)} · ${plan.symbol} · 原预算 ${plan.budget} USDT · 原止损 ${plan.stopPrice} USDT`);
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
    entryPlan = /** @type {import('../src/verification.ts').Plan} */ (plan);
    planInputs = JSON.stringify(input);
    verification = null;
    renderAccount(plan.account);
    renderCard();
    show('draft-error', '');
    show('status', plan.source === 'demo' ? '模拟方案已生成' : '正式方案已生成 · 待执行与核验');
    show('message', '本单预算与止损已固定；到 Binance 手动执行后，返回刷新核验。');
    show('attempted', time(plan.queriedAt));
    if (statusBox) statusBox.dataset.state = 'success';
    element('entry-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    show('entry-error', '');
  } catch (error) {
    if (id === requestId) {
      show('entry-error', `需处理 · ${message(error)}`);
      show('status', '需处理 · 本次方案未生成');
      show('message', message(error));
      if (statusBox) statusBox.dataset.state = 'error';
    }
  }
  finally {
    generating = false;
    if (id === requestId) {
      generate.disabled = false;
      if (refresh instanceof HTMLButtonElement) refresh.disabled = false;
      if (verify instanceof HTMLButtonElement) verify.disabled = !entryPlan || JSON.stringify(readInput()) !== planInputs;
    }
  }
}

/** @param {string} path @param {AbortSignal} signal @param {RequestInit} [options] */
async function read(path, signal, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', signal });
  if (response.status === 401) { location.replace('/login'); throw new Error('登录已过期，请重新登录。'); }
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '查询失败，请重试。');
  return data;
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
    if (symbol.options.length === 1) {
      const data = await read('/api/symbols', signal);
      if (id !== requestId) return;
      if (!Array.isArray(data.symbols) || !data.symbols.every((/** @type {unknown} */ value) => typeof value === 'string')) throw new Error('币种列表无效。');
      for (const value of data.symbols) symbol.add(new Option(value, value));
      try {
        const settings = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
        if (settings && typeof settings === 'object') {
          for (const setting of settingIds) if (typeof settings[setting] === 'string' && settings[setting].length <= 34) field(setting).value = settings[setting];
        }
      } catch { show('save-status', '无法读取保存的设置，请填写本次参数。'); }
      const costs = element('cost-settings');
      if (costs instanceof HTMLDetailsElement) costs.open = !field('slippage').value || !field('minimum-buffer').value;
    }
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
      show('market-minimum', `${snapshot.rules.minNotional} USDT（按标记价）`);
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
      refresh.disabled = false;
      if (generate instanceof HTMLButtonElement) generate.disabled = generating;
    }
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); renderDraft(); });
form.addEventListener('input', () => { inputVersion++; invalidateCard('输入已修改'); saveSettings(); renderDraft(); });
symbol.addEventListener('change', () => {
  if (field('stop-mode').value === 'price') field('stop').value = '';
  saveSettings();
  void load();
});
refresh.addEventListener('click', () => { void (entryPlan && JSON.stringify(readInput()) === planInputs ? verifyCurrentPlan() : load()); });
generate.addEventListener('click', () => { void generateCard(); });
verify.addEventListener('click', () => { void verifyCurrentPlan(); });
field('demo-scenario').addEventListener('change', () => { inputVersion++; invalidateVerification('模拟场景已变化，请刷新'); });
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', async () => {
  if (!(button instanceof HTMLButtonElement) || !entryPlan || !cardCurrent) return;
  const values = { quantity: entryPlan.quantity, stopPrice: entryPlan.stopPrice, leverage: entryPlan.leverage, exitMode: entryPlan.exitMode };
  const key = button.dataset.copy;
  if (key !== 'quantity' && key !== 'stopPrice' && key !== 'leverage' && key !== 'exitMode') return;
  try {
    await navigator.clipboard.writeText(values[key]);
    show('copy-status', `已复制：${values[key]}${key === 'quantity' ? '（单位 ' + entryPlan.baseAsset + '）' : key === 'stopPrice' ? '（USDT 绝对价格）' : ''}`);
  } catch { show('copy-status', '浏览器无法复制，请长按卡片中的参数手动复制。'); }
});
void load();
