import { createHash } from 'node:crypto';
import type { ReviewFill, ReviewIdentity, ReviewTrade } from './review-ledger.ts';

export type StyleTag = {
  id: string;
  name: string;
  active: boolean;
  version: number;
  updatedAt: string;
};
export type NoteContent = {
  entryReason: string;
  exitReason: string;
  executionProblem: string;
  improvement: string;
  freeNote: string;
  tagIds: string[];
};
export type ReviewNote = NoteContent & {
  id: string;
  version: number;
  updatedAt: string;
  trade: ReviewTrade;
  binding: 'current' | 'pending';
};
export type ReviewJournal = ReviewIdentity & { notes: ReviewNote[]; tags: StyleTag[] };
export type NoteInput = NoteContent & { noteId: string | null; version: number; basis: string };
export type TagInput = { id: string | null; version: number; name: string; active: boolean };
export class ReviewWriteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const fields = [
  'entryReason',
  'exitReason',
  'executionProblem',
  'improvement',
  'freeNote',
] as const;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ReviewWriteError(400, '个人记录字段格式无效。');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= limit &&
    // eslint-disable-next-line no-control-regex -- Retain tabs and newlines; reject other controls.
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}
function identity(id: unknown, version: unknown) {
  if (
    (id !== null && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) ||
    !Number.isSafeInteger(version) ||
    Number(version) < 0 ||
    (id === null ? version !== 0 : Number(version) < 1)
  )
    throw new ReviewWriteError(400, '个人记录身份或版本无效。');
}
export function noteInput(value: unknown): NoteInput {
  const data = record(value, [...fields, 'noteId', 'version', 'basis', 'tagIds']);
  identity(data.noteId, data.version);
  if (
    typeof data.basis !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.basis) ||
    fields.some((key) => !text(data[key], key === 'freeNote' ? 10000 : 2000)) ||
    !Array.isArray(data.tagIds) ||
    data.tagIds.length > 20 ||
    data.tagIds.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) ||
    new Set(data.tagIds).size !== data.tagIds.length
  )
    throw new ReviewWriteError(400, '笔记长度、标签或交易依据无效。');
  return data as NoteInput;
}
export function tagInput(value: unknown): TagInput {
  const data = record(value, ['id', 'version', 'name', 'active']);
  identity(data.id, data.version);
  if (
    !text(data.name, 40) ||
    !data.name.trim() ||
    /[\r\n\t]/.test(data.name) ||
    typeof data.active !== 'boolean' ||
    (data.id === null && !data.active)
  )
    throw new ReviewWriteError(400, '标签须为 1–40 字的单行名称。');
  return { ...data, name: data.name.trim() } as TagInput;
}
function fillKey(fill: ReviewFill) {
  return JSON.stringify([fill.id, fill.positionSide, fill.allocation ?? null]);
}
function fillBasis(fill: ReviewFill) {
  return JSON.stringify([
    fillKey(fill),
    fill.orderId,
    fill.side,
    fill.quantity,
    fill.price,
    fill.time,
  ]);
}
export function noteBasis(trade: ReviewTrade) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        trade.source,
        trade.accountId,
        trade.id,
        trade.symbol,
        trade.side,
        trade.openedAt,
        trade.evidence.fills.map(fillBasis),
      ]),
    )
    .digest('hex');
}
export function noteBelongsTo(note: ReviewNote, current: ReviewTrade | null) {
  const old = note.trade;
  // Reversal allocations share a raw fill ID; compare the allocation and quantity too.
  return (
    !!current &&
    old.source === current.source &&
    old.accountId === current.accountId &&
    old.id === current.id &&
    old.symbol === current.symbol &&
    (old.side === null || old.side === current.side) &&
    (old.openedAt === null || old.openedAt === current.openedAt) &&
    old.evidence.fills.length > 0 &&
    current.evidence.fills.length > 0 &&
    fillBasis(old.evidence.fills[0]!) === fillBasis(current.evidence.fills[0]!) &&
    old.evidence.fills.every((fill) =>
      current.evidence.fills.some((next) => fillBasis(fill) === fillBasis(next)),
    )
  );
}
