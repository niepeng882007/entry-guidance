import { ReviewLedger, demoTrade, type ReviewTrade } from '../src/review-ledger.ts';

export function seedReviewFilters(path: string) {
  const ledger = new ReviewLedger(path, { source: 'demo', accountId: 'demo-account' });
  const create = (
    label: string,
    symbol = 'BTCUSDT',
    shift = 0,
    side: 'long' | 'short' = 'long',
  ) => {
    const evidence = demoTrade();
    evidence.symbol = symbol;
    evidence.baseAsset = symbol.slice(0, -4);
    for (const record of [...evidence.orders, ...evidence.fills, ...evidence.funding]) {
      record.id += `-${label}`;
      record.symbol = symbol;
      record.time = new Date(Date.parse(record.time) + shift).toISOString();
    }
    for (const fill of evidence.fills) fill.orderId += `-${label}`;
    if (side === 'short')
      for (const record of [...evidence.orders, ...evidence.fills])
        record.side = record.side === 'BUY' ? 'SELL' : 'BUY';
    return ledger.get(ledger.archive(evidence))!;
  };
  ledger.archive(demoTrade());
  for (let index = 1; index <= 21; index++) create(`page-${String(index).padStart(2, '0')}`);
  // Shanghai midnight and the following midnight: the date's upper bound is exclusive.
  const before = create('before', 'ETHUSDT', -8 * 3600000 - 1001);
  const start = create('start', 'ETHUSDT', -8 * 3600000 - 1000, 'short');
  const end = create('end', 'ETHUSDT', 16 * 3600000 - 1000);
  start.evidence.fills[1]!.orderId += '-add';
  start.evidence.orders.push({
    ...start.evidence.orders[0]!,
    id: start.evidence.fills[1]!.orderId,
    type: 'MARKET',
    quantity: '0.006',
  });
  start.evidence.orders[0]!.quantity = '0.004';
  start.netPnl = '-13.5265';
  start.realizedPnl = '-13';
  start.evidence.fills[2]!.realizedPnl = '-4';
  start.evidence.fills[3]!.realizedPnl = '-9';
  const flat = create('flat', 'SOLUSDT');
  flat.netPnl = '0';
  flat.realizedPnl = '0';
  flat.commission = '0';
  flat.fundingNet = '0';
  flat.evidence.fills.forEach((fill) => {
    fill.realizedPnl = '0';
    fill.commission = '0';
  });
  flat.evidence.funding.forEach((fee) => {
    fee.amount = '0';
  });
  const pending = create('pending', 'SOLUSDT');
  pending.status = 'incomplete';
  pending.netPnl = null;
  pending.commission = null;
  pending.missing = ['非 USDT 手续费缺少换算'];
  pending.evidence.fills[0]!.commissionAsset = 'BNB';
  pending.evidence.orders[0]!.type = null;
  const open = create('open', 'SOLUSDT');
  open.groupingVersion = 2;
  open.status = 'open';
  open.closedAt = null;
  open.netPnl = null;
  open.observedAt = '2026-10-10T13:00:00.000Z';
  open.unrealizedPnl = null;
  open.unrealizedAt = null;
  open.evidence.fills = open.evidence.fills.slice(0, 2);
  open.evidence.fills[0]!.event = 'entry';
  open.evidence.fills[1]!.event = 'add';
  open.evidence.endPosition = '0.01';
  const unknownStart = create('unknown-start', 'SOLUSDT');
  unknownStart.status = 'incomplete';
  unknownStart.side = null;
  unknownStart.openedAt = null;
  unknownStart.netPnl = null;
  unknownStart.missing = ['空仓起点未知'];
  ledger.project('ETHUSDT', [before, start, end]);
  ledger.project('SOLUSDT', [flat, pending, open, unknownStart]);
  const first = ledger.saveTag({ id: null, version: 0, name: '顺势', active: true }).tags[0]!;
  const second = ledger
    .saveTag({ id: null, version: 0, name: '回踩', active: true })
    .tags.find((tag) => tag.id !== first.id)!;
  const note = (trade: ReviewTrade, tagIds: string[]) =>
    ledger.saveNote(trade.id, {
      noteId: null,
      version: 0,
      basis: ledger.get(trade.id)!.noteBasis,
      tagIds,
      entryReason: '',
      exitReason: '',
      executionProblem: '',
      improvement: '',
      freeNote: '',
    });
  note(start, [first.id, second.id]);
  note(flat, [first.id]);
  note(pending, [first.id]);
  pending.evidence.fills[0]!.quantity = '0.003';
  ledger.project('SOLUSDT', [flat, pending, open, unknownStart]);
  ledger.saveTag({ id: first.id, version: first.version, name: first.name, active: false });
  // Seed foreign identities in the same file to exercise HTTP archive isolation.
  const foreign = new ReviewLedger(path, { source: 'demo', accountId: 'other-account' });
  foreign.archive(demoTrade());
  foreign.close();
  const real = new ReviewLedger(path, { source: 'binance', accountId: '12345' });
  real.archive(demoTrade());
  real.close();
  ledger.close();
  return {
    start: start.id,
    before: before.id,
    end: end.id,
    flat: flat.id,
    pending: pending.id,
    open: open.id,
    unknownStart: unknownStart.id,
    tags: [first.id, second.id],
  };
}
