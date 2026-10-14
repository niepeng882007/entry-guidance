import { createHash } from 'node:crypto';
import { AccountError, object, readBinance, readReviewIdentity, type AccountConfig } from './account.ts';
import { calendarStart, compactPages, HistorySync, normalize, uncoveredPages, windows } from './history-sync.ts';
import { ReviewLedger, type ArchiveProgress, type ArchiveState, type ReviewIdentity, type SyncState } from './review-ledger.ts';

const symbolPattern = /^[\p{L}\p{N}_]{1,30}USDT$/u;
const scopeMissing = ['发现范围：全账户收入流水、当前 USDT 永续合约与已归档合约；无法证明未出现在这些来源的历史合约无遗漏。', '已下架合约的持仓或历史可能不可读取；缺少证据的交易保持不完整。'];

export class AccountArchive {
  private task: Promise<void> | undefined;
  private starting: Promise<ArchiveProgress> | undefined;
  private controller = new AbortController();
  private config: AccountConfig;
  private ledger: ReviewLedger;
  private history: HistorySync;
  private identity: ReviewIdentity;
  constructor(config: AccountConfig, ledger: ReviewLedger, history: HistorySync, identity: ReviewIdentity) {
    this.config = config; this.ledger = ledger; this.history = history; this.identity = identity;
  }
  busy() { return !!this.task || !!this.starting; }
  state(): ArchiveProgress | null {
    const state = this.ledger.archiveState();
    if (!state) return null;
    return { ...state, ...this.identity, status: state.status === 'running' && !this.busy() ? 'interrupted' : state.status,
      contracts: this.ledger.syncs().map((contract) => contract.status === 'running' && (!this.history.busy() || this.history.state()?.symbol !== contract.symbol) ? { ...contract, status: 'interrupted' as const } : contract) };
  }
  start(): Promise<ArchiveProgress> {
    if (this.starting) return this.starting;
    if (this.task) return Promise.resolve(this.state()!);
    this.starting = this.begin().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async wait() { await this.starting; await this.task; }
  async stop() { this.controller.abort(); await this.starting?.catch(() => {}); await this.task; }
  private signal() { return AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]); }
  private async confirmIdentity() {
    if (await readReviewIdentity(this.config, this.signal(), 'archive') !== this.identity.accountId) throw new AccountError('identity_changed', '账户身份已变化，暂停当前账户新增归档。');
  }
  private async begin(): Promise<ArchiveProgress> {
    await this.history.wait();
    await this.confirmIdentity();
    const endTime = Number(object(await readBinance(this.config, 'time', this.signal(), undefined, undefined, 'archive')).serverTime);
    if (!Number.isSafeInteger(endTime) || endTime <= 0) throw new AccountError('invalid_history', '历史查询时点无效。');
    const previous = this.ledger.archiveState();
    if (previous && endTime < previous.endTime) throw new AccountError('clock_error', '查询时点早于已归档进度，暂停新增归档。');
    const startTime = previous?.startTime ?? calendarStart(endTime);
    const discovery: SyncState = previous?.discovery.pending.length ? { ...previous.discovery, endTime, pending: [...previous.discovery.pending, ...windows('income', previous.discovery.endTime + 1, endTime)], status: 'running', missing: [] } : {
      symbol: '*', startTime, endTime, status: 'running', pages: 0, records: 0,
      pending: windows('income', previous ? Math.max(startTime, previous.discovery.endTime - 7 * 86_400_000 + 1) : startTime, endTime),
      completed: previous?.discovery.completed ?? [], unavailable: previous?.discovery.unavailable ?? [], missing: [], lastSuccessAt: previous?.discovery.lastSuccessAt ?? null,
    };
    const state: ArchiveState = { status: 'running', startTime, endTime, discovery, symbols: previous?.symbols ?? [], pendingSymbols: previous?.pendingSymbols ?? [], completedSymbols: [], missing: [], scopeMissing, lastSuccessAt: previous?.lastSuccessAt ?? null };
    this.ledger.saveArchive(state);
    this.task = this.run(state).finally(() => { this.task = undefined; });
    return this.state()!;
  }
  private async run(state: ArchiveState) {
    try {
      const info = object(await readBinance(this.config, 'exchange', this.signal(), undefined, undefined, 'archive'));
      if (!Array.isArray(info.symbols)) throw new AccountError('invalid_history', '当前合约范围读取失败，不能确认发现范围。');
      state.symbols = [...new Set([...state.symbols, ...this.ledger.syncs().map((sync) => sync.symbol), ...info.symbols.map(object).filter((row) => row.contractType === 'PERPETUAL' && row.quoteAsset === 'USDT' && row.marginAsset === 'USDT').map((row) => row.symbol).filter((symbol): symbol is string => typeof symbol === 'string' && symbolPattern.test(symbol))])].sort();
      this.ledger.saveArchive(state);
      while (state.discovery.pending.length) {
        let page = state.discovery.pending[0]!;
        const cutoff = calendarStart(Date.now());
        if (page.startTime < cutoff) {
          const gap = { ...page, endTime: Math.min(page.endTime, cutoff - 1) };
          state.discovery.unavailable = compactPages([...(state.discovery.unavailable ?? []), ...uncoveredPages(gap, state.discovery.completed)]);
          if (page.endTime < cutoff) state.discovery.pending.shift();
          else state.discovery.pending[0] = { ...page, startTime: cutoff, page: 1 };
          this.ledger.saveArchive(state);
          if (page.endTime < cutoff) continue;
          page = state.discovery.pending[0]!;
        }
        await this.confirmIdentity();
        const response = await readBinance(this.config, 'income', this.signal(), undefined, { startTime: page.startTime, endTime: page.endTime, page: page.page }, 'archive');
        if (!Array.isArray(response) || response.length > 1000) throw new AccountError('invalid_history', '全账户收入分页响应无效，发现区间保持未完成。');
        const rows = response.map(object);
        if (rows.some((row) => typeof row.symbol !== 'string')) throw new AccountError('invalid_history', '收入合约证据无效，发现区间保持未完成。');
        const contracts = [...new Set(rows.map((row) => String(row.symbol)))];
        const records = contracts.flatMap((symbol) => normalize('income', rows.filter((row) => row.symbol === symbol), symbol, page));
        const next = structuredClone(state);
        next.symbols = [...new Set([...state.symbols, ...contracts.filter((symbol) => symbolPattern.test(symbol))])].sort();
        next.discovery.pages++; next.discovery.records += records.length;
        if (records.length === 1000) {
          const fingerprint = createHash('sha256').update(records.map((row) => row.id).sort().join(',')).digest('hex');
          if (fingerprint === page.fingerprint) throw new AccountError('invalid_history', '全账户收入分页没有前进，发现区间保持未完成。');
          next.discovery.pending[0] = { ...page, page: page.page + 1, fingerprint };
        } else {
          next.discovery.pending.shift(); next.discovery.completed = compactPages([...state.discovery.completed, page]);
        }
        this.ledger.saveArchive(next, records);
        state = next;
      }
      state.discovery.status = 'complete'; state.discovery.lastSuccessAt = new Date().toISOString();
      state.discovery.missing = (state.discovery.unavailable ?? []).map((page) => `全账户 income · ${new Date(page.startTime).toISOString()} 至 ${new Date(page.endTime).toISOString()} 超出可查期限，保留为发现缺口`);
      state.pendingSymbols = [...state.symbols];
      this.ledger.saveArchive(state);
      for (const symbol of [...state.pendingSymbols]) {
        await this.confirmIdentity();
        await this.history.start(symbol, true);
        await this.history.wait();
        const progress = this.ledger.sync(symbol)!;
        if (progress.status === 'complete') {
          state.pendingSymbols = state.pendingSymbols.filter((value) => value !== symbol); state.completedSymbols.push(symbol);
        } else {
          state.missing.push(`${symbol}：${progress.missing.join('；')}`);
          if (['rate_limited', 'access_denied', 'unsafe_permissions', 'unverified_identity', 'connection_failed', 'timeout'].includes(progress.errorCode ?? '')) throw new AccountError(progress.errorCode!, progress.missing.at(-1) ?? '归档暂停，下一轮继续补查。');
        }
        this.ledger.saveArchive(state);
      }
      state.status = state.pendingSymbols.length ? 'failed' : 'complete';
      if (state.status === 'complete') state.lastSuccessAt = new Date().toISOString();
      this.ledger.saveArchive(state);
    } catch (error) {
      state.status = this.controller.signal.aborted ? 'interrupted' : 'failed';
      state.errorCode = error instanceof AccountError ? error.code : 'archive_failed';
      state.missing.push(error instanceof AccountError ? error.message : '归档读取或保存失败，已有进度保留。');
      if (state.discovery.pending.length) { state.discovery.status = state.status; state.discovery.missing = [...state.missing]; }
      try { this.ledger.saveArchive(state); } catch { /* Preserve committed progress if storage is unavailable. */ }
    }
  }
}
