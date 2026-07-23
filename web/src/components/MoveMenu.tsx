import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderInput } from 'lucide-react';
import type { Folder } from '../api/types';
import { folderIcon, sortFolders } from '../lib/folders';

interface Props {
  folders: Folder[];
  currentFolder: string;
  onMove: (target: string) => void;
}

/** Styled "Move to folder" dropdown with folder icons and consistent ordering. */
export function MoveMenu({ folders, currentFolder, onMove }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const targets = sortFolders(folders.filter((f) => f.path !== currentFolder));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Move to folder"
        className="flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
      >
        <FolderInput size={18} />
        <span>Move</span>
        <ChevronDown size={14} className="text-neutral-400" />
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
          {targets.map((f) => {
            const Icon = folderIcon(f);
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => {
                  onMove(f.path);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100"
              >
                <Icon size={15} className="shrink-0 text-neutral-500" />
                <span className="flex-1 truncate">{f.name}</span>
                {f.unseen > 0 && (
                  <span className="rounded-full bg-neutral-200 px-1.5 text-xs text-neutral-600">
                    {f.unseen}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
