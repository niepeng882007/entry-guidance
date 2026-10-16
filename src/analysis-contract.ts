import type { AnalysisTask } from './trade-analysis.ts';
import {
  AnalysisError,
  reportFields,
  validateReport,
  segmentSummaries,
  summaryCitations,
  type AnalysisReport,
} from './analysis-model.ts';

export function validateAnalysisTask(
  value: unknown,
  trade: { id: string; source: string; accountId: string },
): AnalysisTask {
  if (!value || typeof value !== 'object') throw new Error('分析任务格式无效。');
  const task = value as AnalysisTask;
  const batch = trade.id === '$batch';
  const frozenTrade = task.snapshot?.trade;
  if (
    task.source !== trade.source ||
    task.accountId !== trade.accountId ||
    task.tradeId !== trade.id ||
    typeof task.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(task.id) ||
    !['running', 'complete', 'failed', 'cancelled', 'interrupted'].includes(task.status) ||
    !task.snapshot ||
    (batch
      ? frozenTrade !== null ||
        !Array.isArray(task.snapshot.trades) ||
        !task.snapshot.trades.length ||
        task.snapshot.trades.length > 100
      : !frozenTrade ||
        frozenTrade.source !== trade.source ||
        frozenTrade.id !== trade.id ||
        frozenTrade.accountId !== trade.accountId ||
        task.snapshot.trades !== undefined) ||
    !Array.isArray(task.snapshot.missing) ||
    task.snapshot.missing.some((item) => typeof item !== 'string') ||
    !Array.isArray(task.records) ||
    !task.records.length ||
    new Set(task.records.map((row) => row.id)).size !== task.records.length ||
    task.records.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        typeof row.path !== 'string' ||
        !['fact', 'user'].includes(row.kind) ||
        typeof row.tradeId !== 'string' ||
        !(
          row.time === null ||
          (typeof row.time === 'string' && Number.isFinite(Date.parse(row.time)))
        ),
    ) ||
    !Array.isArray(task.requests) ||
    !task.requests.length ||
    new Set(task.requests.map((row) => row.id)).size !== task.requests.length ||
    !task.snapshot.statistics ||
    task.snapshot.statistics.source !== trade.source ||
    task.snapshot.statistics.accountId !== trade.accountId ||
    !Array.isArray(task.snapshot.notes) ||
    !Array.isArray(task.snapshot.markets) ||
    !Number.isFinite(Date.parse(task.snapshot.frozenAt)) ||
    !task.capacity ||
    task.capacity.model !== 'deepseek-v4-pro' ||
    task.capacity.provider !== 'deepseek' ||
    task.capacity.effort !== 'high' ||
    !Number.isSafeInteger(task.capacity.contextWindow) ||
    !Number.isSafeInteger(task.capacity.maxOutputTokens) ||
    task.capacity.maxOutputTokens <= 0 ||
    task.capacity.contextWindow <= task.capacity.maxOutputTokens ||
    typeof task.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(task.fingerprint) ||
    !(task.error === null || typeof task.error === 'string')
  )
    throw new Error('分析来源、交易或结构无效。');
  if (batch) {
    const selected = task.snapshot.trades!;
    const ids = new Set(selected.map((row) => row.id));
    if (
      ids.size !== selected.length ||
      selected.some(
        (row) =>
          !row ||
          typeof row.id !== 'string' ||
          row.source !== trade.source ||
          row.accountId !== trade.accountId,
      ) ||
      task.snapshot.statistics.total !== selected.length ||
      task.snapshot.statistics.trades.length !== selected.length ||
      new Set(task.snapshot.statistics.trades.map((row) => row.id)).size !== ids.size ||
      task.snapshot.statistics.trades.some((row) => !ids.has(row.id)) ||
      selected.some(
        (trade, index) =>
          !task.records.some(
            (row) =>
              row.tradeId === trade.id &&
              row.path === `/trades/${index}/trade/id` &&
              row.value === trade.id,
          ),
      ) ||
      !Array.isArray(task.snapshot.coverage) ||
      task.snapshot.coverage.length !== selected.length ||
      new Set(task.snapshot.coverage.map((row) => row.tradeId)).size !== ids.size ||
      task.snapshot.coverage.some(
        (row) =>
          !ids.has(row.tradeId) ||
          !Array.isArray(row.missing) ||
          row.missing.some((item) => typeof item !== 'string'),
      ) ||
      task.snapshot.notes.some((row) => !row.tradeId || !ids.has(row.tradeId)) ||
      task.snapshot.markets.some((row) => !ids.has(row.tradeId))
    )
      throw new Error('批量分析交易范围或证据覆盖无效。');
  }
  const records = new Map(task.records.map((row) => [row.id, row]));
  const complete = new Map<string, AnalysisTask['requests'][number]>();
  for (const request of task.requests) {
    if (
      !request ||
      typeof request.id !== 'string' ||
      !['evidence', 'synthesis'].includes(request.stage) ||
      !['pending', 'running', 'complete', 'failed'].includes(request.status) ||
      !Array.isArray(request.records) ||
      !Array.isArray(request.segments) ||
      !Array.isArray(request.attempts) ||
      request.attempts.some(
        (attempt) =>
          !attempt ||
          !['running', 'complete', 'failed', 'cancelled', 'interrupted'].includes(attempt.status) ||
          (attempt.usage !== null &&
            (!Number.isSafeInteger(attempt.usage.inputTokens) ||
              attempt.usage.inputTokens < 0 ||
              !Number.isSafeInteger(attempt.usage.outputTokens) ||
              attempt.usage.outputTokens < 0 ||
              attempt.usage.totalTokens !==
                attempt.usage.inputTokens + attempt.usage.outputTokens)),
      ) ||
      (request.stage === 'evidence'
        ? !request.records.length || request.segments.length !== 0
        : request.records.length !== 0 || request.segments.length === 0) ||
      request.records.some((row) => JSON.stringify(records.get(row.id)) !== JSON.stringify(row)) ||
      request.segments.some((id) => !complete.has(id))
    )
      throw new Error('分析分段覆盖无效。');
    if (
      request.usage !== null &&
      (!Number.isSafeInteger(request.usage.inputTokens) ||
        !Number.isSafeInteger(request.usage.outputTokens) ||
        request.usage.inputTokens < 0 ||
        request.usage.outputTokens < 0 ||
        request.usage.totalTokens !== request.usage.inputTokens + request.usage.outputTokens)
    )
      throw new Error('分析用量无效。');
    if (request.report)
      validateReport(
        request.report,
        [
          ...request.records,
          ...summaryCitations(segmentSummaries(request.segments.map((id) => complete.get(id)!))),
        ],
        task.snapshot.trades?.map((row) => row.id) ?? [task.tradeId],
      );
    if (request.status === 'complete') {
      if (!request.report) throw new Error('分段结果缺失。');
      complete.set(request.id, request);
    }
  }
  const leaves = task.requests
    .filter((row) => row.stage === 'evidence')
    .flatMap((row) => row.records.map((record) => record.id));
  const coverage = new Set(leaves);
  if (leaves.length !== coverage.size || task.records.some((row) => !coverage.has(row.id)))
    throw new Error('分析证据覆盖不完整或重复。');
  if (task.status === 'complete') {
    const consumed = new Set(task.requests.flatMap((row) => row.segments));
    const roots = task.requests.filter((row) => !consumed.has(row.id));
    const covered = new Set(
      task.requests
        .filter((row) => row.stage === 'evidence')
        .flatMap((row) => row.records.map((record) => record.id)),
    );
    if (
      task.requests.some((row) => row.status !== 'complete') ||
      task.records.some((row) => !covered.has(row.id)) ||
      roots.length !== 1 ||
      (batch && roots[0]?.stage !== 'synthesis') ||
      !task.report ||
      JSON.stringify(task.report) !== JSON.stringify(roots[0]!.report)
    )
      throw new Error('整体分析尚未完整。');
    validateBatchReport(task, task.report);
  } else if (task.report !== null) throw new Error('未完成任务不能显示完整报告。');
  return task;
}

// A whole segment does not identify which trade or metric supports a batch conclusion.
export function validateBatchReport(task: AnalysisTask, report: AnalysisReport) {
  if (task.tradeId !== '$batch') return;
  const tradeIds = new Set(task.snapshot.trades!.map((trade) => trade.id));
  const anchors = new Map(
    task.records.map((record) => [
      record.id,
      tradeIds.has(record.tradeId) ||
        /^\/statistics\/(pnl|duration|curve|groups|trades|total)(?:\/|$)/.test(record.path),
    ]),
  );
  for (const request of task.requests) {
    if (request.status !== 'complete') continue;
    const summary = segmentSummaries([request])[0]!;
    for (const field of reportFields)
      for (const item of summary.report[field])
        anchors.set(
          item.id,
          item.refs.some((ref) => anchors.get(ref) === true),
        );
    for (const item of summary.styleSuggestions)
      anchors.set(
        item.id,
        item.refs.some((ref) => anchors.get(ref) === true),
      );
  }
  for (const field of reportFields)
    for (const item of report[field])
      if (!item.refs.some((ref) => anchors.get(ref) === true))
        throw new AnalysisError(
          '批量结论必须引用可追溯到具体交易或统计分组的分段条目，不能只引用整个分段。',
        );
}
