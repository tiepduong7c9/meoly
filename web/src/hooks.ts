import { useRef } from 'react';
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
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
  return useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => api.listFolders(accountId!),
    enabled: !!accountId,
    // Poll so background-sync progress (counts, status, last-synced) shows live.
    refetchInterval: 6_000,
  });
}

export function useMessages(
  accountId: string | null,
  folder: string | null,
  opts: { pausePolling?: boolean } = {},
) {
  return useQuery({
    queryKey: ['messages', accountId, folder],
    queryFn: () => api.listMessages(accountId!, folder!),
    enabled: !!accountId && !!folder,
    // Poll the open folder so newly synced mail appears without manual refresh.
    // Paused while destructive actions are in flight: a poll issued mid-mutation
    // reads the cache before the server's post-move DB delete lands, so its
    // late-arriving response would resurrect a just-removed message.
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
export function useFilteredMessages(accountId: string | null, folder: string | null) {
  // Prefix match covers both 'remove' and 'read' actions for this folder.
  const pending = useIsMutating({ mutationKey: ['message-action', accountId, folder] });
  const query = useMessages(accountId, folder, { pausePolling: pending > 0 });

  const pendingUids = useMutationState({
    filters: {
      mutationKey: ['message-action', accountId, folder, 'remove'],
      status: 'pending',
    },
    select: (m) => (m.state.variables as { uid: number } | undefined)?.uid,
  });

  const pendingSet = new Set(pendingUids.filter((u): u is number => u != null));

  return {
    ...query,
    data: pendingSet.size > 0 ? query.data?.filter((m) => !pendingSet.has(m.uid)) : query.data,
  };
}

export function useSyncAccount() {
  return useMutation({ mutationFn: (id: string) => api.syncAccount(id) });
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
  prevList?: MessageSummary[];
  prevFolders?: Folder[];
}

/**
 * Optimistic message actions: the cache is updated immediately and the IMAP
 * call runs in the background, so the UI feels instant. On failure the cache is
 * rolled back; either way it re-syncs when the mutation settles.
 */
export function useMessageMutations(accountId: string, folder: string) {
  const qc = useQueryClient();
  const listKey = ['messages', accountId, folder];
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
    const prevList = qc.getQueryData<MessageSummary[]>(listKey);
    const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
    const wasSeen = prevList?.find((m) => m.uid === uid)?.seen ?? true;
    qc.setQueryData<MessageSummary[]>(listKey, (old) => old?.filter((m) => m.uid !== uid));
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
      const prevList = qc.getQueryData<MessageSummary[]>(listKey);
      const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
      const wasSeen = prevList?.find((m) => m.uid === v.uid)?.seen;
      qc.setQueryData<MessageSummary[]>(listKey, (old) =>
        old?.map((m) => (m.uid === v.uid ? { ...m, seen: v.seen } : m)),
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

  return { move, archive, remove, setRead };
}
