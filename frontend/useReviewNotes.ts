import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import type { ReviewTrade } from '../src/review-ledger.ts';
import type { NoteContent, ReviewJournal, ReviewNote, StyleTag } from '../src/review-notes.ts';

const empty = (): NoteContent => ({
  entryReason: '',
  exitReason: '',
  executionProblem: '',
  improvement: '',
  freeNote: '',
  tagIds: [],
});
const content = (note: NoteContent): NoteContent => ({
  entryReason: note.entryReason,
  exitReason: note.exitReason,
  executionProblem: note.executionProblem,
  improvement: note.improvement,
  freeNote: note.freeNote,
  tagIds: [...note.tagIds],
});
type Draft = NoteContent & { noteId: string | null; version: number; basis: string; saved: string };
function validateJournal(value: unknown, source: string, accountId: string): ReviewJournal {
  const data = value as ReviewJournal | null;
  if (
    !data ||
    data.source !== source ||
    data.accountId !== accountId ||
    !Array.isArray(data.notes) ||
    !Array.isArray(data.tags)
  )
    throw new Error('个人记录来源或账户无效。');
  const validId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
  const validVersion = (item: { version: number; updatedAt: string }) =>
    Number.isSafeInteger(item.version) &&
    item.version > 0 &&
    typeof item.updatedAt === 'string' &&
    Number.isFinite(Date.parse(item.updatedAt));
  for (const tag of data.tags) {
    if (
      !tag ||
      !validId(tag.id) ||
      !validVersion(tag) ||
      typeof tag.name !== 'string' ||
      tag.name.length > 40 ||
      typeof tag.active !== 'boolean'
    )
      throw new Error('标签响应无效。');
  }
  for (const note of data.notes) {
    if (
      !note ||
      !validId(note.id) ||
      !validVersion(note) ||
      !['current', 'pending'].includes(note.binding) ||
      !note.trade ||
      note.trade.source !== source ||
      note.trade.accountId !== accountId ||
      typeof note.trade.id !== 'string' ||
      typeof note.trade.symbol !== 'string' ||
      !note.trade.evidence ||
      !Array.isArray(note.trade.evidence.fills) ||
      note.trade.evidence.fills.some(
        (fill) => !fill || typeof fill.id !== 'string' || typeof fill.quantity !== 'string',
      ) ||
      !Array.isArray(note.tagIds) ||
      note.tagIds.some((id) => !data.tags.some((tag) => tag.id === id))
    )
      throw new Error('笔记响应或交易依据无效。');
    for (const field of [
      'entryReason',
      'exitReason',
      'executionProblem',
      'improvement',
      'freeNote',
    ] as const) {
      if (
        typeof note[field] !== 'string' ||
        note[field].length > (field === 'freeNote' ? 10000 : 2000)
      )
        throw new Error('笔记响应无效。');
    }
  }
  return data;
}
export function useReviewNotes(
  source: string,
  accountId: () => string | null,
  trade: () => ReviewTrade | null,
) {
  const journal = shallowRef<ReviewJournal | null>(null);
  const drafts = reactive(new Map<string, Draft>());
  const busy = ref(false);
  const relogin = ref(false);
  const status = ref('');
  const tagName = ref('');
  const editingTag = shallowRef<StyleTag | null>(null);
  const loadedBasis = ref<string | null>(null);
  const draft = computed(() => (trade() ? drafts.get(trade()!.id) : undefined));
  const dirty = computed(() =>
    [...drafts.values()].some((value) => JSON.stringify(content(value)) !== value.saved),
  );
  const savedNote = computed(() =>
    loadedBasis.value === trade()?.noteBasis
      ? journal.value?.notes.find(
          (note) => note.trade.id === trade()?.id && note.binding === 'current',
        )
      : undefined,
  );
  const pendingNotes = computed(
    () => journal.value?.notes.filter((note) => note.binding === 'pending') ?? [],
  );
  let lastAccount: string | null = null;
  let sequence = 0;
  let refreshQueued = false;
  let controller: AbortController | undefined;
  let cleanup = () => {};
  function seed(value: ReviewTrade, note?: ReviewNote) {
    const next = note ? content(note) : empty();
    drafts.set(value.id, {
      ...next,
      noteId: note?.id ?? null,
      version: note?.version ?? 0,
      basis: value.noteBasis ?? '',
      saved: JSON.stringify(next),
    });
  }
  watch([trade, journal, loadedBasis], () => {
    const current = trade();
    if (
      current &&
      loadedBasis.value === current.noteBasis &&
      journal.value &&
      current.accountId === journal.value.accountId &&
      current.source === journal.value.source &&
      !drafts.has(current.id)
    )
      seed(current, savedNote.value);
  });
  async function request(path: string, input?: unknown) {
    const account = accountId();
    if (!account || busy.value || relogin.value) return;
    if (!navigator.onLine || document.hidden) {
      status.value = '网络断开或页面已隐藏，当前输入保留。';
      return;
    }
    const detailBasis = trade()?.noteBasis ?? null;
    const current = ++sequence;
    controller?.abort();
    const pending = new AbortController();
    controller = pending;
    busy.value = true;
    try {
      const response = await fetch(path, {
        cache: 'no-store',
        signal: AbortSignal.any([pending.signal, AbortSignal.timeout(15000)]),
        ...(input === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            }),
      });
      const data: unknown = await response.json();
      if (current !== sequence || pending.signal.aborted || accountId() !== account) return;
      if (response.status === 401) relogin.value = true;
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : '个人记录保存或读取失败。';
        throw new Error(`${message} 当前输入保留。`);
      }
      const validated = validateJournal(data, source, account);
      loadedBasis.value = detailBasis;
      journal.value = validated;
      return journal.value;
    } catch (error) {
      if (current === sequence && !pending.signal.aborted)
        status.value = error instanceof Error ? error.message : '个人记录请求失败，当前输入保留。';
    } finally {
      if (current === sequence) {
        busy.value = false;
        controller = undefined;
        if (refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    }
  }
  async function refresh() {
    if (await request('/api/review/journal')) status.value = '已读取个人记录；未保存的输入保留。';
  }
  async function save() {
    const current = trade();
    const value = draft.value;
    if (!current || !value) return;
    const sent = content(value);
    const result = await request(`/api/review/trades/${encodeURIComponent(current.id)}/note`, {
      ...sent,
      noteId: value.noteId,
      version: value.version,
      basis: value.basis,
    });
    if (!result) return;
    const note = result.notes.find(
      (note) => note.trade.id === current.id && note.binding === 'current',
    );
    if (!note) {
      status.value = '交易归属已变化，当前输入保留；请重新读取交易依据。';
      return;
    }
    value.noteId = note.id;
    value.version = note.version;
    value.saved = JSON.stringify(sent);
    status.value =
      JSON.stringify(content(value)) === value.saved
        ? '笔记已保存。'
        : '提交的笔记已保存；后续编辑尚未保存。';
    return result;
  }
  async function saveTag(active?: boolean) {
    const selected = editingTag.value;
    if (
      await request('/api/review/tags', {
        id: selected?.id ?? null,
        version: selected?.version ?? 0,
        name: tagName.value,
        active: active ?? selected?.active ?? true,
      })
    ) {
      editingTag.value = null;
      tagName.value = '';
      status.value =
        (active ?? selected?.active ?? true) ? '标签已保存。' : '标签已停用，历史关联保留。';
      return journal.value;
    }
  }
  function editTag(tag: StyleTag) {
    editingTag.value = tag;
    tagName.value = tag.name;
  }
  function reloadSaved() {
    const current = trade();
    if (!current || !journal.value) return;
    if (loadedBasis.value !== current.noteBasis) {
      status.value = '请先重新读取笔记与标签，当前输入保留。';
      return;
    }
    if (
      draft.value &&
      JSON.stringify(content(draft.value)) !== draft.value.saved &&
      !window.confirm('用服务端已保存版本替换当前输入？未保存的编辑将丢弃。')
    )
      return;
    seed(current, savedNote.value);
    status.value = '已载入保存版本；如交易依据已变化，请先重新读取交易详情。';
  }
  function pause() {
    refreshQueued = false;
    sequence++;
    controller?.abort();
    controller = undefined;
    busy.value = false;
    status.value = '请求已暂停，当前输入保留；若保存未确认，请重新读取个人记录。';
  }
  watch(
    accountId,
    (next) => {
      if (!next) return;
      pause();
      if (lastAccount !== next) drafts.clear();
      lastAccount = next;
      journal.value = null;
      editingTag.value = null;
      tagName.value = '';
      void refresh();
    },
    { immediate: true },
  );
  watch(trade, (value) => {
    if (value) {
      if (busy.value) refreshQueued = true;
      else void refresh();
    }
  });
  onMounted(() => {
    const events = new AbortController();
    const options = { signal: events.signal };
    const resume = () => {
      if (!document.hidden && navigator.onLine) void refresh();
    };
    window.addEventListener('pagehide', pause, options);
    window.addEventListener('offline', pause, options);
    window.addEventListener('pageshow', resume, options);
    window.addEventListener('online', resume, options);
    document.addEventListener(
      'visibilitychange',
      () => (document.hidden ? pause() : resume()),
      options,
    );
    window.addEventListener(
      'beforeunload',
      (event) => {
        if (dirty.value) {
          event.preventDefault();
          event.returnValue = '';
        }
      },
      options,
    );
    cleanup = () => events.abort();
  });
  onUnmounted(() => {
    cleanup();
    pause();
  });
  const staleBasis = computed(
    () => !!trade() && !!draft.value && draft.value.basis !== trade()?.noteBasis,
  );
  return {
    staleBasis,
    journal,
    draft,
    savedNote,
    pendingNotes,
    status,
    busy,
    relogin,
    refresh,
    save,
    tagName,
    editingTag,
    editTag,
    saveTag,
    reloadSaved,
  };
}
