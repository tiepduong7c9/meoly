import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './api/client';
import type { Folder, MessageDetail, MessageSummary, NewAccountInput } from './api/types';

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

export function useMessages(accountId: string | null, folder: string | null) {
  return useQuery({
    queryKey: ['messages', accountId, folder],
    queryFn: () => api.listMessages(accountId!, folder!),
    enabled: !!accountId && !!folder,
    // Poll the open folder so newly synced mail appears without manual refresh.
    refetchInterval: 12_000,
  });
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

  const rollback = (ctx?: ActionCtx) => {
    if (!ctx) return;
    qc.setQueryData(listKey, ctx.prevList);
    qc.setQueryData(foldersKey, ctx.prevFolders);
  };

  const invalidateAll = () => {
    // Prefix match refreshes every folder (source + move/archive/delete target).
    qc.invalidateQueries({ queryKey: ['messages', accountId] });
    qc.invalidateQueries({ queryKey: foldersKey });
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

  const onError = (err: unknown, ctx: ActionCtx | undefined) => {
    rollback(ctx);
    alert((err as Error).message);
  };

  const move = useMutation({
    mutationFn: (v: { uid: number; target: string }) =>
      api.move(accountId, folder, v.uid, v.target),
    onMutate: (v) => optimisticRemove(v.uid),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const archive = useMutation({
    mutationFn: (v: { uid: number }) => api.archive(accountId, folder, v.uid),
    onMutate: (v) => optimisticRemove(v.uid),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const remove = useMutation({
    mutationFn: (v: { uid: number; hard?: boolean }) =>
      api.remove(accountId, folder, v.uid, v.hard ?? false),
    onMutate: (v) => optimisticRemove(v.uid),
    onError: (e, _v, ctx) => onError(e, ctx),
    onSettled: invalidateAll,
  });

  const setRead = useMutation({
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
    onSettled: () => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.invalidateQueries({ queryKey: foldersKey });
    },
  });

  return { move, archive, remove, setRead };
}
