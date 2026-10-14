import type { ReviewLedger } from './review-ledger.ts';
import type { ReviewFilters } from './review-filters.ts';
import { entryTypeLabel } from './review-filters.ts';
import { noteBelongsTo } from './review-notes.ts';

function cell(value: string, numeric = false): string {
  const safe = !numeric && /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
function time(value: string | null): string {
  return value === null ? '待确认' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
export function reviewCsv(ledger: ReviewLedger, filters: ReviewFilters): string {
  const header = ['交易ID', '交易对', '方向', '记录状态', '开仓时间（北京时间）', '平仓时间（北京时间）', '已实现盈亏（USDT）', '手续费（USDT）', '资金费净收支（USDT）', '净盈亏（USDT）', '入场类型', '持仓时长（毫秒）', '归并版本', '方案关联', '缺失项', '风格标签', '入场理由', '退出理由（用户自述）', '执行问题', '改进事项', '自由笔记'];
  const journal = ledger.journal(), lines = [header.map((value) => cell(value)).join(',')];
  for (const trade of ledger.list(filters)) {
    const current = ledger.get(trade.id)!;
    const note = journal.notes.find((item) => noteBelongsTo(item, current));
    const values = [trade.id, trade.symbol, trade.side === null ? '待确认' : trade.side === 'long' ? '做多' : '做空',
      trade.status === 'closed' ? '已结束' : trade.status === 'open' ? '持仓中' : '数据不完整',
      time(trade.openedAt), trade.closedAt === null && trade.status === 'open' ? '持仓中' : time(trade.closedAt),
      trade.realizedPnl ?? '待确认', trade.commission ?? '待确认', trade.fundingNet ?? '待确认', trade.netPnl ?? '待确认',
      entryTypeLabel(trade.entryType), trade.durationMs === null ? '待确认' : String(trade.durationMs), String(trade.groupingVersion),
      trade.planLink?.status === 'linked' ? '已关联' : '未确认', trade.missing.join('；'),
      trade.tagIds.map((id) => journal.tags.find((tag) => tag.id === id)?.name ?? '未知标签').join('；'),
      note?.entryReason ?? '', note?.exitReason ?? '', note?.executionProblem ?? '', note?.improvement ?? '', note?.freeNote ?? ''];
    lines.push(values.map((value, index) => cell(value, index >= 6 && index <= 9)).join(','));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
