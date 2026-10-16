import { formatDecimal, parseDecimal } from '../public/draft.js';
import type { EntryInput } from '../public/draft.js';
import type { ReviewFill, ReviewTrade } from './review-ledger.ts';
import type { Plan, Verification } from './verification.ts';

export type ArchivedPlan = { plan: Plan; input: EntryInput; verifications: Verification[] };
export type PlanLink = {
  status: 'linked' | 'ambiguous' | 'unlinked';
  reason: string;
  candidatePlanIds: string[];
};
export type PlanComparison = PlanLink & {
  plan: Plan | null;
  input: EntryInput | null;
  verifications: Verification[];
  actualEntry: {
    quantity: string;
    price: string;
    firstAt: string;
    lastAt: string;
    types: (string | null)[];
  } | null;
  quantityDifference: string | null;
  priceDifference: string | null;
  entryTypeDeviation: boolean | null;
  confirmedLoss: string | null;
  budgetExcess: string | null;
  stopChecks: { queriedAt: string; deviations: string[] }[];
  limitations: string[];
};
const active = (status: string) => ['NEW', 'PARTIALLY_FILLED'].includes(status);

function entryFills(trade: ReviewTrade) {
  return trade.evidence.fills.filter((fill) =>
    trade.groupingVersion === 2
      ? fill.event === 'entry' || fill.event === 'add'
      : fill.side === (trade.side === 'long' ? 'BUY' : 'SELL'),
  );
}
function sameFill(a: ReviewFill, b: ReviewFill) {
  return (
    a.id === b.id &&
    a.orderId === b.orderId &&
    a.symbol === b.symbol &&
    a.side === b.side &&
    a.positionSide === b.positionSide &&
    Date.parse(a.time) === Date.parse(b.time) &&
    parseDecimal(a.quantity, '数量') === parseDecimal(b.quantity, '数量') &&
    parseDecimal(a.price, '价格') === parseDecimal(b.price, '价格')
  );
}

export function comparePlan(trade: ReviewTrade, records: ArchivedPlan[]): PlanComparison {
  const entries = entryFills(trade);
  const first = entries[0];
  const candidates = records.filter(
    ({ plan, verifications }) =>
      plan.source === trade.source &&
      plan.reviewAccountId === trade.accountId &&
      plan.symbol === trade.symbol &&
      plan.side === trade.side &&
      trade.openedAt !== null &&
      first &&
      Date.parse(plan.startedAt) <= Date.parse(trade.openedAt) &&
      verifications.some(
        ({ reviewEvidence: evidence }) =>
          evidence &&
          evidence.snapshotConsistent &&
          evidence.entryOrderId === first.orderId &&
          evidence.startTime === Date.parse(plan.startedAt) &&
          evidence.endTime >= Date.parse(first.time) &&
          evidence.fills.some((fill) => sameFill(fill, first)) &&
          evidence.fills
            .filter((fill) => fill.orderId === evidence.entryOrderId)
            .every((fill) => entries.some((item) => sameFill(item, fill))),
      ),
  );
  const result: PlanComparison = {
    status: candidates.length === 1 ? 'linked' : candidates.length > 1 ? 'ambiguous' : 'unlinked',
    reason: '缺少可验证的原方案与开仓成交关联，不能按相近时间配对。',
    candidatePlanIds: candidates.map(({ plan }) => plan.id).sort(),
    plan: null,
    input: null,
    verifications: [],
    actualEntry: null,
    quantityDifference: null,
    priceDifference: null,
    entryTypeDeviation: null,
    confirmedLoss: null,
    budgetExcess: null,
    stopChecks: [],
    limitations: [
      '核验仅代表查询时点；未记录期间的止损变化与覆盖保持未知，不能推导持续保护状态。',
      '实际亏损超预算与用户违反计划分别表达；滑点、行情缺口或亏损结果不能单独证明违规或操作动机。',
    ],
  };
  if (candidates.length > 1) result.reason = '多个原方案命中相同成交证据，无法唯一关联。';
  if (candidates.length === 1)
    result.reason = '账户、合约、方向、时间与开仓订单及逐笔成交证据一致。';
  if (candidates.length !== 1) {
    result.limitations.push('未唯一关联原方案，预算偏离、计划入场与止损偏离无法判断。');
    return result;
  }
  const { plan, input, verifications } = candidates[0]!;
  Object.assign(result, { plan, input, verifications });
  const quantity = entries.reduce((sum, fill) => sum + parseDecimal(fill.quantity, '入场数量'), 0n);
  const cost = entries.reduce(
    (sum, fill) =>
      sum + parseDecimal(fill.quantity, '入场数量') * parseDecimal(fill.price, '成交价'),
    0n,
  );
  const types = [
    ...new Set(
      entries.map(
        (fill) => trade.evidence.orders.find((order) => order.id === fill.orderId)?.type ?? null,
      ),
    ),
  ];
  if (quantity > 0n && first) {
    const price = cost / quantity;
    result.actualEntry = {
      quantity: formatDecimal(quantity),
      price: formatDecimal(price),
      firstAt: first.time,
      lastAt: entries.at(-1)!.time,
      types,
    };
    result.quantityDifference = formatDecimal(quantity - parseDecimal(plan.quantity, '原计划数量'));
    result.priceDifference = formatDecimal(price - parseDecimal(plan.referencePrice, '原入场价'));
    result.entryTypeDeviation = types.includes(null)
      ? null
      : types.some((type) => type !== plan.execution.entryType);
  }
  if (trade.status === 'closed' && trade.netPnl !== null) {
    const loss = trade.netPnl.startsWith('-') ? parseDecimal(trade.netPnl.slice(1), '净亏损') : 0n;
    const excess = loss - parseDecimal(plan.budget, '原预算');
    result.confirmedLoss = formatDecimal(loss);
    result.budgetExcess = formatDecimal(excess > 0n ? excess : 0n);
  } else result.limitations.push('交易尚未结束或净盈亏待确认，不能判断最终净亏损是否超预算。');
  result.stopChecks = verifications.map((verification) => {
    const deviations: string[] = [];
    if (!verification.reviewEvidence?.snapshotConsistent)
      return { queriedAt: verification.queriedAt, deviations };
    for (const stop of verification.reviewEvidence?.stops ?? []) {
      if (!active(stop.status)) continue;
      if (stop.side !== plan.execution.stopSide || stop.positionSide !== 'BOTH') {
        deviations.push(`止损 ${stop.id} 的退出方向或持仓方向偏离原方案。`);
        continue;
      }
      const final = stop.closePosition;
      const expected = final ? plan.stopPrice : (plan.nearStop?.price ?? plan.stopPrice);
      if (parseDecimal(stop.triggerPrice, '止损触发价') !== parseDecimal(expected, '原止损价'))
        deviations.push(`止损 ${stop.id} 的触发价 ${stop.triggerPrice} 偏离原计划 ${expected}。`);
      const expectedQuantity = final
        ? '0'
        : plan.nearStop
          ? verification.nearQuantity
          : verification.quantity;
      const remaining =
        parseDecimal(stop.quantity, '记录数量') - parseDecimal(stop.executedQuantity, '已成交数量');
      if (
        expectedQuantity !== undefined &&
        remaining !== parseDecimal(expectedQuantity, '核验数量')
      )
        deviations.push(
          `止损 ${stop.id} 的剩余数量 ${formatDecimal(remaining)} 偏离查询时点应覆盖数量 ${expectedQuantity}。`,
        );
      if (
        stop.type !== 'STOP_MARKET' ||
        stop.workingType !== 'MARK_PRICE' ||
        stop.priceProtect ||
        (!final && !stop.reduceOnly)
      )
        deviations.push(`止损 ${stop.id} 的订单类型、触发依据、价格保护或只减仓设置偏离原方案。`);
    }
    return { queriedAt: verification.queriedAt, deviations };
  });
  return result;
}
