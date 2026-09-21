/** @typedef {{symbol: string, side: string, budgetMode: string, budget: string, stopMode: string, stop: string, slippage: string, funding: string}} DraftInput */
/** @typedef {{minPrice: string, maxPrice: string, tickSize: string, minQty: string, maxQty: string, stepSize: string, minNotional: string}} Rules */
/** @typedef {{source: 'binance'|'demo', queriedAt: string, symbol: string, baseAsset: string, bid: string, ask: string, mark: string, bookTime: string, markTime: string, takerRate: string, rules: Rules, account: {equity: string, availableBalance: string, walletBalance: string, unrealizedProfit: string, queriedAt: string}}} Snapshot */

const SCALE = 100_000_000n;
const PERCENT = 100n * SCALE;

/** @param {unknown} value @param {string} label */
export function parseDecimal(value, label) {
  if (typeof value !== 'string' || !/^\d{1,24}(\.\d{1,8})?$/.test(value)) throw new Error(`${label}须为非负十进制数，最多 8 位小数。`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(8, '0')}`);
}

/** @param {bigint} value @param {number} places */
export function formatDecimal(value, places = 8) {
  const digits = value.toString().padStart(places + 1, '0');
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, '') || '0';
}

/** @param {DraftInput} input @param {Snapshot} snapshot */
export function generateDraft(input, snapshot) {
  if (input.symbol !== snapshot.symbol) throw new Error('币种已变化，请刷新行情。');
  if (!['long', 'short'].includes(input.side)) throw new Error('请选择做多或做空方向。');
  if (!['amount', 'percent'].includes(input.budgetMode)) throw new Error('预算方式无效。');
  if (!['price', 'percent'].includes(input.stopMode)) throw new Error('止损方式无效。');
  const direction = input.side === 'long' ? 1n : -1n;
  const entry = parseDecimal(input.side === 'long' ? snapshot.ask : snapshot.bid, '入场参考价');
  const mark = parseDecimal(snapshot.mark, '标记价');
  if (entry <= 0n || mark <= 0n) throw new Error('行情价格须为正数，请刷新。');
  const stopInput = parseDecimal(input.stop, '止损');
  if (stopInput <= 0n) throw new Error('止损须为正数。');
  const desiredStop = input.stopMode === 'price' ? stopInput * PERCENT : entry * (PERCENT - direction * stopInput);
  if (desiredStop <= 0n || direction * (entry * PERCENT - desiredStop) <= 0n) throw new Error('止损须位于入场参考价的不利方向，且价格大于零。');
  if (direction * (mark * PERCENT - desiredStop) <= 0n) throw new Error('当前标记价已满足止损条件，请刷新行情或修改止损。');
  const tick = parseDecimal(snapshot.rules.tickSize, '价格步长');
  const minPrice = parseDecimal(snapshot.rules.minPrice, '最小价格');
  const maxPrice = parseDecimal(snapshot.rules.maxPrice, '最大价格');
  if (tick <= 0n || desiredStop < minPrice * PERCENT) throw new Error('止损价格低于合约下限或价格步长不支持。');
  const tickDenominator = PERCENT * tick;
  const stop = minPrice + (desiredStop - minPrice * PERCENT + (direction === -1n ? tickDenominator - 1n : 0n)) / tickDenominator * tick;
  if (stop <= 0n || (maxPrice > 0n && stop > maxPrice)) throw new Error('取整后止损价格超出合约范围。');
  if (direction * (mark - stop) <= 0n) throw new Error('当前标记价已满足取整后的止损条件。');
  const budgetInput = parseDecimal(input.budget, '亏损预算');
  if (budgetInput <= 0n) throw new Error('亏损预算须大于零。');
  if (input.budgetMode === 'percent' && budgetInput > PERCENT) throw new Error('权益预算比例须大于 0 且不超过 100%。');
  const budget = input.budgetMode === 'amount' ? budgetInput : parseDecimal(snapshot.account.equity, '账户权益') * budgetInput / PERCENT;
  const funding = parseDecimal(input.funding || '0', '资金费预留');
  if (budget <= funding) throw new Error('亏损预算须大于资金费预留，且换算金额须大于零。');
  const slip = parseDecimal(input.slippage, '每次滑点');
  const fee = parseDecimal(snapshot.takerRate, '账户 taker 费率');
  if (slip >= PERCENT) throw new Error('每次滑点须小于 100%。');
  if (fee >= SCALE) throw new Error('账户 taker 费率无效，请刷新。');
  const step = parseDecimal(snapshot.rules.stepSize, '数量步长');
  const minQty = parseDecimal(snapshot.rules.minQty, '最小数量');
  const maxQty = parseDecimal(snapshot.rules.maxQty, '最大数量');
  if (step <= 0n || maxQty <= 0n || maxQty < minQty) throw new Error('市价数量规则无效，请刷新。');
  // 8-place prices × 10-place percentage ratios = 18 places; fees add 8 more.
  // Keep exact products until quantity rounding; ceil displayed loss to 8 places.
  const entryEstimate = entry * (PERCENT + direction * slip);
  const exitEstimate = stop * (PERCENT - direction * slip);
  const unitLoss = direction * (entryEstimate - exitEstimate) * SCALE + (entryEstimate + exitEstimate) * fee;
  if (unitLoss <= 0n) throw new Error('每单位计划损失须大于零。');
  const riskQuantity = (budget - funding) * 10n ** 26n / unitLoss;
  const allowedQuantity = riskQuantity < maxQty ? riskQuantity : maxQty;
  if (allowedQuantity < minQty) throw new Error('预算允许数量低于最小开仓数量；请自行调整输入。');
  const quantity = minQty + (allowedQuantity - minQty) / step * step;
  if (quantity <= 0n) throw new Error('预算允许数量低于最小数量步长；请自行调整输入。');
  if (quantity * mark < parseDecimal(snapshot.rules.minNotional, '最小名义价值') * SCALE) throw new Error('数量取整后低于最小名义价值；不会自动增加仓位。');
  const loss = quantity * unitLoss + funding * 10n ** 26n;
  if (loss > budget * 10n ** 26n) throw new Error('取整后计划亏损超出预算，无法生成草稿。');
  return { status: 'draft', notice: '草稿 · 资金与强平检查尚未完成，不能作为正式开仓建议。',
    quantity: formatDecimal(quantity), notional: formatDecimal(quantity * entry, 16),
    stopPrice: formatDecimal(stop), budget: formatDecimal(budget),
    entryEstimate: formatDecimal(entryEstimate, 18), exitEstimate: formatDecimal(exitEstimate, 18),
    plannedLoss: formatDecimal((loss + 10n ** 26n - 1n) / 10n ** 26n),
    stopDistance: formatDecimal(direction * (entry - stop) * PERCENT / entry),
    fundingReserved: funding > 0n,
    referencePrice: formatDecimal(entry), funding: formatDecimal(funding),
    slippagePercent: formatDecimal(slip),
    entryFee: formatDecimal(quantity * entryEstimate * fee, 34),
    exitFee: formatDecimal(quantity * exitEstimate * fee, 34),
    source: snapshot.source, queriedAt: snapshot.queriedAt,
  };
}
