import { createHash, randomUUID } from 'node:crypto';
import type { ReviewLedger, ReviewIdentity, ReviewTrade } from './review-ledger.ts';
import { reviewStatistics, type StatisticsSnapshot } from './review-statistics.ts';
import { marketIntervals, type MarketArchive } from './trade-market.ts';
import {
  AnalysisError,
  configuredModel,
  modelCapacity,
  callModel,
  modelRequest,
  modelUsage,
  validateReport,
  segmentSummaries,
  summaryCitations,
  type ModelConfig,
  type ModelCapacity,
  type ModelUsage,
  type AnalysisReport,
  type EvidenceRecord,
} from './analysis-model.ts';
import type { ReviewFilters } from './review-filters.ts';
import { validateBatchReport } from './analysis-contract.ts';

export type AnalysisSnapshot = {
  trade: ReviewTrade | null;
  trades?: ReviewTrade[];
  coverage?: { tradeId: string; missing: string[] }[];
  notes: {
    tradeId?: string;
    id: string;
    version: number;
    updatedAt: string;
    entryReason: string;
    exitReason: string;
    executionProblem: string;
    improvement: string;
    freeNote: string;
  }[];
  tags: { id: string; name: string }[];
  markets: MarketArchive[];
  statistics: StatisticsSnapshot;
  missing: string[];
  frozenAt: string;
};
export type AnalysisRequest = {
  id: string;
  stage: 'evidence' | 'synthesis';
  records: EvidenceRecord[];
  segments: string[];
  status: 'pending' | 'running' | 'complete' | 'failed';
  report: AnalysisReport | null;
  usage: ModelUsage | null;
  attempts: {
    usage: ModelUsage | null;
    status: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  }[];
};
export type AnalysisTask = ReviewIdentity & {
  id: string;
  tradeId: string;
  fingerprint: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  snapshot: AnalysisSnapshot;
  capacity: ModelCapacity;
  records: EvidenceRecord[];
  requests: AnalysisRequest[];
  report: AnalysisReport | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export const batchAnalysisId = '$batch';
function missingEvidence(trade: ReviewTrade, markets: MarketArchive[]) {
  const missing = [...trade.missing];
  for (const interval of Object.keys(marketIntervals)) {
    const market = markets.find((row) => row.interval === interval);
    if (!market) missing.push(`${interval} 行情未读取`);
    else
      for (const source of ['contract', 'mark'] as const)
        if (!market.series[source].complete) missing.push(`${interval} ${source} 行情不完整`);
  }
  if (trade.planComparison?.status !== 'linked')
    missing.push('没有唯一确认的原方案；不能判定违反计划');
  if (trade.status !== 'closed') missing.push('持仓中或记录不完整；最终表现不可判断');
  return missing;
}
function freeze(
  ledger: ReviewLedger,
  trade: ReviewTrade | null,
  filters: ReviewFilters,
  includeNotes: boolean,
): AnalysisSnapshot {
  const journal = ledger.journal();
  const selected = ledger.list(filters);
  if (!trade && (!selected.length || selected.length > 100))
    throw new AnalysisError(
      selected.length
        ? `当前筛选范围 ${selected.length} 笔，超过每次 100 笔上限；请缩小范围。`
        : '当前筛选范围没有交易。',
    );
  const trades = trade ? [trade] : selected.map((row) => ledger.get(row.id)!);
  const ids = new Set(trades.map((row) => row.id));
  const notes = journal.notes.filter(
    (note) => ids.has(note.trade.id) && note.binding === 'current',
  );
  const tagIds = new Set(notes.flatMap((note) => note.tagIds));
  const markets = trades.flatMap((row) => ledger.tradeMarkets(row.id));
  const coverage = trades.map((row) => ({
    tradeId: row.id,
    missing: missingEvidence(
      row,
      markets.filter((market) => market.tradeId === row.id),
    ),
  }));
  const missing = trade
    ? coverage[0]!.missing
    : [
        '批量表现按各指标有效样本计算；排除交易仅保留证据，不参与对应表现结论',
        '逐笔缺项见交易覆盖清单；未归档行情不补查；小样本规律仅为待验证观察',
      ];
  if (!includeNotes) missing.push('用户未允许发送笔记');
  return structuredClone({
    trade,
    ...(!trade ? { trades, coverage } : {}),
    notes: includeNotes
      ? notes.map(
          ({
            id,
            version,
            updatedAt,
            entryReason,
            exitReason,
            executionProblem,
            improvement,
            freeNote,
            trade: basis,
          }) => ({
            ...(!trade ? { tradeId: basis.id } : {}),
            id,
            version,
            updatedAt,
            entryReason,
            exitReason,
            executionProblem,
            improvement,
            freeNote,
          }),
        )
      : [],
    tags: journal.tags.filter((tag) => tagIds.has(tag.id)).map(({ id, name }) => ({ id, name })),
    markets,
    statistics: reviewStatistics(ledger.scope(), filters, selected, journal.tags),
    missing,
    frozenAt: new Date().toISOString(),
  });
}
function evidenceRecords(snapshot: AnalysisSnapshot): EvidenceRecord[] {
  // Explicitly remove internal account identifiers and arbitrary exchange payloads from model input.
  const { accountId: _statisticsAccount, ...statistics } = snapshot.statistics;
  const rawKeys = new Set([
    'symbol',
    'id',
    'orderId',
    'clientOrderId',
    'algoId',
    'clientAlgoId',
    'algoType',
    'orderType',
    'type',
    'origType',
    'status',
    'algoStatus',
    'side',
    'positionSide',
    'price',
    'avgPrice',
    'stopPrice',
    'triggerPrice',
    'origQty',
    'qty',
    'quantity',
    'executedQty',
    'cumQty',
    'cumQuote',
    'quoteQty',
    'realizedPnl',
    'commission',
    'commissionAsset',
    'income',
    'incomeType',
    'asset',
    'tranId',
    'tradeId',
    'buyer',
    'maker',
    'time',
    'updateTime',
    'bookTime',
    'createTime',
    'triggerTime',
    'actualOrderId',
    'actualPrice',
    'actualQty',
    'timeInForce',
    'workingType',
    'priceProtect',
    'closePosition',
    'reduceOnly',
    'activationPrice',
    'activatePrice',
    'priceRate',
    'callbackRate',
    'priceMatch',
    'selfTradePreventionMode',
    'goodTillDate',
    'autoCloseType',
    'positionAmt',
    'entryPrice',
    'breakEvenPrice',
    'markPrice',
    'unRealizedProfit',
    'unrealizedProfit',
    'liquidationPrice',
    'leverage',
    'marginType',
    'isolatedMargin',
    'notional',
  ]);
  function cleanTrade(value: ReviewTrade) {
    const { source: _source, accountId: _account, evidence, ...trade } = value;
    const { raw: _raw, ...knownEvidence } = evidence;
    const rawEvidence = (evidence.raw ?? [])
      .filter((row) => row.payload.symbol === undefined || row.payload.symbol === value.symbol)
      .map((row) => ({
        kind: row.kind,
        id: row.id,
        time: row.time,
        payload: Object.fromEntries(
          Object.entries(row.payload).filter(
            ([key, item]) =>
              rawKeys.has(key) &&
              (item === null || ['string', 'number', 'boolean'].includes(typeof item)),
          ),
        ),
      }));
    return { trade: { ...trade, evidence: knownEvidence }, rawEvidence };
  }
  const excluded = new Set(statistics.pnl.excluded.map((row) => row.tradeId));
  const selectedIds = new Set(snapshot.trades?.map((trade) => trade.id) ?? [snapshot.trade!.id]);
  const values = {
    ...(snapshot.trade
      ? cleanTrade(snapshot.trade)
      : {
          trades: snapshot.trades!.map((trade) => ({
            tradeId: trade.id,
            performanceEligible: !excluded.has(trade.id),
            ...cleanTrade(trade),
          })),
          coverage: snapshot.coverage,
        }),
    notes: snapshot.notes,
    tags: snapshot.tags,
    markets: snapshot.markets.map(
      ({ source: _s, accountId: _a, evidence: _e, cacheKey: _k, ...market }) => market,
    ),
    statistics,
    missing: snapshot.missing,
  };
  const records: EvidenceRecord[] = [];
  function visit(
    value: unknown,
    path: string,
    tradeId = snapshot.trade?.id ?? '$scope',
    time: string | null = snapshot.trade?.openedAt ?? null,
  ) {
    if (value && typeof value === 'object' && Object.keys(value).length) {
      const row = value as Record<string, unknown>;
      if (typeof row.tradeId === 'string' && selectedIds.has(row.tradeId)) tradeId = row.tradeId;
      else if (path.startsWith('/statistics/trades/') && typeof row.id === 'string')
        tradeId = row.id;
      if (typeof row.time === 'string') time = row.time;
      else if (typeof row.time === 'number') time = new Date(row.time).toISOString();
      else if (typeof row.openTime === 'number') time = new Date(row.openTime).toISOString();
      else if (typeof row.queriedAt === 'string') time = row.queriedAt;
      else if (typeof row.openedAt === 'string') time = row.openedAt;
      else if (typeof row.updatedAt === 'string') time = row.updatedAt;
      for (const [key, item] of Object.entries(value)) {
        if (['account', 'accountId', 'reviewAccountId', 'raw'].includes(key)) continue;
        visit(item, `${path}/${key}`, tradeId, time);
      }
    } else
      records.push({
        ...(!snapshot.trade && selectedIds.has(tradeId)
          ? { pnlEligible: !excluded.has(tradeId) }
          : {}),
        id: `e${records.length + 1}`,
        path,
        kind: path.startsWith('/notes/') || path.startsWith('/tags/') ? 'user' : 'fact',
        tradeId,
        time,
        value,
      });
  }
  visit(values, '');
  return records;
}
export class TradeAnalysis {
  private running = new Map<
    string,
    { controller: AbortController; work: Promise<void>; task: AnalysisTask }
  >();
  private stopping = false;
  private lifetime = new AbortController();
  private ledger: ReviewLedger;
  private config?: ModelConfig;
  constructor(ledger: ReviewLedger, config?: ModelConfig) {
    this.ledger = ledger;
    this.config = config;
    for (const task of ledger.analyses())
      if (task.status === 'running') {
        task.status = 'interrupted';
        task.error = '服务中断；已完成分段保留，继续由用户发起。';
        for (const request of task.requests)
          if (request.status === 'running') {
            request.status = 'failed';
            const attempt = request.attempts.at(-1);
            if (attempt) attempt.status = 'interrupted';
          }
        this.save(task);
      }
  }
  list(tradeId: string) {
    return this.ledger.analyses(tradeId);
  }
  private save(task: AnalysisTask) {
    task.updatedAt = new Date().toISOString();
    this.ledger.saveAnalysis(task);
  }
  async start(
    trade: ReviewTrade | null,
    filters: ReviewFilters,
    includeNotes: boolean,
    regenerate: boolean,
    authorized: () => boolean,
  ): Promise<AnalysisTask> {
    if (this.stopping || !authorized())
      throw new AnalysisError('会话或账户已经变化，请重新读取。', 409);
    const tradeId = trade?.id ?? batchAnalysisId;
    const snapshot = freeze(this.ledger, trade, filters, includeNotes);
    const records = evidenceRecords(snapshot);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([records, this.config?.provider, this.config?.model, this.config?.effort]),
      )
      .digest('hex');
    const existing = this.list(tradeId).find(
      (task) => task.fingerprint === fingerprint && ['complete', 'running'].includes(task.status),
    );
    if (existing && !regenerate) return existing;
    const config = configuredModel(this.config);
    const capacity = await modelCapacity(
      config,
      AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
    );
    if (this.stopping || !authorized())
      throw new AnalysisError('会话或账户已经变化，没有发起模型分析。', 409);
    const concurrent = this.list(tradeId).find(
      (task) => task.fingerprint === fingerprint && ['complete', 'running'].includes(task.status),
    );
    if (concurrent && !regenerate) return concurrent;
    const createdAt = new Date().toISOString();
    const task: AnalysisTask = {
      ...this.ledger.scope(),
      id: randomUUID(),
      tradeId,
      fingerprint,
      snapshot,
      records,
      capacity,
      createdAt,
      updatedAt: createdAt,
      status: 'running',
      requests: [],
      report: null,
      error: null,
    };
    task.records = this.fragments(task, records);
    task.requests = this.groups(task, task.records, 'evidence').map((group, index) => ({
      id: `segment-${index + 1}`,
      stage: 'evidence',
      records: group,
      segments: [],
      status: 'pending',
      report: null,
      usage: null,
      attempts: [],
    }));
    this.save(task);
    const started = structuredClone(task);
    this.launch(task);
    return started;
  }
  private launch(task: AnalysisTask) {
    const controller = new AbortController();
    const work = this.run(task, controller.signal).finally(() => this.running.delete(task.id));
    this.running.set(task.id, { controller, work, task });
  }
  private fits(task: AnalysisTask, input: unknown) {
    const body = modelRequest(task.capacity, input);
    // UTF-8 bytes conservatively bound tokens; include schema, prompt, framing and reserved reasoning/output.
    return (
      Buffer.byteLength(JSON.stringify(body)) + body.max_output_tokens + 1024 <=
      task.capacity.contextWindow
    );
  }
  private groups<T>(task: AnalysisTask, items: T[], stage: 'evidence' | 'synthesis'): T[][] {
    const empty = modelRequest(task.capacity, {
      stage,
      records: [],
      summaries: [],
      missing: task.snapshot.missing,
    });
    const base = Buffer.byteLength(JSON.stringify(empty));
    const limit = task.capacity.contextWindow - empty.max_output_tokens - 1024;
    let size = base;
    const groups: T[][] = [];
    let current: T[] = [];
    for (const item of items) {
      // input is itself a JSON string: count both serialization layers once per item.
      const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(item))) - 2;
      if (base + bytes > limit)
        throw new AnalysisError('单段内容超过可用容量；全部证据保留，未截断。');
      if (size + bytes + (current.length ? 1 : 0) > limit) {
        if (current.length) groups.push(current);
        current = [];
        size = base;
      }
      size += bytes + (current.length ? 1 : 0);
      current.push(item);
    }
    if (current.length) groups.push(current);
    return groups;
  }
  private fragments(task: AnalysisTask, records: EvidenceRecord[]) {
    return records.flatMap((row) => {
      if (
        this.fits(task, {
          stage: 'evidence',
          records: [row],
          summaries: [],
          missing: task.snapshot.missing,
        })
      )
        return [row];
      if (typeof row.value !== 'string')
        throw new AnalysisError('单条证据无法适配模型容量；未截断。');
      const chars = Array.from(row.value);
      let size = Math.max(1, Math.floor(chars.length / 2));
      while (size >= 1) {
        const parts: EvidenceRecord[] = [];
        for (let offset = 0; offset < chars.length; offset += size)
          parts.push({
            ...row,
            id: `${row.id}-part-${parts.length + 1}`,
            path: `${row.path} [原文字片段 ${parts.length + 1}/${Math.ceil(chars.length / size)}，须按顺序合并]`,
            value: chars.slice(offset, offset + size).join(''),
          });
        if (
          parts.every((part) =>
            this.fits(task, {
              stage: 'evidence',
              records: [part],
              summaries: [],
              missing: task.snapshot.missing,
            }),
          )
        )
          return parts;
        if (size === 1) break;
        size = Math.max(1, Math.floor(size / 2));
      }
      throw new AnalysisError('模型容量不足以覆盖单条证据，未截断。');
    });
  }
  async cancel(id: string, tradeId: string) {
    const task = this.running.get(id)?.task ?? this.ledger.analysis(id);
    if (!task || task.tradeId !== tradeId) throw new AnalysisError('未找到该交易的任务。', 404);
    if (task.status === 'running') {
      task.status = 'cancelled';
      task.error = '用户取消；用量未知时仍可能产生费用。';
      this.save(task);
      this.running.get(id)?.controller.abort();
      await this.running.get(id)?.work;
    }
    return this.ledger.analysis(id)!;
  }
  continue(id: string, tradeId: string) {
    if (this.stopping) throw new AnalysisError('账户或服务已经变化，请重新读取。', 409);
    const task = this.ledger.analysis(id);
    if (!task || task.tradeId !== tradeId) throw new AnalysisError('未找到该交易的任务。', 404);
    if (task.status === 'complete' || this.running.has(id)) return task;
    configuredModel(this.config);
    task.status = 'running';
    task.error = null;
    this.save(task);
    const started = structuredClone(task);
    this.launch(task);
    return started;
  }
  private async run(task: AnalysisTask, signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        let request = task.requests.find((row) => row.status !== 'complete');
        if (!request) {
          const consumed = new Set(task.requests.flatMap((row) => row.segments));
          const frontier = task.requests.filter((row) => !consumed.has(row.id));
          if (
            frontier.length === 1 &&
            (task.tradeId !== batchAnalysisId || frontier[0]!.stage === 'synthesis')
          ) {
            task.report = frontier[0]!.report;
            task.status = 'complete';
            task.error = null;
            this.save(task);
            return;
          }
          const summaries = segmentSummaries(frontier);
          const groups = this.groups(task, summaries, 'synthesis');
          if (frontier.length > 1 && groups.length >= frontier.length)
            throw new AnalysisError('分段结果无法在容量内综合；已有分段保留，整体未完成。');
          for (const group of groups)
            task.requests.push({
              id: `synthesis-${task.requests.length + 1}`,
              stage: 'synthesis',
              records: [],
              segments: group.map((row) => row.id),
              status: 'pending',
              report: null,
              usage: null,
              attempts: [],
            });
          this.save(task);
          request = task.requests.find((row) => row.status !== 'complete')!;
        }
        request.status = 'running';
        request.usage = null;
        request.attempts.push({ usage: null, status: 'running' });
        this.save(task);
        const summaries = segmentSummaries(
          request.segments.map((id) => task.requests.find((row) => row.id === id)!),
        );
        const input = {
          stage: request.stage,
          records: request.records,
          summaries,
          missing: task.snapshot.missing,
        };
        if (!this.fits(task, input))
          throw new AnalysisError('请求超过冻结模型容量；没有发送或截断。');
        const raw = (await callModel(
          configuredModel(this.config),
          task.capacity,
          input,
          signal,
        )) as {
          usage?: unknown;
          status?: unknown;
          output?: {
            type?: unknown;
            status?: unknown;
            content?: { type?: unknown; text?: unknown }[];
          }[];
        };
        request.usage = modelUsage(raw.usage);
        request.attempts.at(-1)!.usage = request.usage;
        if (signal.aborted) throw new AnalysisError('任务已取消。');
        if (
          raw.status !== 'completed' ||
          !Array.isArray(raw.output) ||
          raw.output.some((item) => item.status && item.status !== 'completed')
        )
          throw new AnalysisError('模型输出未完成或被截断。');
        const text = raw.output
          .filter((item) => item.type === 'message')
          .flatMap((item) => item.content ?? [])
          .filter((item) => item.type === 'output_text')
          .map((item) => item.text)
          .join('');
        if (this.config?.apiKey && text.includes(this.config.apiKey))
          throw new AnalysisError('模型内容包含敏感配置值，报告未保存。');
        const report = validateReport(
          JSON.parse(text),
          [...request.records, ...summaryCitations(summaries)],
          task.snapshot.trades?.map((trade) => trade.id) ?? [task.tradeId],
        );
        const consumed = new Set(task.requests.flatMap((row) => row.segments));
        if (
          request.stage === 'synthesis' &&
          task.requests.filter((row) => !consumed.has(row.id)).length === 1
        )
          validateBatchReport(task, report);
        request.report = report;
        request.status = 'complete';
        request.attempts.at(-1)!.status = 'complete';
        this.save(task);
      }
      throw new AnalysisError('任务已取消或中断；已完成分段保留。');
    } catch (error) {
      if (task.status === 'running') task.status = 'failed';
      task.error =
        error instanceof AnalysisError
          ? error.message
          : '模型请求或报告校验失败；用量未知时仍可能产生费用。';
      for (const request of task.requests)
        if (request.status === 'running') {
          request.status = 'failed';
          request.attempts.at(-1)!.status =
            task.status === 'cancelled'
              ? 'cancelled'
              : task.status === 'interrupted'
                ? 'interrupted'
                : 'failed';
        }
      this.save(task);
    }
  }
  async stop() {
    this.stopping = true;
    this.lifetime.abort();
    for (const running of this.running.values()) {
      running.task.status = 'interrupted';
      this.save(running.task);
      running.controller.abort();
    }
    await Promise.all([...this.running.values()].map((value) => value.work));
  }
}
