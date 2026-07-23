import {
  Archive,
  Folder as FolderIcon,
  Inbox,
  Send,
  Trash2,
  FileText,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import type { Folder } from '../api/types';

// Special folders float to the top in this order; everything else is
// alphabetical below them.
const SPECIAL_ORDER: Record<string, number> = {
  '\\Inbox': 0,
  '\\Sent': 1,
  '\\Drafts': 2,
  '\\Trash': 3,
  '\\Archive': 4,
  '\\Junk': 5,
};

export function folderRank(f: Folder): number {
  if (f.specialUse && f.specialUse in SPECIAL_ORDER) return SPECIAL_ORDER[f.specialUse];
  if (f.path.toLowerCase() === 'inbox') return 0; // INBOX without a special-use flag
  return 100;
}

export function sortFolders(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) => {
    const rank = folderRank(a) - folderRank(b);
    return rank !== 0 ? rank : a.name.localeCompare(b.name);
  });
}

export function folderIcon(f: Folder): LucideIcon {
  switch (f.specialUse) {
    case '\\Inbox':
      return Inbox;
    case '\\Sent':
      return Send;
    case '\\Archive':
      return Archive;
    case '\\Trash':
      return Trash2;
    case '\\Drafts':
      return FileText;
    case '\\Junk':
      return ShieldAlert;
    default:
      return f.path.toLowerCase() === 'inbox' ? Inbox : FolderIcon;
  }
}
