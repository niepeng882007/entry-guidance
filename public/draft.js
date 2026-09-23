/** @typedef {{symbol: string, side: string, budgetMode: string, budget: string, stopMode: string, stop: string, slippage: string, funding: string, entryType?: string, limitPrice?: string, stopLevels?: string, nearStopMode?: string, nearStop?: string, nearPercent?: string}} DraftInput */
/** @typedef {DraftInput & {leverage: string, minimumBuffer: string, fundingCap: string}} EntryInput */
/** @typedef {{stopLevels: 'single', stop: string} | {stopLevels: 'two', stop: string, nearStop: string, nearPercent: string}} StopTemplate */
/** @typedef {{minQty: string, maxQty: string, stepSize: string}} LotSize */
/** @typedef {LotSize & {minPrice: string, maxPrice: string, tickSize: string, minNotional: string, lotSize: LotSize, marketTakeBound: string, limitSupported?: boolean, percentPrice?: {up: string, down: string}}} Rules */
/** @typedef {{maxLeverage: number, floor: string, cap: string, maintenanceRate: string, cum: string}} Bracket */
/** @typedef {{source: 'binance'|'demo', queriedAt: string, symbol: string, baseAsset: string, bid: string, ask: string, mark: string, last: string, bookTime: string, markTime: string, lastTime: string, takerRate: string, brackets: Bracket[], rules: Rules, account: {equity: string, availableBalance: string, walletBalance: string, unrealizedProfit: string, queriedAt: string}}} Snapshot */

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
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, '0');
  return `${value < 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, '') || '0';
}

/** @param {DraftInput} input @param {Pick<Snapshot, 'symbol' | 'ask' | 'bid'> | null} snapshot */
function entryReference(input, snapshot) {
  if (!['long', 'short'].includes(input.side)) throw new Error('请选择做多或做空方向。');
  if (!['MARKET', 'LIMIT'].includes(input.entryType ?? 'MARKET')) throw new Error('请选择市价或限价入场。');
  if (input.entryType !== 'LIMIT' && (!snapshot || input.symbol !== snapshot.symbol)) throw new Error('请刷新当前币种行情后换算止损百分比。');
  const label = input.entryType === 'LIMIT' ? '限价委托价' : '入场参考价';
  const entry = parseDecimal(input.entryType === 'LIMIT' ? input.limitPrice : input.side === 'long' ? snapshot?.ask : snapshot?.bid, label);
  if (entry <= 0n) throw new Error(`${label}须为正数。`);
  return entry;
}

/** @param {unknown} value @returns {StopTemplate} */
function validateStopTemplate(value) {
  if (!value || typeof value !== 'object' || !('stopLevels' in value) || !('stop' in value)) throw new Error('模板缺少止损层数或最终百分比。');
  if (value.stopLevels !== 'single' && value.stopLevels !== 'two') throw new Error('模板层数须为单层或双层。');
  const keys = value.stopLevels === 'two' ? ['stopLevels', 'stop', 'nearStop', 'nearPercent'] : ['stopLevels', 'stop'];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('模板含有非止损字段，请删除后重新保存。');
  const stop = parseDecimal(value.stop, '模板最终止损百分比');
  if (stop <= 0n) throw new Error('模板最终止损百分比须大于零。');
  if (value.stopLevels === 'single') return { stopLevels: 'single', stop: formatDecimal(stop) };
  if (!('nearStop' in value) || !('nearPercent' in value)) throw new Error('双层模板缺少近端距离或分配比例。');
  const near = parseDecimal(value.nearStop, '模板近端止损百分比');
  const ratio = parseDecimal(value.nearPercent, '模板近端分配比例');
  if (near <= 0n || near >= stop) throw new Error('模板近端距离须大于零且小于最终止损距离。');
  if (ratio <= 0n || ratio >= PERCENT) throw new Error('模板近端分配比例须大于 0 且小于 100%。');
  return { stopLevels: 'two', stop: formatDecimal(stop), nearStop: formatDecimal(near), nearPercent: formatDecimal(ratio) };
}

/** @param {DraftInput} input @param {Pick<Snapshot, 'symbol' | 'ask' | 'bid'> | null} snapshot */
export function createStopTemplate(input, snapshot) {
  /** @param {string | undefined} value @param {string | undefined} mode */
  const distance = (value, mode) => {
    if (mode !== 'percent' && mode !== 'price') throw new Error('止损方式无效。');
    const stop = parseDecimal(value, '止损');
    if (stop <= 0n) throw new Error('止损须为正数。');
    if (mode === 'percent') return formatDecimal(stop);
    const entry = entryReference(input, snapshot);
    const difference = (input.side === 'long' ? 1n : -1n) * (entry - stop);
    if (difference <= 0n) throw new Error('绝对止损须位于入场参考价的不利方向。');
    const percent = difference * PERCENT / entry;
    if (percent <= 0n) throw new Error('止损距离小于模板的 0.00000001% 精度，请手动填写百分比。');
    return formatDecimal(percent);
  };
  return validateStopTemplate({ stopLevels: input.stopLevels ?? 'single', stop: distance(input.stop, input.stopMode),
    ...(input.stopLevels === 'two' ? { nearStop: distance(input.nearStop, input.nearStopMode), nearPercent: input.nearPercent } : {}),
  });
}

/** @param {EntryInput} input @param {unknown} template */
export function applyStopTemplate(input, template) {
  const value = validateStopTemplate(template);
  return { ...input, stopLevels: value.stopLevels, stopMode: 'percent', stop: value.stop,
    nearStopMode: value.stopLevels === 'two' ? 'percent' : '', nearStop: value.stopLevels === 'two' ? value.nearStop : '', nearPercent: value.stopLevels === 'two' ? value.nearPercent : '',
  };
}

/** @param {DraftInput} input @param {Snapshot} snapshot */
export function generateDraft(input, snapshot) {
  return calculatePlan(input, snapshot);
}

/** @param {EntryInput} input @param {Snapshot} snapshot */
export function generateEntryPreview(input, snapshot) {
  const plan = calculatePlan(input, snapshot, input);
  if (!plan.checks) throw new Error('资金与强平检查未完成。');
  return { ...plan, ...plan.checks };
}

/** @param {EntryInput} input @param {Snapshot} snapshot */
export function generateEntryPlan(input, snapshot) {
  const plan = generateEntryPreview(input, snapshot);
  if (plan.liquidationIssue) throw new Error(plan.liquidationIssue);
  return { ...plan, status: snapshot.source === 'demo' ? 'simulation' : 'ready',
    notice: snapshot.source === 'demo' ? '模拟开仓卡 · 不可用于真实交易。' : '开仓前检查通过 · 尚未下单或核验止损。',
    symbol: snapshot.symbol, baseAsset: snapshot.baseAsset, side: input.side,
    leverage: input.leverage, fundingCap: input.fundingCap, exitMode: '整仓退出',
    execution: { entrySide: input.side === 'long' ? 'BUY' : 'SELL', stopSide: input.side === 'long' ? 'SELL' : 'BUY', marginMode: 'ISOLATED', positionMode: 'BOTH', entryType: input.entryType ?? 'MARKET', ...(input.entryType === 'LIMIT' ? { timeInForce: 'GTC' } : {}), stopType: 'STOP_MARKET', workingType: 'MARK_PRICE', priceProtect: 'FALSE', closePosition: 'true' },
    accountTime: snapshot.account.queriedAt, bookTime: snapshot.bookTime, markTime: snapshot.markTime, lastTime: snapshot.lastTime,
  };
}

/** @param {ReturnType<typeof generateEntryPlan>} original @param {Snapshot} snapshot */
export function recheckEntryPlan(original, snapshot) {
  if (snapshot.source !== original.source) throw new Error('原卡与当前数据来源不一致。');
  const input = { symbol: original.symbol, side: original.side, budgetMode: 'amount', budget: original.budget,
    stopMode: 'price', stop: original.stopPrice, slippage: original.slippagePercent, funding: original.funding,
    leverage: original.leverage, minimumBuffer: original.minimumBuffer, fundingCap: original.fundingCap ?? original.fundingLimit,
    entryType: original.execution.entryType, limitPrice: original.limitPrice, stopLevels: original.nearStop ? 'two' : 'single',
    nearStopMode: 'price', nearStop: original.nearStop?.price, nearPercent: original.nearStop?.percent };
  const plan = calculatePlan(input, snapshot, input, parseDecimal(original.quantity, '原卡数量'));
  if (!plan.checks) throw new Error('原卡资金与强平检查未完成。');
  if (plan.stopPrice !== original.stopPrice || plan.nearStop?.price !== original.nearStop?.price || plan.nearStop?.quantity !== original.nearStop?.quantity)
    throw new Error('交易规则变化，原卡止损价格或分层数量不再适用；请重新生成。');
  return { ...plan, ...plan.checks };
}

/** @param {bigint} numerator @param {bigint} denominator */
const ceil = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
/** @param {bigint[]} values */
const min = (...values) => values.reduce((a, b) => a < b ? a : b);
/** @param {bigint[]} values */
const max = (...values) => values.reduce((a, b) => a > b ? a : b);

/** @param {LotSize & {lotSize: LotSize}} rules */
function marketLots(rules) {
  const lots = [rules, rules.lotSize].map((lot) => ({ min: parseDecimal(lot.minQty, '退出最小数量'), max: parseDecimal(lot.maxQty, '退出最大数量'), step: parseDecimal(lot.stepSize, '退出数量步长') }));
  const [market, normal] = lots;
  if (!market || !normal || lots.some((lot) => lot.step <= 0n || lot.max <= 0n || lot.max < lot.min || lot.min % lot.step !== 0n)) throw new Error('数量规则缺失或步长起点不支持，暂停新建议。');
  let a = market.step, b = normal.step;
  while (b) [a, b] = [b, a % b];
  const step = market.step / a * normal.step;
  return { step, min: ceil(max(market.min, normal.min), step) * step, max: min(market.max, normal.max) };
}

/** @param {bigint} quantity @param {string} percent @param {LotSize & {lotSize: LotSize}} rules */
export function splitStopQuantity(quantity, percent, rules) {
  const ratio = parseDecimal(percent, '近端比例');
  if (ratio <= 0n || ratio >= PERCENT) throw new Error('双层比例均须为正数，近端比例须小于 100%，剩余比例自动归最终止损。');
  const lot = marketLots(rules);
  const near = quantity * ratio / PERCENT / lot.step * lot.step;
  if (near <= 0n || near < lot.min || near > lot.max || near >= quantity) throw new Error('近端数量取整后为零或不符合退出数量规则，无法生成双层方案；不会增仓或自动改单层。');
  const actual = near * PERCENT / quantity;
  return { near, remaining: quantity - near, actualPercent: formatDecimal(actual), finalPercent: formatDecimal(PERCENT - actual) };
}

/** @param {DraftInput} input @param {Snapshot} snapshot @param {EntryInput} [entryInput] @param {bigint} [fixedQuantity] */
function calculatePlan(input, snapshot, entryInput, fixedQuantity) {
  if (input.symbol !== snapshot.symbol) throw new Error('币种已变化，请刷新行情。');
  if (!['long', 'short'].includes(input.side)) throw new Error('请选择做多或做空方向。');
  if (!['amount', 'percent'].includes(input.budgetMode)) throw new Error('预算方式无效。');
  if (!['price', 'percent'].includes(input.stopMode)) throw new Error('止损方式无效。');
  if (!['single', 'two'].includes(input.stopLevels ?? 'single')) throw new Error('请选择单层或双层止损。');
  if (!['MARKET', 'LIMIT'].includes(input.entryType ?? 'MARKET')) throw new Error('请选择市价或限价入场。');
  const limit = input.entryType === 'LIMIT';
  const direction = input.side === 'long' ? 1n : -1n;
  const entry = entryReference(input, snapshot);
  const mark = parseDecimal(snapshot.mark, '标记价');
  if (entry <= 0n || mark <= 0n) throw new Error('行情价格须为正数，请刷新。');
  const tick = parseDecimal(snapshot.rules.tickSize, '价格步长');
  const minPrice = parseDecimal(snapshot.rules.minPrice, '最小价格');
  const maxPrice = parseDecimal(snapshot.rules.maxPrice, '最大价格');
  /** @param {string | undefined} value @param {string | undefined} mode */
  const stopPrice = (value, mode) => {
    if (!mode || !['price', 'percent'].includes(mode)) throw new Error('止损方式无效。');
    const stopInput = parseDecimal(value, '止损');
    if (stopInput <= 0n) throw new Error('止损须为正数。');
    const desired = mode === 'price' ? stopInput * PERCENT : entry * (PERCENT - direction * stopInput);
    if (desired <= 0n || direction * (entry * PERCENT - desired) <= 0n) throw new Error('止损须位于入场参考价的不利方向，且价格大于零。');
    if (direction * (mark * PERCENT - desired) <= 0n) throw new Error('当前标记价已满足止损条件，请刷新行情或修改止损。');
    if (tick <= 0n || desired < minPrice * PERCENT) throw new Error('止损价格低于合约下限或价格步长不支持。');
    const denominator = PERCENT * tick;
    const rounded = minPrice + (desired - minPrice * PERCENT + (direction === -1n ? denominator - 1n : 0n)) / denominator * tick;
    if (rounded <= 0n || (maxPrice > 0n && rounded > maxPrice)) throw new Error('取整后止损价格超出合约范围。');
    if (direction * (mark - rounded) <= 0n) throw new Error('当前标记价已满足取整后的止损条件。');
    return rounded;
  };
  const stop = stopPrice(input.stop, input.stopMode);
  const nearPrice = input.stopLevels === 'two' ? stopPrice(input.nearStop, input.nearStopMode) : null;
  if (nearPrice !== null && direction * (nearPrice - stop) <= 0n) throw new Error('双层取整后价格重合或近远顺序错误，近端必须先于最终止损。');
  if (limit) {
    if (snapshot.rules.limitSupported !== true) throw new Error('当前合约未确认支持普通 GTC 限价入场。');
    if (entry < minPrice || (maxPrice > 0n && entry > maxPrice) || (entry - minPrice) % tick !== 0n) throw new Error(`限价委托价不符合价格范围或步长 ${snapshot.rules.tickSize}，请修正；不会自动改价。`);
    const range = snapshot.rules.percentPrice;
    if (!range) throw new Error('限价价格范围规则缺失或重复，请刷新。');
    const up = parseDecimal(range.up, '限价价格范围'), down = parseDecimal(range.down, '限价价格范围');
    if (down <= 0n || up < down) throw new Error('限价价格范围规则无效。');
    if (direction === 1n ? entry * SCALE > mark * up : entry * SCALE < mark * down) throw new Error('限价超出当前标记价允许的价格范围，请自行修正后重算。');
  }
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
  const lot = limit ? snapshot.rules.lotSize : snapshot.rules;
  let step = parseDecimal(lot.stepSize, '数量步长');
  let minQty = parseDecimal(lot.minQty, '最小数量');
  let maxQty = parseDecimal(lot.maxQty, '最大数量');
  if (step <= 0n || maxQty <= 0n || maxQty < minQty) throw new Error('开仓数量规则无效，请刷新。');
  // 8-place prices × 10-place percentage ratios = 18 places; fees add 8 more.
  // Keep exact products until quantity rounding; ceil displayed loss to 8 places.
  const entryEstimate = entry * (limit ? PERCENT : PERCENT + direction * slip);
  const exitEstimate = stop * (PERCENT - direction * slip);
  const unitLoss = direction * (entryEstimate - exitEstimate) * SCALE + (entryEstimate + exitEstimate) * fee;
  if (unitLoss <= 0n) throw new Error('每单位计划损失须大于零。');
  const riskQuantity = (budget - funding) * 10n ** 26n / unitLoss;
  const constraints = entryInput ? entryConstraints(entryInput, snapshot, entryEstimate, mark, direction, fee) : null;
  if (constraints && !limit) {
    const combined = marketLots(snapshot.rules);
    step = combined.step;
    minQty = combined.min;
    maxQty = combined.max;
  }
  const allowedQuantity = constraints ? min(riskQuantity, maxQty, constraints.quantityLimit) : min(riskQuantity, maxQty);
  if (fixedQuantity !== undefined && (fixedQuantity > allowedQuantity || fixedQuantity < minQty || (fixedQuantity - minQty) % step !== 0n))
    throw new Error('原卡数量不再符合当前预算、资金、账户档位或数量规则；请重新生成，不会自动缩量。');
  if (allowedQuantity < minQty) throw new Error(`预算${constraints ? '、可用资金或账户档位' : ''}允许数量 ${formatDecimal(allowedQuantity)} ${snapshot.baseAsset} 低于最小开仓数量 ${formatDecimal(minQty)}；请自行调整输入。`);
  const quantity = fixedQuantity ?? minQty + (allowedQuantity - minQty) / step * step;
  if (quantity <= 0n) throw new Error('预算允许数量低于最小数量步长；请自行调整输入。');
  if (quantity * (limit ? entry : mark) < parseDecimal(snapshot.rules.minNotional, '最小名义价值') * SCALE) throw new Error('数量取整后低于最小名义价值；不会自动增加仓位。');
  const loss = quantity * unitLoss + funding * 10n ** 26n;
  if (loss > budget * 10n ** 26n) throw new Error('取整后计划亏损超出预算，无法生成草稿。');
  const checks = constraints ? checkEntry(quantity, stop, entry, entryEstimate, direction, fee, constraints) : null;
  const split = nearPrice !== null ? splitStopQuantity(quantity, input.nearPercent ?? '', snapshot.rules) : null;
  const nearStop = nearPrice !== null && split ? { price: formatDecimal(nearPrice), distance: formatDecimal(direction * (entry - nearPrice) * PERCENT / entry), quantity: formatDecimal(split.near), percent: input.nearPercent ?? '', actualPercent: split.actualPercent } : null;
  return { status: 'draft', notice: '草稿 · 资金与强平检查尚未完成，不能作为正式开仓建议。',
    nearStop, finalQuantity: formatDecimal(split?.remaining ?? quantity), finalPercent: split?.finalPercent ?? '100',
    quantity: formatDecimal(quantity), notional: formatDecimal(quantity * entry, 16),
    stopPrice: formatDecimal(stop), budget: formatDecimal(budget),
    entryEstimate: formatDecimal(entryEstimate, 18), exitEstimate: formatDecimal(exitEstimate, 18),
    plannedLoss: formatDecimal((loss + 10n ** 26n - 1n) / 10n ** 26n),
    stopDistance: formatDecimal(direction * (entry - stop) * PERCENT / entry),
    fundingReserved: funding > 0n,
    referencePrice: formatDecimal(entry), limitPrice: limit ? formatDecimal(entry) : '', funding: formatDecimal(funding),
    slippagePercent: formatDecimal(slip),
    entryFee: formatDecimal(quantity * entryEstimate * fee, 34),
    exitFee: formatDecimal(quantity * exitEstimate * fee, 34),
    source: snapshot.source, queriedAt: snapshot.queriedAt, checks,
  };
}

/** @param {EntryInput} input @param {Snapshot} snapshot @param {bigint} entryEstimate @param {bigint} mark @param {bigint} direction @param {bigint} fee */
function entryConstraints(input, snapshot, entryEstimate, mark, direction, fee) {
  if (!/^[1-9]\d{0,2}$/.test(input.leverage)) throw new Error('请选择账户档位允许的正整数杠杆。');
  const leverage = BigInt(input.leverage);
  if (!input.minimumBuffer) throw new Error('最低强平缓冲首次必填，请填写正数个人偏好。');
  const minimumBuffer = parseDecimal(input.minimumBuffer, '最低强平缓冲');
  if (minimumBuffer <= 0n) throw new Error('最低强平缓冲须为正数个人偏好，首次必填。');
  const available = parseDecimal(snapshot.account.availableBalance, '可用余额');
  const cap = input.fundingCap ? parseDecimal(input.fundingCap, '本单资金上限') : available;
  if (input.fundingCap && cap <= 0n) throw new Error('本单资金上限须为正数，或留空。');
  const fundingLimit = min(available, cap);
  if (fundingLimit <= 0n) throw new Error('可用余额不足，无法满足最小开仓条件。');
  if (!Array.isArray(snapshot.brackets) || !snapshot.brackets.length) throw new Error('缺少账户杠杆档位，暂停新建议。');
  const brackets = snapshot.brackets.map((tier) => ({ ...tier, floor: parseDecimal(tier.floor, '档位下限'), cap: parseDecimal(tier.cap, '档位上限'), rate: parseDecimal(tier.maintenanceRate, '维持保证金率'), cum: parseDecimal(tier.cum, '维持保证金速算额') }));
  const eligible = brackets.filter((tier) => Number.isSafeInteger(tier.maxLeverage) && BigInt(tier.maxLeverage) >= leverage);
  if (!eligible.length) throw new Error('所选杠杆超过账户允许值，请自行降低杠杆。');
  const notionalLimit = max(...eligible.map((tier) => tier.cap));
  // Binance's funding valuation differs by order type/direction from the adverse fill estimate.
  // Source and model assumptions: README.md, "正式开仓卡计算口径".
  const last = parseDecimal(snapshot.last, '最新成交价');
  if (last <= 0n) throw new Error('最新成交价缺失或无效。');
  const limit = input.entryType === 'LIMIT';
  let assumingPrice = last * 10_015_000_000n;
  if (limit) assumingPrice = direction === 1n ? entryEstimate : max(assumingPrice, mark * PERCENT, entryEstimate);
  const openLoss = max(0n, direction * ((limit ? entryEstimate : assumingPrice) - mark * PERCENT));
  const feeReserve = max(assumingPrice, entryEstimate) * fee;
  const unitCost = assumingPrice * SCALE + (openLoss * SCALE + feeReserve) * leverage;
  const quantityLimit = min(fundingLimit * 10n ** 26n * leverage / unitCost, notionalLimit * 10n ** 18n / max(mark * PERCENT, entryEstimate, assumingPrice));
  const takeBound = parseDecimal(snapshot.rules.marketTakeBound, '市价成交边界');
  if (input.entryType !== 'LIMIT' && (takeBound <= 0n || takeBound >= SCALE || direction * (entryEstimate * SCALE - mark * PERCENT * SCALE) > mark * PERCENT * takeBound)) throw new Error('不利成交估值超出市价成交边界，请刷新或调整滑点假设。');
  return { leverage, minimumBuffer, fundingLimit, notionalLimit, assumingPrice, openLoss, feeReserve, unitCost, quantityLimit, brackets };
}

/** @param {bigint} quantity @param {bigint} stop @param {bigint} entry @param {bigint} entryEstimate @param {bigint} direction @param {bigint} fee @param {ReturnType<typeof entryConstraints>} limits */
function checkEntry(quantity, stop, entry, entryEstimate, direction, fee, limits) {
  const { leverage, brackets } = limits;
  const costDenominator = 10n ** 26n * leverage;
  const cost = quantity * limits.unitCost;
  if (cost > limits.fundingLimit * costDenominator) throw new Error('取整后资金需求仍超出可用资金。');
  // Model WB = q × adverse fill / leverage − opening taker fee; not actual exchange wallet balance.
  const walletNumerator = quantity * entryEstimate * (SCALE - fee * leverage);
  if (walletNumerator <= 0n) throw new Error('假设逐仓本金不足以覆盖开仓手续费，暂停新建议。');
  for (const [index, tier] of brackets.entries()) {
    const numerator = quantity * entryEstimate * SCALE * leverage - direction * (walletNumerator + tier.cum * costDenominator);
    const denominator = quantity * (SCALE - direction * tier.rate) * PERCENT * leverage;
    if (numerator <= 0n || denominator <= 0n) continue;
    // Test the unrounded liquidation notional against each tier, including a crossing from entry.
    const notionalNumerator = quantity * numerator;
    if (notionalNumerator < tier.floor * SCALE * denominator || notionalNumerator > tier.cap * SCALE * denominator) continue;
    const liquidationPrice = direction === 1n ? ceil(numerator, denominator) : numerator / denominator;
    const gap = direction * (stop - liquidationPrice);
    const buffer = gap * PERCENT / entry;
    let liquidationIssue = '';
    if (gap <= 0n) liquidationIssue = `先强平、后止损：预估强平价 ${formatDecimal(liquidationPrice)}，有方向缓冲 ${formatDecimal(buffer)}%；请降低杠杆后重算，不会拉近止损。`;
    else if (gap * PERCENT < limits.minimumBuffer * entry) liquidationIssue = `强平缓冲 ${formatDecimal(buffer)}% 低于要求 ${formatDecimal(limits.minimumBuffer)}%，差 ${formatDecimal(ceil(limits.minimumBuffer * entry - gap * PERCENT, entry))} 个百分点；请降低杠杆后重算。`;
    return {
      liquidationIssue,
      initialMargin: formatDecimal(ceil(quantity * limits.assumingPrice * SCALE, costDenominator)),
      openLoss: formatDecimal(ceil(quantity * limits.openLoss, 10n ** 18n)),
      openFeeReserve: formatDecimal(ceil(quantity * limits.feeReserve, 10n ** 26n)),
      fundingRequired: formatDecimal(ceil(cost, costDenominator)), fundingLimit: formatDecimal(limits.fundingLimit),
      notionalLimit: formatDecimal(limits.notionalLimit), assumingPrice: formatDecimal(limits.assumingPrice, 18),
      isolatedWalletAssumption: formatDecimal(walletNumerator / costDenominator),
      liquidationPrice: formatDecimal(liquidationPrice), liquidationBuffer: formatDecimal(buffer),
      minimumBuffer: formatDecimal(limits.minimumBuffer), liquidationTier: index + 1,
      maintenanceRate: formatDecimal(tier.rate * 100n), maintenanceAmount: formatDecimal(tier.cum),
    };
  }
  throw new Error('账户档位无法支持有效的预估强平价（含跨档复算），暂停新建议。');
}
