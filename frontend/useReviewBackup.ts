import { onUnmounted, ref, shallowRef, watch } from 'vue';
import type { RestorePreview, RecordVersion } from '../src/review-backup.ts';
type Result = RestorePreview & {
  source: string;
  accountId: string;
  message?: string;
  versions?: RecordVersion[];
};

export function useReviewBackup(
  source: 'demo' | 'binance',
  account: () => string | null,
  query: () => string,
  restored: () => void,
) {
  const busy = ref(false),
    status = ref(''),
    relogin = ref(false);
  const preview = shallowRef<Result | null>(null),
    backup = shallowRef<unknown>(null);
  const overwrite = ref<string[]>([]),
    versions = shallowRef<RecordVersion[]>([]);
  let sequence = 0,
    controller: AbortController | undefined;
  function cancel() {
    sequence++;
    controller?.abort();
    busy.value = false;
  }
  watch([account, query], () => {
    cancel();
    preview.value = null;
    backup.value = null;
    overwrite.value = [];
    versions.value = [];
    status.value = '';
    relogin.value = false;
  });
  onUnmounted(cancel);
  async function run(path: string, input: unknown, download?: string) {
    cancel();
    const current = ++sequence,
      owner = account();
    if (!owner) return;
    controller = new AbortController();
    const signal = controller.signal;
    busy.value = true;
    status.value = download
      ? '正在准备下载…'
      : path.endsWith('/preview')
        ? '正在校验备份并生成预览…'
        : path.endsWith('/versions')
          ? '正在读取恢复旧版本…'
          : '正在原子恢复，请等待结果…';
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      });
      if (current !== sequence || owner !== account()) return;
      if (!response.ok) {
        const error = await response.json();
        if (response.status === 401) relogin.value = true;
        if (response.status === 409) preview.value = null;
        throw new Error(typeof error.error === 'string' ? error.error : '操作失败，请重试。');
      }
      if (download) {
        if (
          response.headers.get('X-Review-Source') !== source ||
          response.headers.get('X-Review-Account') !== owner
        )
          throw new Error('导出来源或账户已变化，请重新读取。');
        const blob = await response.blob();
        if (current !== sequence || owner !== account()) return;
        const url = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = url;
        link.download = download;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        status.value = '下载已准备；请保存文件。';
        return;
      }
      const value = (await response.json()) as Result;
      if (current !== sequence || owner !== account()) return;
      if (value.source !== source || value.accountId !== owner)
        throw new Error('备份响应来源或账户已变化，请重新读取。');
      if (path.endsWith('/versions')) {
        versions.value = value.versions ?? [];
        status.value = '已读取恢复旧版本。';
      } else if (path.endsWith('/preview')) {
        preview.value = value;
        overwrite.value = [];
        status.value = value.rejected.length
          ? '校验未通过，拒绝项阻止整份恢复。'
          : '预览完成；确认后才写入账本。';
      } else {
        preview.value = null;
        backup.value = null;
        versions.value = value.versions ?? [];
        status.value = value.message ?? '恢复完成。';
        restored();
      }
    } catch (error) {
      if (current === sequence && !signal.aborted)
        status.value =
          error instanceof Error ? error.message : '操作失败，请重新预览；现有账本保留。';
    } finally {
      if (current === sequence) busy.value = false;
    }
  }
  async function readFile(event: Event) {
    cancel();
    preview.value = null;
    backup.value = null;
    overwrite.value = [];
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) {
      status.value = '备份文件超过 64 MiB 上限。';
      return;
    }
    const current = sequence;
    busy.value = true;
    status.value = '正在读取备份文件…';
    try {
      const text = await file.text();
      if (current !== sequence) return;
      backup.value = JSON.parse(text) as unknown;
      await run('/api/review/restore/preview', { backup: backup.value });
    } catch {
      if (current === sequence) {
        busy.value = false;
        status.value = '文件不是有效 JSON 备份；现有账本保留。';
      }
    }
  }
  function confirm() {
    if (!preview.value || preview.value.rejected.length || busy.value) return;
    return run('/api/review/restore', {
      backup: backup.value,
      token: preview.value.token,
      overwrite: overwrite.value,
    });
  }
  return {
    busy,
    status,
    relogin,
    preview,
    overwrite,
    versions,
    readFile,
    confirm,
    csv: () => run('/api/review/export', { query: query() }, 'review-trades.csv'),
    download: () => run('/api/review/backup', {}, 'review-backup.json'),
    readVersions: () => run('/api/review/restore/versions', {}),
  };
}
