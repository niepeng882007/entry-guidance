import { randomUUID } from 'node:crypto';
import { noteBasis, noteBelongsTo, noteInput, tagInput, ReviewWriteError, type ReviewJournal, type ReviewNote, type StyleTag } from './review-notes.ts';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { formatDecimal, parseDecimal } from '../public/draft.js';

export type ReviewIdentity = { source: 'demo' | 'binance'; accountId: string };
export type ReviewOrder = {
  id: string; symbol: string; side: 'BUY' | 'SELL'; type: string | null;
  quantity: string; time: string; algoId?: string;
};
export type ReviewFill = {
  id: string; orderId: string; symbol: string; side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT'; quantity: string; price: string; time: string;
  realizedPnl: string | null; commission: string | null; commissionAsset: string | null;
  allocation?: 'close' | 'open';
  event?: 'entry' | 'add' | 'reduce' | 'exit';
};
export type ReviewFunding = { id: string; symbol: string; time: string; amount: string | null; asset: string | null; attribution?: 'confirmed' | 'ambiguous' };
export type TradeEvidence = {
  symbol: string; baseAsset: string; startPosition: string | null; endPosition: string | null;
  fillsComplete: boolean; fundingComplete: boolean;
  orders: ReviewOrder[]; fills: ReviewFill[]; funding: ReviewFunding[];
  raw?: RawRecord[];
};
export type ReviewTrade = ReviewIdentity & {
  id: string; groupingVersion: number; symbol: string; baseAsset: string;
  side: 'long' | 'short' | null; status: 'closed' | 'open' | 'incomplete'; openedAt: string | null; closedAt: string | null;
  realizedPnl: string | null; commission: string | null; fundingNet: string | null;
  netPnl: string | null; missing: string[]; evidence: TradeEvidence;
  observedAt?: string; unrealizedPnl?: string | null; unrealizedAt?: string | null;
  exitReason?: 'LIQUIDATION' | 'ADL' | 'unknown';
  noteBasis?: string;
};
export type ReviewSummary = Omit<ReviewTrade, 'evidence'>;
export type HistorySource = 'trades' | 'history' | 'algoHistory' | 'income' | 'forceOrders';
export type HistoryPage = { source: HistorySource; startTime: number; endTime: number; page: number; autoCloseType?: 'LIQUIDATION' | 'ADL'; fingerprint?: string };
export type RawRecord = { kind: HistorySource | 'position'; id: string; time: number; payload: Record<string, unknown> };
export type SyncState = {
  symbol: string; startTime: number; endTime: number; status: 'running' | 'complete' | 'failed' | 'interrupted';
  pages: number; records: number; pending: HistoryPage[]; completed: HistoryPage[];
  unavailable?: HistoryPage[];
  attemptedAt?: string;
  missing: string[]; lastSuccessAt: string | null;
};
export type ReviewList = { source: ReviewIdentity['source']; accountId: string | null; syncStatus: 'demo' | 'not-synced' | 'synced'; trades: ReviewSummary[]; sync?: SyncState | null };

function signed(value: string, label: string) {
  return parseDecimal(value.startsWith('-') ? value.slice(1) : value, label) * (value.startsWith('-') ? -1n : 1n);
}

function summarize(identity: ReviewIdentity, evidence: TradeEvidence): ReviewTrade {
  const { fills, orders, funding } = evidence;
  if (evidence.symbol !== `${evidence.baseAsset}USDT` || !/^[A-Z0-9]+$/.test(evidence.baseAsset) || evidence.startPosition !== '0' || evidence.endPosition !== '0' || fills.length < 2) throw new Error('仅接受有空仓起点与终点证据的单向交易。');
  const first = fills[0]!;
  const last = fills.at(-1)!;
  let position = 0n, realized = 0n, commission = 0n, fundingNet = 0n;
  const missing = new Set<string>();
  if (!evidence.fillsComplete) missing.add('成交区间未确认完整');
  if (!evidence.fundingComplete) missing.add('资金费区间未确认完整');
  const validTime = (value: string) => Number.isFinite(Date.parse(value));
  const unique = (items: { id: string }[]) => items.every((item) => item.id.length > 0) && new Set(items.map((item) => item.id)).size === items.length;
  if (![fills, orders, funding].every(unique)) throw new Error('原始记录身份缺失或重复。');
  for (const order of orders) {
    if (order.symbol !== evidence.symbol || !['BUY', 'SELL'].includes(order.side) || ![null, 'LIMIT', 'MARKET'].includes(order.type) || !validTime(order.time) || parseDecimal(order.quantity, '订单数量') <= 0n) throw new Error('订单证据无效。');
  }
  for (let index = 0; index < fills.length; index++) {
    const fill = fills[index]!;
    const order = orders.find((item) => item.id === fill.orderId);
    if (!order || order.symbol !== fill.symbol || order.side !== fill.side || fill.symbol !== evidence.symbol || fill.positionSide !== 'BOTH' || !validTime(fill.time) || (index > 0 && Date.parse(fill.time) < Date.parse(fills[index - 1]!.time))) throw new Error('成交与订单关联或时间无效。');
    const quantity = parseDecimal(fill.quantity, '成交数量');
    if (quantity <= 0n || parseDecimal(fill.price, '成交价格') <= 0n) throw new Error('成交数量与价格须为正数。');
    position += quantity * (fill.side === 'BUY' ? 1n : -1n);
    if ((first.side === 'BUY' ? position < 0n : position > 0n) || (position === 0n && index < fills.length - 1)) throw new Error('本轮仅归档单个无反手交易周期。');
    if (fill.realizedPnl === null) missing.add('已实现盈亏缺失');
    else realized += signed(fill.realizedPnl, '已实现盈亏');
    if (fill.commission !== null) {
      const cost = parseDecimal(fill.commission, '手续费');
      if (fill.commissionAsset === 'USDT') commission += cost;
    }
    if (fill.commission === null || fill.commissionAsset !== 'USDT') missing.add('手续费缺失或非 USDT，缺少可靠换算');
  }
  if (position !== 0n) throw new Error('成交链未回到空仓。');
  for (const order of orders) {
    const total = fills.filter((fill) => fill.orderId === order.id).reduce((sum, fill) => sum + parseDecimal(fill.quantity, '成交数量'), 0n);
    if (total !== parseDecimal(order.quantity, '订单数量')) throw new Error('订单数量与成交数量不一致。');
  }
  for (const fee of funding) {
    if (fee.symbol !== evidence.symbol || !validTime(fee.time) || Date.parse(fee.time) < Date.parse(first.time) || Date.parse(fee.time) > Date.parse(last.time)) throw new Error('资金费与交易关联无效。');
    if (fee.amount !== null) {
      const income = signed(fee.amount, '资金费');
      if (fee.asset === 'USDT') fundingNet += income;
    }
    if (fee.amount === null || fee.asset !== 'USDT') missing.add('资金费缺失或非 USDT，归属待确认');
  }
  const realizedPnl = fills.some((fill) => fill.realizedPnl === null) ? null : formatDecimal(realized);
  const commissionAmount = fills.some((fill) => fill.commission === null || fill.commissionAsset !== 'USDT') ? null : formatDecimal(commission);
  const fundingAmount = !evidence.fundingComplete || funding.some((fee) => fee.amount === null || fee.asset !== 'USDT') ? null : formatDecimal(fundingNet);
  return {
    ...identity, id: `${evidence.symbol}-${first.id}`, groupingVersion: 1,
    symbol: evidence.symbol, baseAsset: evidence.baseAsset, side: first.side === 'BUY' ? 'long' : 'short',
    status: missing.size ? 'incomplete' : 'closed', openedAt: new Date(first.time).toISOString(), closedAt: new Date(last.time).toISOString(),
    realizedPnl, commission: commissionAmount, fundingNet: fundingAmount,
    netPnl: missing.size ? null : formatDecimal(realized - commission + fundingNet),
    missing: [...missing], evidence,
  };
}

export class ReviewLedger {
  private db: DatabaseSync;
  private identity: ReviewIdentity;

  constructor(path: string, identity: ReviewIdentity) {
    if (!identity.accountId.trim() || !['demo', 'binance'].includes(identity.source)) throw new Error('账本需明确来源与账户身份。');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.identity = { ...identity };
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS review_notes (
          source TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (source, account, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS style_tags (
          source TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (source, account, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS evidence (
          source TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL,
          kind TEXT NOT NULL, id TEXT NOT NULL, trade_id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (source, account, symbol, kind, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS trades (
          source TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL,
          opened_at TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (source, account, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS history_raw (
          source TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL,
          kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (source, account, symbol, kind, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS history_sync (
          source TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (source, account, symbol)
        ) STRICT;
      `);
    } catch (error) { this.db.close(); throw error; }
  }

  archive(evidence: TradeEvidence) {
    const trade = summarize(this.identity, evidence);
    const { source, accountId } = this.identity;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [kind, records] of [['order', evidence.orders], ['fill', evidence.fills], ['funding', evidence.funding]] as const) {
        for (const record of records) {
          const payload = JSON.stringify(record);
          const existing = this.db.prepare('SELECT payload, trade_id FROM evidence WHERE source=? AND account=? AND symbol=? AND kind=? AND id=?').get(source, accountId, evidence.symbol, kind, record.id);
          if (existing && (existing.payload !== payload || existing.trade_id !== trade.id)) throw new Error('来源记录冲突，保留已有账本。');
          this.db.prepare('INSERT OR IGNORE INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?)').run(source, accountId, evidence.symbol, kind, record.id, trade.id, payload);
        }
      }
      const payload = JSON.stringify(trade);
      const existing = this.db.prepare('SELECT payload FROM trades WHERE source=? AND account=? AND id=?').get(source, accountId, trade.id);
      if (existing && existing.payload !== payload) throw new Error('交易归并冲突，保留已有账本。');
      this.db.prepare('INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?)').run(source, accountId, trade.id, trade.openedAt!, payload);
      this.db.exec('COMMIT');
      return trade.id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  list(): ReviewSummary[] {
    return this.db.prepare('SELECT payload FROM trades WHERE source=? AND account=? ORDER BY opened_at DESC, id').all(this.identity.source, this.identity.accountId).map((row) => {
      const { evidence: _evidence, ...summary } = JSON.parse(String(row.payload)) as ReviewTrade;
      return summary;
    });
  }

  get(id: string): ReviewTrade | null {
    const row = this.db.prepare('SELECT payload FROM trades WHERE source=? AND account=? AND id=?').get(this.identity.source, this.identity.accountId, id);
    if (!row) return null;
    const trade = JSON.parse(String(row.payload)) as ReviewTrade;
    return { ...trade, noteBasis: noteBasis(trade) };
  }

  journal(): ReviewJournal {
    const { source, accountId } = this.identity;
    const tags = this.db.prepare('SELECT payload FROM style_tags WHERE source=? AND account=? ORDER BY id').all(source, accountId).map((row) => JSON.parse(String(row.payload)) as StyleTag);
    const notes = this.db.prepare('SELECT payload FROM review_notes WHERE source=? AND account=? ORDER BY id').all(source, accountId).map((row) => {
      const note = JSON.parse(String(row.payload)) as ReviewNote;
      return { ...note, binding: noteBelongsTo(note, this.get(note.trade.id)) ? 'current' as const : 'pending' as const };
    });
    return { ...this.identity, notes, tags };
  }

  saveNote(tradeId: string, value: unknown): ReviewJournal {
    const input = noteInput(value);
    const { source, accountId } = this.identity;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const trade = this.get(tradeId);
      if (!trade) throw new ReviewWriteError(404, '未找到该来源的归档交易。');
      if (trade.noteBasis !== input.basis) throw new ReviewWriteError(409, '交易依据已变化，请重新读取；当前输入保留。');
      const journal = this.journal();
      const previous = input.noteId === null ? undefined : journal.notes.find((note) => note.id === input.noteId);
      if (input.noteId !== null && (!previous || previous.trade.id !== tradeId)) throw new ReviewWriteError(404, '未找到该账户的笔记。');
      if (previous && (previous.version !== input.version || previous.binding !== 'current') || !previous && journal.notes.some((note) => note.trade.id === tradeId && note.binding === 'current')) throw new ReviewWriteError(409, '笔记已被更新或归属已变化，请重新读取；当前输入保留。');
      for (const id of input.tagIds) {
        const tag = journal.tags.find((tag) => tag.id === id);
        if (!tag || !tag.active && !previous?.tagIds.includes(id)) throw new ReviewWriteError(400, '标签不存在或已停用；当前输入保留。');
      }
      const { noteId: _id, basis: _basis, version, ...content } = input;
      const note: ReviewNote = { ...content, id: previous?.id ?? randomUUID(), version: version + 1, updatedAt: new Date().toISOString(), trade, binding: 'current' };
      this.db.prepare('INSERT INTO review_notes VALUES (?, ?, ?, ?) ON CONFLICT(source, account, id) DO UPDATE SET payload=excluded.payload').run(source, accountId, note.id, JSON.stringify(note));
      this.db.exec('COMMIT');
      return this.journal();
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  saveTag(value: unknown): ReviewJournal {
    const input = tagInput(value);
    const { source, accountId } = this.identity;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { tags } = this.journal();
      const previous = input.id === null ? undefined : tags.find((tag) => tag.id === input.id);
      if (input.id !== null && !previous) throw new ReviewWriteError(404, '未找到该账户的标签。');
      if (previous && previous.version !== input.version) throw new ReviewWriteError(409, '标签已被其他设备更新，请重新读取；当前输入保留。');
      if (tags.some((tag) => tag.id !== input.id && tag.name === input.name)) throw new ReviewWriteError(409, '同名标签已存在，请使用已有标签。');
      if (!previous && tags.length >= 100) throw new ReviewWriteError(400, '标签最多 100 个，请维护已有标签。');
      const tag: StyleTag = { ...input, id: previous?.id ?? randomUUID(), version: input.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO style_tags VALUES (?, ?, ?, ?) ON CONFLICT(source, account, id) DO UPDATE SET payload=excluded.payload').run(source, accountId, tag.id, JSON.stringify(tag));
      this.db.exec('COMMIT');
      return this.journal();
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  sync(symbol?: string): SyncState | null {
    const rows = this.db.prepare('SELECT payload FROM history_sync WHERE source=? AND account=?').all(this.identity.source, this.identity.accountId);
    const states = rows.map((row) => JSON.parse(String(row.payload)) as SyncState).filter((state) => !symbol || state.symbol === symbol);
    return states.sort((a, b) => (b.attemptedAt ? Date.parse(b.attemptedAt) : b.endTime) - (a.attemptedAt ? Date.parse(a.attemptedAt) : a.endTime))[0] ?? null;
  }

  raw(symbol: string): RawRecord[] {
    return this.db.prepare('SELECT payload FROM history_raw WHERE source=? AND account=? AND symbol=?').all(this.identity.source, this.identity.accountId, symbol).map((row) => JSON.parse(String(row.payload)) as RawRecord);
  }

  saveSync(state: SyncState, records: RawRecord[] = []) {
    const { source, accountId } = this.identity;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        const existing = this.db.prepare('SELECT payload FROM history_raw WHERE source=? AND account=? AND symbol=? AND kind=? AND id=?').get(source, accountId, state.symbol, record.kind, record.id);
        if (existing && ['trades', 'income'].includes(record.kind)) {
          const previous = JSON.parse(String(existing.payload)) as RawRecord;
          const fields = record.kind === 'trades' ? ['symbol', 'id', 'orderId', 'side', 'positionSide', 'qty', 'price', 'time', 'realizedPnl', 'commission', 'commissionAsset'] : ['symbol', 'tranId', 'incomeType', 'time', 'income', 'asset', 'tradeId'];
          const enrichable = record.kind === 'trades' ? ['realizedPnl', 'commission', 'commissionAsset'] : ['income', 'asset', 'tradeId'];
          if (fields.some((field) => {
            const before = previous.payload[field], after = record.payload[field];
            if (enrichable.includes(field) && (before === null || before === undefined || (field === 'tradeId' && before === ''))) return false;
            return ['id', 'orderId', 'tranId', 'tradeId'].includes(field) ? String(before) !== String(after) : before !== after;
          })) throw new Error('来源事实冲突，保留已有账本。');
        }
        this.db.prepare('INSERT INTO history_raw VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, account, symbol, kind, id) DO UPDATE SET payload=excluded.payload').run(source, accountId, state.symbol, record.kind, record.id, JSON.stringify(record));
      }
      this.db.prepare('INSERT INTO history_sync VALUES (?, ?, ?, ?) ON CONFLICT(source, account, symbol) DO UPDATE SET payload=excluded.payload').run(source, accountId, state.symbol, JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  project(symbol: string, trades: ReviewTrade[]) {
    const { source, accountId } = this.identity;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.list().filter((trade) => trade.symbol === symbol)) this.db.prepare('DELETE FROM trades WHERE source=? AND account=? AND id=?').run(source, accountId, row.id);
      for (const trade of trades) {
        if (trade.source !== source || trade.accountId !== accountId || trade.symbol !== symbol) throw new Error('交易投影身份不一致。');
        this.db.prepare('INSERT INTO trades VALUES (?, ?, ?, ?, ?)').run(source, accountId, trade.id, trade.openedAt ?? trade.evidence.fills[0]?.time ?? '', JSON.stringify(trade));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() { this.db.close(); }
}

export function demoTrade(): TradeEvidence {
  const symbol = 'BTCUSDT';
  return {
    symbol, baseAsset: 'BTC', startPosition: '0', endPosition: '0', fillsComplete: true, fundingComplete: true,
    orders: [
      { id: 'demo-order-1', symbol, side: 'BUY', type: 'LIMIT', quantity: '0.01', time: '2026-10-10T00:00:00Z' },
      { id: 'demo-order-2', symbol, side: 'SELL', type: 'MARKET', quantity: '0.004', time: '2026-10-10T10:00:00Z' },
      { id: 'demo-order-3', symbol, side: 'SELL', type: null, quantity: '0.006', time: '2026-10-10T12:00:00Z' },
    ],
    fills: [
      { id: 'demo-fill-1', orderId: 'demo-order-1', symbol, side: 'BUY', positionSide: 'BOTH', quantity: '0.004', price: '60000', time: '2026-10-10T00:00:01Z', realizedPnl: '0', commission: '0.12', commissionAsset: 'USDT' },
      { id: 'demo-fill-2', orderId: 'demo-order-1', symbol, side: 'BUY', positionSide: 'BOTH', quantity: '0.006', price: '60000', time: '2026-10-10T00:00:02Z', realizedPnl: '0', commission: '0.18', commissionAsset: 'USDT' },
      { id: 'demo-fill-3', orderId: 'demo-order-2', symbol, side: 'SELL', positionSide: 'BOTH', quantity: '0.004', price: '61000', time: '2026-10-10T10:00:01Z', realizedPnl: '4', commission: '0.122', commissionAsset: 'USDT' },
      { id: 'demo-fill-4', orderId: 'demo-order-3', symbol, side: 'SELL', positionSide: 'BOTH', quantity: '0.006', price: '61500', time: '2026-10-10T12:00:01Z', realizedPnl: '9', commission: '0.1845', commissionAsset: 'USDT' },
    ],
    funding: [
      { id: 'demo-funding-1', symbol, time: '2026-10-10T04:00:00Z', amount: '0.12', asset: 'USDT' },
      { id: 'demo-funding-2', symbol, time: '2026-10-10T08:00:00Z', amount: '-0.04', asset: 'USDT' },
    ],
  };
}
