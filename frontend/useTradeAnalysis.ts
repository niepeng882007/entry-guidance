import { onMounted, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue';
import type { AnalysisTask } from '../src/trade-analysis.ts';
import { validateAnalysisTask } from '../src/analysis-contract.ts';

export function useTradeAnalysis(
  trade: Ref<{ id: string; source: string; accountId: string } | null>,
  query: () => string,
) {
  const tasks = shallowRef<AnalysisTask[]>([]);
  const includeNotes = ref(false);
  const busy = ref(false);
  const stale = ref(true);
  const status = ref('读取已保存分析任务…');
  let controller: AbortController | undefined;
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  function stopRead() {
    sequence++;
    controller?.abort();
    clearTimeout(timer);
    busy.value = false;
  }
  async function read(input?: unknown) {
    stopRead();
    if (disposed || document.hidden || !navigator.onLine) {
      stale.value = true;
      return;
    }
    const version = sequence;
    const current = trade.value;
    if (!current) {
      stale.value = true;
      return;
    }
    const endpoint =
      current.id === '$batch'
        ? '/api/review/analysis'
        : `/api/review/trades/${current.id}/analysis`;
    controller = new AbortController();
    busy.value = true;
    try {
      const response = await fetch(endpoint, {
        method: input ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        ...(input
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
          : {}),
      });
      const data = await response.json();
      if (version !== sequence || disposed) return;
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? '登录已过期，请重新登录。'
            : typeof data.error === 'string'
              ? data.error
              : '分析任务读取失败。',
        );
      if (input) validateAnalysisTask(data, current);
      else {
        if (
          data.source !== current.source ||
          data.accountId !== current.accountId ||
          !Array.isArray(data.tasks)
        )
          throw new Error('分析账户来源不一致。');
        tasks.value = data.tasks.map((task: unknown) => validateAnalysisTask(task, current));
      }
      stale.value = false;
      status.value = '报告依据已冻结；离开页面不会取消后台任务。';
      if (input) {
        busy.value = false;
        void read();
        return;
      }
      if (tasks.value.some((task) => task.status === 'running'))
        timer = setTimeout(() => void read(), 2000);
    } catch (error) {
      if (version !== sequence || disposed) return;
      stale.value = true;
      status.value = error instanceof Error ? error.message : '分析读取失败，已有任务保留。';
    } finally {
      if (version === sequence) busy.value = false;
    }
  }
  function visibility() {
    if (document.hidden || !navigator.onLine) {
      stopRead();
      stale.value = true;
      status.value = '页面隐藏或离线；仅保留上次读取状态，后台任务继续。';
    } else void read();
  }
  watch([() => trade.value?.id, () => trade.value?.accountId, () => trade.value?.source], () => {
    stopRead();
    tasks.value = [];
    includeNotes.value = false;
    stale.value = true;
    void read();
  });
  onMounted(() => {
    void read();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', visibility);
    window.addEventListener('offline', visibility);
  });
  onUnmounted(() => {
    disposed = true;
    stopRead();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('online', visibility);
    window.removeEventListener('offline', visibility);
  });
  return {
    tasks,
    includeNotes,
    busy,
    stale,
    status,
    refresh: () => read(),
    start: (regenerate: boolean) =>
      read({ includeNotes: includeNotes.value, regenerate, query: query() }),
    action: (action: 'cancel' | 'continue', taskId: string) => read({ action, taskId }),
  };
}
