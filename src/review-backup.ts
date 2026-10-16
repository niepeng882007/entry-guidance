import { createHash } from 'node:crypto';
import type { ReviewIdentity } from './review-ledger.ts';
import { parseDecimal } from '../public/draft.js';
import { noteInput, tagInput, noteBasis } from './review-notes.ts';
import type { ReviewTrade, ReviewFill, ReviewOrder, ReviewFunding } from './review-ledger.ts';
import { validateAnalysisTask } from './analysis-contract.ts';
import { marketIntervals, marketGaps, type MarketArchive, type Candle } from './trade-market.ts';
import type { SyncState, ArchiveState } from './review-ledger.ts';
import type { AnalysisTask } from './trade-analysis.ts';

// SQL names and columns always come from this fixed schema, never the uploaded file.
export const backupTables = {
  trades: { columns: ['id', 'opened_at', 'payload'], keys: ['id'] },
  evidence: {
    columns: ['symbol', 'kind', 'id', 'trade_id', 'payload'],
    keys: ['symbol', 'kind', 'id'],
  },
  review_plans: { columns: ['id', 'payload'], keys: ['id'] },
  review_verifications: { columns: ['plan_id', 'payload'], keys: ['plan_id', 'payload'] },
  history_raw: { columns: ['symbol', 'kind', 'id', 'payload'], keys: ['symbol', 'kind', 'id'] },
  history_sync: { columns: ['symbol', 'payload'], keys: ['symbol'] },
  account_archive: { columns: ['payload'], keys: [] },
  style_tags: { columns: ['id', 'payload'], keys: ['id'] },
  review_notes: { columns: ['id', 'payload'], keys: ['id'] },
  review_market: { columns: ['id', 'cache_key', 'queried_at', 'payload'], keys: ['id'] },
  review_analysis: { columns: ['id', 'trade_id', 'payload'], keys: ['id'] },
  review_versions: { columns: ['id', 'kind', 'record_id', 'payload'], keys: ['id'] },
} as const;
export type BackupTable = keyof typeof backupTables;
export type BackupRecord = { table: BackupTable; data: Record<string, unknown> };
export type ReviewBackup = ReviewIdentity & {
  format: 'entry-guidance-review';
  version: 1;
  exportedAt: string;
  records: BackupRecord[];
};
export type RestoreConflict = {
  key: string;
  table: BackupTable;
  id: string;
  overwritable: boolean;
  current: unknown;
  incoming: unknown;
};
export type RestorePreview = {
  added: number;
  duplicates: number;
  conflicts: RestoreConflict[];
  rejected: string[];
  token: string;
};
export type RecordVersion = {
  id: string;
  kind: 'review_notes' | 'style_tags';
  recordId: string;
  value: unknown;
};
export class BackupError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function recordKey(record: BackupRecord): string {
  const keys: readonly string[] =
    record.table === 'history_raw' && record.data.kind === 'income'
      ? ['kind', 'id']
      : backupTables[record.table].keys;
  return canonical([record.table, ...keys.map((key) => record.data[key])]);
}
export function personal(table: BackupTable): boolean {
  return table === 'review_notes' || table === 'style_tags';
}

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new BackupError('备份记录格式、关联或完整性无效。');
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function string(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length <= 10000);
}
function id(value: unknown) {
  string(value);
  requireValue(value.length > 0 && value.length <= 160);
}
function date(value: unknown, nullable = false) {
  if (nullable && value === null) return;
  string(value);
  requireValue(Number.isFinite(Date.parse(value)));
}
function integer(value: unknown) {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function strings(value: unknown) {
  requireValue(Array.isArray(value) && value.every((item) => typeof item === 'string'));
}
function amount(value: unknown, nullable = false): bigint | null {
  if (nullable && value === null) return null;
  string(value);
  requireValue(/^-?\d{1,24}(\.\d{1,8})?$/.test(value));
  return parseDecimal(value.replace(/^-/, ''), '备份金额') * (value.startsWith('-') ? -1n : 1n);
}
function scoped(value: Record<string, unknown>, scope: ReviewIdentity) {
  requireValue(value.source === scope.source && value.accountId === scope.accountId);
}
function raw(value: unknown) {
  const row = object(value);
  requireValue(
    ['trades', 'history', 'algoHistory', 'income', 'forceOrders', 'position'].includes(
      String(row.kind),
    ),
  );
  id(row.id);
  integer(row.time);
  object(row.payload);
}
function fill(value: unknown, symbol?: unknown) {
  const row = object(value);
  id(row.id);
  id(row.orderId);
  id(row.symbol);
  if (symbol !== undefined) requireValue(row.symbol === symbol);
  requireValue(
    ['BUY', 'SELL'].includes(String(row.side)) &&
      ['BOTH', 'LONG', 'SHORT'].includes(String(row.positionSide)),
  );
  requireValue(amount(row.quantity)! > 0n && amount(row.price)! > 0n);
  date(row.time);
  amount(row.realizedPnl, true);
  amount(row.commission, true);
  requireValue(row.commissionAsset === null || typeof row.commissionAsset === 'string');
  if (row.allocation !== undefined)
    requireValue(['open', 'close'].includes(String(row.allocation)));
  if (row.event !== undefined)
    requireValue(['entry', 'add', 'reduce', 'exit'].includes(String(row.event)));
}
function trade(value: unknown, scope: ReviewIdentity) {
  const row = object(value);
  scoped(row, scope);
  id(row.id);
  id(row.baseAsset);
  requireValue(
    row.symbol === row.baseAsset + 'USDT' &&
      [1, 2].includes(Number(row.groupingVersion)) &&
      typeof row.groupingVersion === 'number',
  );
  requireValue(row.side === null || ['long', 'short'].includes(String(row.side)));
  requireValue(['closed', 'open', 'incomplete'].includes(String(row.status)));
  date(row.openedAt, true);
  date(row.closedAt, true);
  strings(row.missing);
  const realized = amount(row.realizedPnl, true),
    commission = amount(row.commission, true),
    funding = amount(row.fundingNet, true),
    net = amount(row.netPnl, true);
  requireValue(
    row.status === 'closed'
      ? row.openedAt &&
          row.closedAt &&
          row.side &&
          !(row.missing as string[]).length &&
          realized !== null &&
          commission !== null &&
          funding !== null &&
          net === realized - commission + funding
      : net === null,
  );
  if (row.status === 'open') requireValue(row.openedAt && row.closedAt === null && row.side);
  if (row.openedAt && row.closedAt)
    requireValue(Date.parse(String(row.closedAt)) >= Date.parse(String(row.openedAt)));
  const evidence = object(row.evidence);
  requireValue(
    evidence.symbol === row.symbol &&
      evidence.baseAsset === row.baseAsset &&
      typeof evidence.fillsComplete === 'boolean' &&
      typeof evidence.fundingComplete === 'boolean',
  );
  amount(evidence.startPosition, true);
  amount(evidence.endPosition, true);
  if (row.status === 'closed')
    requireValue(
      evidence.fillsComplete &&
        evidence.fundingComplete &&
        evidence.startPosition === '0' &&
        evidence.endPosition === '0',
    );
  requireValue(
    Array.isArray(evidence.fills) &&
      Array.isArray(evidence.orders) &&
      Array.isArray(evidence.funding),
  );
  for (const item of evidence.fills) fill(item, row.symbol);
  for (const item of evidence.orders) {
    const order = object(item);
    id(order.id);
    requireValue(
      order.symbol === row.symbol &&
        ['BUY', 'SELL'].includes(String(order.side)) &&
        (order.type === null || typeof order.type === 'string'),
    );
    amount(order.quantity);
    date(order.time);
  }
  for (const item of evidence.funding) {
    const fee = object(item);
    id(fee.id);
    requireValue(
      fee.symbol === row.symbol && (fee.asset === null || typeof fee.asset === 'string'),
    );
    date(fee.time);
    amount(fee.amount, true);
  }
  if (row.status === 'closed') {
    const fills = evidence.fills as ReviewFill[],
      orders = evidence.orders as ReviewOrder[],
      fees = evidence.funding as ReviewFunding[];
    requireValue(
      fills.length >= 2 &&
        new Set(fills.map((fill) => fill.id)).size === fills.length &&
        new Set(orders.map((order) => order.id)).size === orders.length &&
        new Set(fees.map((fee) => fee.id)).size === fees.length,
    );
    requireValue(
      Date.parse(String(row.openedAt)) === Date.parse(fills[0]!.time) &&
        Date.parse(String(row.closedAt)) === Date.parse(fills.at(-1)!.time) &&
        row.side === (fills[0]!.side === 'BUY' ? 'long' : 'short'),
    );
    let position = 0n,
      gross = 0n,
      costs = 0n,
      fundingSum = 0n;
    for (const [index, fill] of fills.entries()) {
      requireValue(
        fill.positionSide === fills[0]!.positionSide &&
          (index === 0 || Date.parse(fill.time) >= Date.parse(fills[index - 1]!.time)),
      );
      requireValue(orders.some((order) => order.id === fill.orderId && order.side === fill.side));
      requireValue(
        fill.realizedPnl !== null &&
          fill.commission !== null &&
          fill.commissionAsset === 'USDT' &&
          amount(fill.commission)! >= 0n,
      );
      position += amount(fill.quantity)! * (fill.side === 'BUY' ? 1n : -1n);
      requireValue(row.side === 'long' ? position >= 0n : position <= 0n);
      requireValue(index === fills.length - 1 ? position === 0n : position !== 0n);
      gross += amount(fill.realizedPnl)!;
      costs += amount(fill.commission)!;
    }
    for (const fee of fees) {
      requireValue(
        fee.amount !== null &&
          fee.asset === 'USDT' &&
          fee.attribution !== 'ambiguous' &&
          Date.parse(fee.time) >= Date.parse(String(row.openedAt)) &&
          Date.parse(fee.time) <= Date.parse(String(row.closedAt)),
      );
      fundingSum += amount(fee.amount)!;
    }
    requireValue(
      realized === gross &&
        commission === costs &&
        funding === fundingSum &&
        net === gross - costs + fundingSum,
    );
  }
  if (evidence.raw !== undefined) {
    requireValue(Array.isArray(evidence.raw));
    evidence.raw.forEach(raw);
  }
  if (row.groupingVersion === 2) {
    date(row.observedAt);
    amount(row.unrealizedPnl, true);
    date(row.unrealizedAt, true);
  }
}
function note(value: unknown, scope: ReviewIdentity) {
  const row = object(value);
  trade(row.trade, scope);
  date(row.updatedAt);
  requireValue(['current', 'pending'].includes(String(row.binding)));
  noteInput({
    noteId: row.id,
    version: row.version,
    basis: noteBasis(row.trade as ReviewTrade),
    entryReason: row.entryReason,
    exitReason: row.exitReason,
    executionProblem: row.executionProblem,
    improvement: row.improvement,
    freeNote: row.freeNote,
    tagIds: row.tagIds,
  });
}
function tag(value: unknown) {
  const row = object(value);
  date(row.updatedAt);
  tagInput({ id: row.id, version: row.version, name: row.name, active: row.active });
}
function page(value: unknown) {
  const row = object(value);
  requireValue(
    ['trades', 'history', 'algoHistory', 'income', 'forceOrders'].includes(String(row.source)),
  );
  integer(row.startTime);
  integer(row.endTime);
  integer(row.page);
  requireValue(Number(row.endTime) >= Number(row.startTime) && Number(row.page) > 0);
}
function sync(value: unknown) {
  const row = object(value);
  id(row.symbol);
  integer(row.startTime);
  integer(row.endTime);
  requireValue(Number(row.endTime) >= Number(row.startTime));
  requireValue(['running', 'complete', 'failed', 'interrupted'].includes(String(row.status)));
  integer(row.pages);
  integer(row.records);
  strings(row.missing);
  date(row.lastSuccessAt, true);
  for (const key of ['pending', 'completed']) {
    requireValue(Array.isArray(row[key]));
    row[key].forEach(page);
  }
  if (row.unavailable !== undefined) {
    requireValue(Array.isArray(row.unavailable));
    row.unavailable.forEach(page);
  }
  if (row.attemptedAt !== undefined) date(row.attemptedAt);
}
function archive(value: unknown) {
  const row = object(value);
  sync(row.discovery);
  integer(row.startTime);
  integer(row.endTime);
  requireValue(Number(row.endTime) >= Number(row.startTime));
  requireValue(['running', 'complete', 'failed', 'interrupted'].includes(String(row.status)));
  for (const key of ['symbols', 'pendingSymbols', 'completedSymbols', 'missing', 'scopeMissing'])
    strings(row[key]);
  date(row.lastSuccessAt, true);
  if (row.orderDownload !== undefined) {
    const download = object(row.orderDownload);
    requireValue(
      ['submitting', 'processing', 'complete', 'failed', 'unknown'].includes(
        String(download.status),
      ),
    );
    requireValue(
      download.downloadId === null ||
        (typeof download.downloadId === 'string' && /^\d{1,30}$/.test(download.downloadId)),
    );
    integer(download.startTime);
    integer(download.endTime);
    integer(download.records);
    string(download.message);
    requireValue(Number(download.endTime) >= Number(download.startTime));
  }
}
function market(value: unknown, scope: ReviewIdentity) {
  const row = object(value);
  scoped(row, scope);
  id(row.tradeId);
  trade(row.evidence, scope);
  requireValue(
    object(row.evidence).id === row.tradeId &&
      object(row.evidence).symbol === row.symbol &&
      Object.hasOwn(marketIntervals, String(row.interval)),
  );
  id(row.snapshotId);
  id(row.cacheKey);
  date(row.queriedAt);
  date(row.openedAt, true);
  date(row.closedAt, true);
  for (const key of ['startTime', 'endTime', 'desiredEndTime']) integer(row[key]);
  const step = marketIntervals[row.interval as keyof typeof marketIntervals];
  requireValue(
    Number(row.startTime) % step === 0 &&
      Number(row.endTime) >= Number(row.startTime) &&
      Number(row.desiredEndTime) >= Number(row.endTime),
  );
  strings(row.missing);
  strings(row.limitations);
  requireValue(Array.isArray(row.events) && Array.isArray(row.stops));
  row.events.forEach((item) => fill(item, row.symbol));
  for (const item of row.stops) {
    const stop = object(item);
    id(stop.id);
    amount(stop.price);
    integer(stop.time);
    string(stop.basis);
    string(stop.label);
    requireValue(['plan', 'observed', 'historical'].includes(String(stop.kind)));
  }
  for (const source of ['contract', 'mark'] as const) {
    const series = object(object(row.series)[source]);
    string(series.endpoint);
    integer(series.nextTime);
    requireValue(
      series.endpoint === (source === 'contract' ? '/fapi/v1/klines' : '/fapi/v1/markPriceKlines'),
    );
    requireValue(
      typeof series.complete === 'boolean' &&
        (series.error === null || typeof series.error === 'string') &&
        Array.isArray(series.candles) &&
        Array.isArray(series.gaps),
    );
    let previous = -1;
    for (const item of series.candles) {
      const candle = object(item);
      integer(candle.openTime);
      integer(candle.closeTime);
      date(candle.queriedAt);
      requireValue(typeof candle.final === 'boolean');
      requireValue(
        Number(candle.openTime) > previous &&
          Number(candle.openTime) >= Number(row.startTime) &&
          Number(candle.openTime) <= Number(row.endTime) &&
          Number(candle.openTime) % step === 0 &&
          candle.closeTime === Number(candle.openTime) + step - 1 &&
          (!candle.final || Number(candle.closeTime) < Date.parse(String(candle.queriedAt))),
      );
      previous = Number(candle.openTime);
      for (const key of ['open', 'high', 'low', 'close']) requireValue(amount(candle[key])! > 0n);
      requireValue(
        amount(candle.high)! >= amount(candle.open)! &&
          amount(candle.high)! >= amount(candle.close)! &&
          amount(candle.low)! <= amount(candle.open)! &&
          amount(candle.low)! <= amount(candle.close)! &&
          amount(candle.high)! >= amount(candle.low)!,
      );
    }
    for (const item of series.gaps) {
      const gap = object(item);
      integer(gap.startTime);
      integer(gap.endTime);
      requireValue(Number(gap.endTime) >= Number(gap.startTime));
    }
    if (series.complete)
      requireValue(
        !series.gaps.length &&
          !marketGaps(row as MarketArchive, series.candles as Candle[]).length &&
          Number(series.nextTime) > Number(row.endTime) &&
          series.error === null &&
          series.candles.every((item) => object(item).final),
      );
  }
}
function payload(row: BackupRecord, scope: ReviewIdentity) {
  const value = object(row.data.payload),
    data = row.data;
  switch (row.table) {
    case 'trades':
      trade(value, scope);
      requireValue(
        value.id === data.id &&
          data.opened_at ===
            (value.openedAt ?? (object(value.evidence).fills as { time: string }[])[0]?.time ?? ''),
      );
      break;
    case 'review_notes':
      note(value, scope);
      requireValue(value.id === data.id);
      break;
    case 'style_tags':
      tag(value);
      requireValue(value.id === data.id);
      break;
    case 'review_versions':
      requireValue(personal(data.kind as BackupTable));
      id(data.record_id);
      if (data.kind === 'review_notes') note(value, scope);
      else tag(value);
      requireValue(
        value.id === data.record_id && data.id === fingerprint([data.kind, data.record_id, value]),
      );
      break;
    case 'history_raw':
      raw(value);
      requireValue(value.id === data.id && value.kind === data.kind);
      break;
    case 'evidence':
      requireValue(['order', 'fill', 'funding'].includes(String(data.kind)));
      id(data.trade_id);
      if (data.kind === 'fill') fill(value, data.symbol);
      else {
        id(value.id);
        date(value.time);
        requireValue(value.symbol === data.symbol);
        if (data.kind === 'order') {
          requireValue(
            ['BUY', 'SELL'].includes(String(value.side)) &&
              (value.type === null || typeof value.type === 'string'),
          );
          amount(value.quantity);
        } else {
          amount(value.amount, true);
          requireValue(value.asset === null || typeof value.asset === 'string');
        }
      }
      requireValue(value.id === data.id);
      break;
    case 'history_sync':
      sync(value);
      requireValue(value.symbol === data.symbol);
      break;
    case 'account_archive':
      archive(value);
      break;
    case 'review_market':
      market(value, scope);
      requireValue(
        value.snapshotId === data.id &&
          value.cacheKey === data.cache_key &&
          value.queriedAt === data.queried_at,
      );
      break;
    case 'review_analysis': {
      const task = validateAnalysisTask(value, { ...scope, id: String(data.trade_id) });
      requireValue(task.id === data.id);
      date(task.createdAt);
      date(task.updatedAt);
      (task.snapshot.trades ?? [task.snapshot.trade]).forEach((item) => trade(item, scope));
      task.snapshot.markets.forEach((item) => market(item, scope));
      break;
    }
    case 'review_plans': {
      const plan = object(value.plan);
      requireValue(
        plan.id === data.id &&
          plan.source === scope.source &&
          plan.reviewAccountId === scope.accountId,
      );
      date(plan.startedAt);
      id(plan.symbol);
      requireValue(['long', 'short'].includes(String(plan.side)));
      object(plan.execution);
      object(plan.account);
      object(value.input);
      for (const key of ['quantity', 'referencePrice', 'stopPrice', 'budget'])
        requireValue(amount(plan[key])! > 0n);
      if (plan.nearStop !== null && plan.nearStop !== undefined) {
        const near = object(plan.nearStop);
        amount(near.price);
        amount(near.quantity);
      }
      break;
    }
    case 'review_verifications':
      requireValue(
        value.source === scope.source &&
          ['waiting', 'ended', 'incomplete', 'needs-action', 'verified'].includes(
            String(value.status),
          ),
      );
      date(value.queriedAt);
      strings(value.issues);
      if (value.reviewEvidence !== undefined) {
        const evidence = object(value.reviewEvidence);
        integer(evidence.startTime);
        integer(evidence.endTime);
        requireValue(
          typeof evidence.snapshotConsistent === 'boolean' &&
            (evidence.entryOrderId === null || typeof evidence.entryOrderId === 'string'),
        );
        requireValue(
          Array.isArray(evidence.fills) &&
            Array.isArray(evidence.stops) &&
            Array.isArray(evidence.historicalStops),
        );
        evidence.fills.forEach((item) => fill(item));
        for (const item of [...evidence.stops, ...evidence.historicalStops]) {
          const stop = object(item);
          id(stop.id);
          amount(stop.quantity);
          amount(stop.executedQuantity);
          amount(stop.triggerPrice);
          string(stop.type);
          string(stop.status);
          string(stop.side);
          string(stop.positionSide);
          string(stop.workingType);
          for (const key of ['closePosition', 'reduceOnly', 'priceProtect'])
            requireValue(typeof stop[key] === 'boolean');
        }
      }
      break;
  }
}
function safeContent(value: unknown, scope: ReviewIdentity, depth = 0) {
  requireValue(depth < 80);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    requireValue(
      ![
        '__proto__',
        'prototype',
        'constructor',
        'apiKey',
        'apiSecret',
        'password',
        'cookie',
        'session',
        'recovery',
        'authorization',
        'access_token',
        'privateKey',
      ].includes(key),
    );
    if (key === 'accountId' || key === 'reviewAccountId') requireValue(item === scope.accountId);
    if (key === 'source' && ['demo', 'binance'].includes(String(item)))
      requireValue(item === scope.source);
    safeContent(item, scope, depth + 1);
  }
}
const restoredMissing = '备份导入的同步范围需重新读取确认；导入不证明历史完整。';
function importedSync(state: SyncState): SyncState {
  return {
    ...state,
    status: 'interrupted',
    completed: [],
    pending: [
      ...new Map(
        [...state.pending, ...state.completed].map((row) => [canonical(row), row]),
      ).values(),
    ],
    missing: [...new Set([...state.missing, restoredMissing])],
  };
}
function normalizeImported(row: BackupRecord) {
  if (row.table === 'history_sync') row.data.payload = importedSync(row.data.payload as SyncState);
  if (row.table === 'account_archive') {
    const state = row.data.payload as ArchiveState;
    row.data.payload = {
      ...state,
      status: 'interrupted',
      completedSymbols: [],
      pendingSymbols: [...new Set([...state.pendingSymbols, ...state.completedSymbols])],
      discovery: importedSync(state.discovery),
      missing: [...new Set([...state.missing, restoredMissing])],
    };
  }
  if (row.table === 'review_analysis') {
    const task = row.data.payload as AnalysisTask;
    if (task.status !== 'running') return;
    task.status = 'interrupted';
    task.error = '备份中的未完成分析已中断；已完成分段保留，继续由用户主动发起。';
    for (const request of task.requests) {
      if (request.status === 'running') request.status = 'failed';
      for (const attempt of request.attempts)
        if (attempt.status === 'running') attempt.status = 'interrupted';
    }
  }
}
export function validateBackup(
  value: unknown,
  scope: ReviewIdentity,
): { backup: ReviewBackup | null; rejected: string[] } {
  const rejected: string[] = [];
  let backup: ReviewBackup;
  try {
    const envelope = object(value);
    requireValue(
      Object.keys(envelope).sort().join(',') ===
        'accountId,exportedAt,format,records,source,version',
    );
    if (envelope.format !== 'entry-guidance-review' || envelope.version !== 1)
      throw new BackupError('备份格式或版本不支持。');
    if (envelope.accountId !== scope.accountId || envelope.source !== scope.source)
      throw new BackupError('备份账户身份或真实/模拟模式不匹配。');
    date(envelope.exportedAt);
    requireValue(Array.isArray(envelope.records) && envelope.records.length <= 200000);
    backup = structuredClone(value) as ReviewBackup;
  } catch (error) {
    return {
      backup: null,
      rejected: [error instanceof BackupError ? error.message : '备份格式无效。'],
    };
  }
  const identities = new Set<string>();
  const validRecords: BackupRecord[] = [];
  for (const [index, row] of backup.records.entries()) {
    try {
      object(row);
      requireValue(
        Object.keys(row).sort().join(',') === 'data,table' &&
          Object.hasOwn(backupTables, row.table),
      );
      const data = object(row.data),
        columns: readonly string[] = backupTables[row.table].columns;
      requireValue(Object.keys(data).sort().join(',') === [...columns].sort().join(','));
      for (const column of columns)
        if (column !== 'payload') {
          string(data[column]);
          const accountIncome =
            row.table === 'history_raw' &&
            data.kind === 'income' &&
            column === 'symbol' &&
            data.symbol === '';
          if (column !== 'opened_at' && !accountIncome) id(data[column]);
        }
      safeContent(data.payload, scope);
      payload(row, scope);
      const key = recordKey(row);
      requireValue(!identities.has(key));
      identities.add(key);
      normalizeImported(row);
      validRecords.push(row);
    } catch {
      rejected.push('第 ' + (index + 1) + ' 条备份记录格式、身份、关联或版本无效。');
    }
  }
  backup.records = validRecords;
  const planIds = new Set(
    validRecords.filter((row) => row.table === 'review_plans').map((row) => row.data.id),
  );
  for (const row of validRecords)
    if (row.table === 'review_verifications' && !planIds.has(row.data.plan_id))
      rejected.push('备份核验缺少对应原方案。');
  return { backup, rejected };
}
