import { useRef } from 'react';
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { api } from './api/client';
import type {
  AiAccountSettings,
  AiBatchAction,
  AiDecision,
  AiGlobalSettingsPatch,
  Folder,
  MessageDetail,
  MessageSummary,
  NewAccountInput,
} from './api/types';

export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: api.listAccounts });
}

export function useAddAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NewAccountInput) => api.addAccount(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useFolders(accountId: string | null) {
  // Pause polling while a mark-all-read is applying: the server only updates the
  // DB after its (multi-second) IMAP op, so a mid-op refetch would read the
  // pre-update unread count and overwrite the optimistic zeroed badge.
  const marking = useIsMutating({ mutationKey: ['mark-folder-read', accountId] });
  return useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => api.listFolders(accountId!),
    enabled: !!accountId,
    // Poll so background-sync progress (counts, status, last-synced) shows live.
    refetchInterval: marking > 0 ? false : 6_000,
  });
}

// Messages are fetched a page at a time and appended as the user scrolls, so a
// folder with thousands of messages doesn't ship its whole contents up front.
export const MESSAGE_PAGE_SIZE = 50;

// Cache shape for the paged message list. Each page is one MESSAGE_PAGE_SIZE
// slice; the mutation layer below flattens/maps across pages.
export type MessagePages = InfiniteData<MessageSummary[], number>;

// A given (account, folder) has two independently-paged lists: the full list and
// the unread-only list (filtered server-side). They cache under distinct keys so
// the unread view stays small and complete — bounded by the folder's unread count
// rather than requiring the whole folder to be page-loaded client-side.
export function messagesKey(accountId: string | null, folder: string | null, unseenOnly: boolean) {
  return ['messages', accountId, folder, unseenOnly ? 'unseen' : 'all'] as const;
}

export function useMessages(
  accountId: string | null,
  folder: string | null,
  opts: { pausePolling?: boolean; unseenOnly?: boolean } = {},
) {
  const unseenOnly = opts.unseenOnly ?? false;
  return useInfiniteQuery({
    queryKey: messagesKey(accountId, folder, unseenOnly),
    queryFn: ({ pageParam }) =>
      api.listMessages(accountId!, folder!, {
        limit: MESSAGE_PAGE_SIZE,
        offset: pageParam,
        unseen: unseenOnly,
      }),
    initialPageParam: 0,
    // Next offset is always the count of pages already loaded × page size.
    // Deliberately NOT gated on page length: an optimistic removal shrinks a
    // page below MESSAGE_PAGE_SIZE, and gating here would drop the next
    // pageParam and permanently disable fetchNextPage. Termination is instead
    // driven by `hasMore` (loaded < folder total) in useFilteredMessages; the
    // empty-page check only guards the case where the total is momentarily
    // stale and we fetch one page past the real tail.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === 0 ? undefined : allPages.length * MESSAGE_PAGE_SIZE,
    enabled: !!accountId && !!folder,
    // Poll the open folder so newly synced mail appears without manual refresh.
    // Refetch revalidates every loaded page. Paused while destructive actions
    // are in flight: a poll issued mid-mutation reads the cache before the
    // server's post-move DB delete lands, so its late-arriving response would
    // resurrect a just-removed message.
    refetchInterval: opts.pausePolling ? false : 12_000,
  });
}

/**
 * Like useMessages but hardened against a just-actioned message flashing back
 * into the list. Two guards work together:
 *
 *  1. Background polling is paused while ANY message action for this folder is
 *     in flight (removals and read-toggles alike), so no stale list read can be
 *     issued during the action and resolve late.
 *  2. Any UID with a still-pending *removal* is filtered out of the rendered
 *     list, covering the window before the authoritative refetch settles. Read
 *     toggles are excluded — those rows must stay visible, just change state.
 *
 * The list read is cache-backed and the server applies the change only *after*
 * the (multi-second) IMAP op, so without this a poll that raced the op can
 * resolve late — after the mutation settled — and briefly restore the old state.
 */
export function useFilteredMessages(
  accountId: string | null,
  folder: string | null,
  unseenOnly = false,
) {
  // Prefix match covers both 'remove' and 'read' actions for this folder.
  const pending = useIsMutating({ mutationKey: ['message-action', accountId, folder] });
  const query = useMessages(accountId, folder, { pausePolling: pending > 0, unseenOnly });
  // Folder meta supplies the authoritative message total used to decide whether
  // more pages remain (see hasMore below). Shares the cached folders query.
  const { data: folders } = useFolders(accountId);

  const pendingUids = useMutationState({
    filters: {
      mutationKey: ['message-action', accountId, folder, 'remove'],
      status: 'pending',
    },
    select: (m) => (m.state.variables as { uid: number } | undefined)?.uid,
  });

  const pendingSet = new Set(pendingUids.filter((u): u is number => u != null));

  // Flatten the paged cache into the single list the view renders. Offset paging
  // can surface the same uid on adjacent pages when newly synced mail shifts the
  // window between page fetches, so dedupe by uid (keep first). Also drop any
  // UID with a pending removal (see guard #2 above).
  const pages = query.data?.pages;
  let data: MessageSummary[] | undefined;
  if (pages) {
    const seen = new Set<number>();
    data = [];
    for (const page of pages) {
      for (const m of page) {
        if (seen.has(m.uid) || pendingSet.has(m.uid)) continue;
        seen.add(m.uid);
        data.push(m);
      }
    }
  }

  // Whether more pages remain is derived from the folder's authoritative count,
  // NOT the mutable page length: an optimistic removal shrinks both the loaded
  // list and the count together, so this stays correct mid-action where a
  // length-based check would falsely end pagination. In the unread view the
  // bound is the folder's unread count, so eager loading pulls only the (few)
  // unread pages rather than the whole folder.
  const meta = folders?.find((f) => f.path === folder);
  const total = (unseenOnly ? meta?.unseen : meta?.total) ?? 0;
  const hasMore = (data?.length ?? 0) < total;

  return { ...query, data, hasMore };
}

export function useSyncAccount() {
  return useMutation({ mutationFn: (id: string) => api.syncAccount(id) });
}

// Mark a whole folder read. Optimistically zeroes the folder's unread badge and
// flips its loaded message rows to seen, then reconciles against the server.
export function useMarkFolderRead(accountId: string) {
  const qc = useQueryClient();
  const foldersKey = ['folders', accountId];
  return useMutation({
    // Keyed so useFolders can pause its poll while this is in flight.
    mutationKey: ['mark-folder-read', accountId],
    mutationFn: (folder: string) => api.markAllRead(accountId, folder),
    onMutate: async (folder) => {
      await qc.cancelQueries({ queryKey: foldersKey });
      const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
      qc.setQueryData<Folder[]>(foldersKey, (old) =>
        old?.map((f) => (f.path === folder ? { ...f, unseen: 0 } : f)),
      );
      // Flip the loaded rows of both the full and unread lists for this folder.
      for (const unseenOnly of [false, true]) {
        qc.setQueryData<MessagePages>(messagesKey(accountId, folder, unseenOnly), (old) =>
          old ? { ...old, pages: old.pages.map((p) => p.map((m) => ({ ...m, seen: true }))) } : old,
        );
      }
      return { prevFolders };
    },
    onError: (err, _folder, ctx) => {
      if (ctx?.prevFolders) qc.setQueryData(foldersKey, ctx.prevFolders);
      alert((err as Error).message);
    },
    onSettled: (_data, _err, folder) => {
      qc.invalidateQueries({ queryKey: foldersKey });
      qc.invalidateQueries({ queryKey: ['messages', accountId, folder] });
    },
  });
}

export function useMessage(
  accountId: string | null,
  folder: string | null,
  uid: number | null,
) {
  return useQuery({
    queryKey: ['message', accountId, folder, uid],
    queryFn: () => api.getMessage(accountId!, folder!, uid!),
    enabled: !!accountId && !!folder && uid != null,
  });
}

// --- AI triage ---

export function useAiStatus() {
  return useQuery({
    queryKey: ['ai', 'status'],
    queryFn: api.aiStatus,
    refetchInterval: 10_000,
  });
}

export function useAiSuggestions(status = 'pending') {
  return useQuery({
    queryKey: ['ai', 'suggestions', status],
    queryFn: () => api.aiSuggestions(status),
    // Poll so decisions made from Telegram (or auto-apply) show up here too.
    refetchInterval: 8_000,
  });
}

export function useAiDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: AiDecision }) => api.aiDecide(v.id, v.action),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['ai'] });
      // A decision may move/read mail, so refresh the mail views too.
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
    },
  });
}

export function useAiBatchDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ids: string[]; action: AiBatchAction }) =>
      api.aiDecideBatch(v.ids, v.action),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['ai'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
    },
  });
}

export function useRunAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.aiRun(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai'] }),
  });
}

export function useAiSettings(accountId: string | null) {
  return useQuery({
    queryKey: ['ai', 'settings', accountId],
    queryFn: () => api.aiGetSettings(accountId!),
    enabled: !!accountId,
  });
}

export function useUpdateAiSettings(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Omit<AiAccountSettings, 'accountId'>>) =>
      api.aiUpdateSettings(accountId, patch),
    onSuccess: (data) => qc.setQueryData(['ai', 'settings', accountId], data),
  });
}

export function useAiGlobalSettings() {
  return useQuery({
    queryKey: ['ai', 'global-settings'],
    queryFn: api.aiGetGlobalSettings,
  });
}

export function useUpdateAiGlobalSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AiGlobalSettingsPatch) => api.aiUpdateGlobalSettings(patch),
    onSuccess: (data) => {
      qc.setQueryData(['ai', 'global-settings'], data);
      qc.invalidateQueries({ queryKey: ['ai', 'status'] });
    },
  });
}

interface ActionCtx {
  prevList?: MessagePages;
  prevFolders?: Folder[];
}

// Apply a transform to every page of the paged message cache, preserving the
// InfiniteData shape (pages/pageParams) so optimistic edits survive refetch.
function mapPages(
  data: MessagePages | undefined,
  fn: (page: MessageSummary[]) => MessageSummary[],
): MessagePages | undefined {
  if (!data) return data;
  return { ...data, pages: data.pages.map(fn) };
}

/**
 * Optimistic message actions: the cache is updated immediately and the IMAP
 * call runs in the background, so the UI feels instant. On failure the cache is
 * rolled back; either way it re-syncs when the mutation settles.
 */
export function useMessageMutations(accountId: string, folder: string, unseenOnly = false) {
  const qc = useQueryClient();
  // Optimistic edits target the list the user is looking at (full vs unread), so
  // they apply instantly; invalidateAll below refetches every ['messages', account]
  // list so the other view reconciles on its next read.
  const listKey = messagesKey(accountId, folder, unseenOnly);
  const foldersKey = ['folders', accountId];
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorMsgs = useRef<string[]>([]);

  const rollback = (ctx?: ActionCtx) => {
    if (!ctx) return;
    qc.setQueryData(listKey, ctx.prevList);
    qc.setQueryData(foldersKey, ctx.prevFolders);
  };

  // Refetch authoritative server state, but only once the LAST message action
  // settles — debounced so a burst of actions triggers a single refetch instead
  // of one per action. Cancelling first discards any stray in-flight list read
  // (e.g. issued just before polling paused) so it can't overwrite the fresh
  // result and briefly restore stale state.
  const invalidateAll = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      if (qc.isMutating({ mutationKey: ['message-action', accountId] }) > 0) return;
      void qc.cancelQueries({ queryKey: ['messages', accountId] }).finally(() => {
        qc.invalidateQueries({ queryKey: ['messages', accountId] });
        qc.invalidateQueries({ queryKey: foldersKey });
      });
    }, 0);
  };

  // Optimistically drop a message from the current folder and adjust counts.
  const optimisticRemove = async (uid: number): Promise<ActionCtx> => {
    await qc.cancelQueries({ queryKey: listKey });
    const prevList = qc.getQueryData<MessagePages>(listKey);
    const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
    const wasSeen = prevList?.pages.flat().find((m) => m.uid === uid)?.seen ?? true;
    qc.setQueryData<MessagePages>(listKey, (old) =>
      mapPages(old, (page) => page.filter((m) => m.uid !== uid)),
    );
    qc.setQueryData<Folder[]>(foldersKey, (old) =>
      old?.map((f) =>
        f.path === folder
          ? {
              ...f,
              total: Math.max(0, f.total - 1),
              unseen: Math.max(0, f.unseen - (wasSeen ? 0 : 1)),
            }
          : f,
      ),
    );
    return { prevList, prevFolders };
  };

  // Bulk variant: drop many messages and adjust counts in a single cache pass.
  const optimisticRemoveMany = async (uids: number[]): Promise<ActionCtx> => {
    await qc.cancelQueries({ queryKey: listKey });
    const prevList = qc.getQueryData<MessagePages>(listKey);
    const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
    const set = new Set(uids);
    const removed = (prevList?.pages.flat() ?? []).filter((m) => set.has(m.uid));
    const unseenRemoved = removed.filter((m) => !m.seen).length;
    qc.setQueryData<MessagePages>(listKey, (old) =>
      mapPages(old, (page) => page.filter((m) => !set.has(m.uid))),
    );
    qc.setQueryData<Folder[]>(foldersKey, (old) =>
      old?.map((f) =>
        f.path === folder
          ? {
              ...f,
              total: Math.max(0, f.total - removed.length),
              unseen: Math.max(0, f.unseen - unseenRemoved),
            }
          : f,
      ),
    );
    return { prevList, prevFolders };
  };

  // Bulk variant: toggle \Seen on many messages and adjust the unread count once.
  const optimisticSetReadMany = async (uids: number[], seen: boolean): Promise<ActionCtx> => {
    await qc.cancelQueries({ queryKey: listKey });
    const prevList = qc.getQueryData<MessagePages>(listKey);
    const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
    const set = new Set(uids);
    const flipped = (prevList?.pages.flat() ?? []).filter(
      (m) => set.has(m.uid) && m.seen !== seen,
    ).length;
    qc.setQueryData<MessagePages>(listKey, (old) =>
      mapPages(old, (page) => page.map((m) => (set.has(m.uid) ? { ...m, seen } : m))),
    );
    if (flipped > 0) {
      qc.setQueryData<Folder[]>(foldersKey, (old) =>
        old?.map((f) =>
          f.path === folder
            ? { ...f, unseen: Math.max(0, f.unseen + (seen ? -flipped : flipped)) }
            : f,
        ),
      );
    }
    return { prevList, prevFolders };
  };

  // Unread-view variant of "mark read": a read message no longer belongs in the
  // unread list, so drop the rows (rather than flip \Seen in place) and decrement
  // the folder's unread count. The message total is unchanged — it still exists,
  // just read — so hasMore in the unread view stays bounded by `unseen`.
  const optimisticReadRemoveMany = async (uids: number[]): Promise<ActionCtx> => {
    await qc.cancelQueries({ queryKey: listKey });
    const prevList = qc.getQueryData<MessagePages>(listKey);
    const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
    const set = new Set(uids);
    const removedUnseen = (prevList?.pages.flat() ?? []).filter(
      (m) => set.has(m.uid) && !m.seen,
    ).length;
    qc.setQueryData<MessagePages>(listKey, (old) =>
      mapPages(old, (page) => page.filter((m) => !set.has(m.uid))),
    );
    if (removedUnseen > 0) {
      qc.setQueryData<Folder[]>(foldersKey, (old) =>
        old?.map((f) =>
          f.path === folder ? { ...f, unseen: Math.max(0, f.unseen - removedUnseen) } : f,
        ),
      );
    }
    return { prevList, prevFolders };
  };

  // Roll back immediately, but coalesce error alerts across a burst: a bulk
  // action fires many mutations at once, and one blocking alert() per failure
  // would stack N modal dialogs. Collect the messages and surface a single
  // (deduped) alert once the burst settles.
  const onError = (err: unknown, ctx: ActionCtx | undefined) => {
    rollback(ctx);
    errorMsgs.current.push((err as Error).message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => {
      errorTimer.current = null;
      const msgs = errorMsgs.current;
      errorMsgs.current = [];
      const unique = Array.from(new Set(msgs));
      alert(
        msgs.length > 1
          ? `${msgs.length} actions failed:\n${unique.join('\n')}`
          : unique[0],
      );
    }, 0);
  };

  // Removals share one key; the read-toggle uses a sibling key. Both live under
  // the ['message-action', accountId, folder] prefix so polling pauses for
  // either, but only removals ('remove') are filtered out of the list.
  const removeKey = ['message-action', accountId, folder, 'remove'];
  const readKey = ['message-action', accountId, folder, 'read'];

  const move = useMutation({
    mutationKey: removeKey,
    mutationFn: (v: { uid: number; target: string }) =>
      api.move(accountId, folder, v.uid, v.target),
    onMutate: (v) => optimisticRemove(v.uid),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const archive = useMutation({
    mutationKey: removeKey,
    mutationFn: (v: { uid: number }) => api.archive(accountId, folder, v.uid),
    onMutate: (v) => optimisticRemove(v.uid),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const remove = useMutation({
    mutationKey: removeKey,
    mutationFn: (v: { uid: number; hard?: boolean }) =>
      api.remove(accountId, folder, v.uid, v.hard ?? false),
    onMutate: (v) => optimisticRemove(v.uid),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const setRead = useMutation({
    mutationKey: readKey,
    mutationFn: (v: { uid: number; seen: boolean }) =>
      api.setRead(accountId, folder, v.uid, v.seen),
    onMutate: async (v): Promise<ActionCtx> => {
      await qc.cancelQueries({ queryKey: listKey });
      const prevList = qc.getQueryData<MessagePages>(listKey);
      const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
      const wasSeen = prevList?.pages.flat().find((m) => m.uid === v.uid)?.seen;
      qc.setQueryData<MessagePages>(listKey, (old) =>
        mapPages(old, (page) =>
          page.map((m) => (m.uid === v.uid ? { ...m, seen: v.seen } : m)),
        ),
      );
      qc.setQueryData<MessageDetail>(['message', accountId, folder, v.uid], (old) =>
        old ? { ...old, seen: v.seen } : old,
      );
      if (wasSeen !== undefined && wasSeen !== v.seen) {
        qc.setQueryData<Folder[]>(foldersKey, (old) =>
          old?.map((f) =>
            f.path === folder ? { ...f, unseen: Math.max(0, f.unseen + (v.seen ? -1 : 1)) } : f,
          ),
        );
      }
      return { prevList, prevFolders };
    },
    onError: (e, _v, ctx) => onError(e, ctx),
    // Same debounced, cancel-guarded refetch as removals so a poll that raced
    // the \Seen flag update can't resolve late and flip the row back.
    onSettled: invalidateAll,
  });

  // Bulk mutations: one request for the whole selection, one optimistic pass, one
  // settle. They share the same mutation keys as the single actions so polling
  // still pauses for the burst (see invalidateAll).
  const bulkArchive = useMutation({
    mutationKey: removeKey,
    mutationFn: (v: { uids: number[] }) =>
      api.bulk(accountId, folder, { action: 'archive', uids: v.uids }),
    onMutate: (v) => optimisticRemoveMany(v.uids),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const bulkMove = useMutation({
    mutationKey: removeKey,
    mutationFn: (v: { uids: number[]; target: string }) =>
      api.bulk(accountId, folder, { action: 'move', uids: v.uids, target: v.target }),
    onMutate: (v) => optimisticRemoveMany(v.uids),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const bulkRemove = useMutation({
    mutationKey: removeKey,
    mutationFn: (v: { uids: number[]; hard?: boolean }) =>
      api.bulk(accountId, folder, { action: 'delete', uids: v.uids, hard: v.hard ?? false }),
    onMutate: (v) => optimisticRemoveMany(v.uids),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const bulkSetRead = useMutation({
    mutationKey: readKey,
    mutationFn: (v: { uids: number[]; seen: boolean }) =>
      api.bulk(accountId, folder, { action: v.seen ? 'read' : 'unread', uids: v.uids }),
    onMutate: (v) =>
      unseenOnly && v.seen
        ? optimisticReadRemoveMany(v.uids)
        : optimisticSetReadMany(v.uids, v.seen),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  return { move, archive, remove, setRead, bulkArchive, bulkMove, bulkRemove, bulkSetRead };
}
