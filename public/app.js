/** @param {string} id */
function element(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error('页面元素缺失');
  return el;
}
const refresh = element('refresh');
if (!(refresh instanceof HTMLButtonElement)) throw new Error('刷新按钮缺失');
const statusBox = element('status').closest('section');
let hasSnapshot = false;

/** @param {string} value */
const time = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });

async function loadAccount() {
  if (!(refresh instanceof HTMLButtonElement) || !statusBox) return;
  refresh.disabled = true;
  statusBox.dataset.state = 'loading';
  element('status').textContent = '正在查询';
  element('message').textContent = hasSnapshot ? '下方保留上次快照，等待本次查询完成。' : '正在读取账户状态…';
  try {
    const response = await fetch('/api/account', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (response.status === 401) { location.replace('/login'); return; }
    const data = await response.json();
    element('attempted').textContent = time(data.attemptedAt ?? data.queriedAt ?? new Date().toISOString());
    if (!response.ok) throw new Error(data.error ?? '账户查询失败。');
    element('equity').textContent = data.equity;
    element('available').textContent = data.availableBalance;
    element('wallet').textContent = `${data.walletBalance} USDT`;
    element('pnl').textContent = `${data.unrealizedProfit} USDT`;
    element('queried').textContent = time(data.queriedAt);
    element('source').textContent = data.source === 'demo' ? '模拟数据 · 仅用于界面与流程验证' : '真实模式 · 数据由 Binance 只读接口查询';
    element('status').textContent = data.source === 'demo' ? '模拟查询成功' : '已连接 · 只读查询成功';
    element('message').textContent = '这是查询时点的快照；余额变化后请再次刷新。';
    statusBox.dataset.state = 'success';
    hasSnapshot = true;
  } catch (error) {
    element('status').textContent = hasSnapshot ? '查询失败 · 下方快照已过期' : '未连接 · 查询未成功';
    element('message').textContent = error instanceof Error && error.name !== 'TimeoutError' && error.name !== 'TypeError' ? error.message : '网络中断或查询超时，请稍后重试。';
    element('attempted').textContent = time(new Date().toISOString());
    statusBox.dataset.state = 'error';
  } finally {
    refresh.disabled = false;
  }
}
refresh.addEventListener('click', () => { void loadAccount(); });
void loadAccount();
