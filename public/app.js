import { generateDraft, formatDecimal, parseDecimal } from './draft.js';

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
const statusBox = element('status').closest('section');
const form = element('draft-form');
const symbol = field('symbol');
const settingIds = ['symbol', 'side', 'budget-mode', 'budget', 'stop-mode', 'slippage', 'funding'];
const storageKey = 'entry-guidance.preferences.v1';
let hasAccount = false;
let requestId = 0;
/** @type {AbortController | undefined} */
let pending;
/** @type {import('./draft.js').Snapshot | null} */
let snapshot = null;

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

function renderDraft() {
  element('draft-result').hidden = true;
  show('budget-unit', field('budget-mode').value === 'percent' ? '%' : 'USDT');
  show('stop-unit', field('stop-mode').value === 'percent' ? '%' : 'USDT');
  if (!snapshot) {
    show('draft-error', symbol.value ? '等待完整账户与行情快照，查询失败后请刷新。' : '选择币种并填写本次计划。');
    return;
  }
  try {
    const plan = generateDraft({ symbol: symbol.value, side: field('side').value, budgetMode: field('budget-mode').value, budget: field('budget').value.trim(), stopMode: field('stop-mode').value, stop: field('stop').value.trim(), slippage: field('slippage').value.trim(), funding: field('funding').value.trim() }, snapshot);
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

/** @param {string} path @param {AbortSignal} signal */
async function read(path, signal) {
  const response = await fetch(path, { cache: 'no-store', signal });
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
  element('market-details').hidden = true;
  show('fee', '等待账户查询');
  renderDraft();
  refresh.disabled = true;
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
      if (costs instanceof HTMLDetailsElement) costs.open = !field('slippage').value;
    }
    const selected = symbol.value;
    const data = await read(selected ? `/api/market?symbol=${encodeURIComponent(selected)}` : '/api/account', signal);
    if (id !== requestId || symbol.value !== selected) return;
    const account = selected ? data.account : data;
    show('equity', account.equity);
    show('available', account.availableBalance);
    show('wallet', `${account.walletBalance} USDT`);
    show('pnl', `${account.unrealizedProfit} USDT`);
    show('queried', time(account.queriedAt));
    show('attempted', time(data.queriedAt));
    show('source', data.source === 'demo' ? '模拟数据 · 仅用于界面与流程验证' : '真实模式 · 数据由 Binance 只读接口查询');
    show('status', data.source === 'demo' ? '模拟查询成功' : '已连接 · 只读查询成功');
    show('message', selected ? '当前快照符合空仓、逐仓与单向持仓条件；试算仍需后续资金和强平检查。' : '选择币种后读取适用费率、行情和开仓前账户条件。');
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
      element('market-details').hidden = false;
    }
    renderDraft();
  } catch (error) {
    if (id !== requestId) return;
    snapshot = null;
    renderDraft();
    show('status', hasAccount ? '需处理 · 下方账户快照已过期' : '需处理 · 查询未成功');
    show('message', message(error));
    show('draft-error', message(error));
    show('attempted', time(new Date().toISOString()));
    statusBox.dataset.state = 'error';
  } finally { if (id === requestId) refresh.disabled = false; }
}

form.addEventListener('submit', (event) => { event.preventDefault(); renderDraft(); });
form.addEventListener('input', () => { saveSettings(); renderDraft(); });
symbol.addEventListener('change', () => {
  if (field('stop-mode').value === 'price') field('stop').value = '';
  saveSettings();
  void load();
});
refresh.addEventListener('click', () => { void load(); });
void load();
