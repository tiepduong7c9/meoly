import type { ImapFlow, ListResponse } from 'imapflow';

export type SpecialUse = '\\Trash' | '\\Archive' | '\\Junk' | '\\Sent' | '\\Drafts';

const FALLBACKS: Record<SpecialUse, string[]> = {
  '\\Trash': ['Trash', 'Deleted', 'Deleted Items', 'Deleted Messages', '[Gmail]/Trash'],
  '\\Archive': ['Archive', 'Archived', '[Gmail]/All Mail', 'All Mail'],
  '\\Junk': ['Junk', 'Spam', '[Gmail]/Spam'],
  '\\Sent': ['Sent', 'Sent Items', 'Sent Messages', '[Gmail]/Sent Mail'],
  '\\Drafts': ['Drafts', '[Gmail]/Drafts'],
};

/**
 * Resolve the mailbox path for a special-use role. Prefers the server-advertised
 * \Special-Use flag, then falls back to common folder names (case-insensitive).
 */
export async function resolveSpecialFolder(
  client: ImapFlow,
  role: SpecialUse,
): Promise<string | null> {
  const boxes: ListResponse[] = await client.list();

  const byFlag = boxes.find(
    (b) => b.specialUse === role || b.flags?.has(role),
  );
  if (byFlag) return byFlag.path;

  const names = FALLBACKS[role].map((n) => n.toLowerCase());
  const byName = boxes.find(
    (b) =>
      names.includes(b.path.toLowerCase()) ||
      names.includes(b.name.toLowerCase()),
  );
  return byName?.path ?? null;
}
