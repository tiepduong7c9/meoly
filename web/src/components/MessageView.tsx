import { useEffect, useRef } from 'react';
import { Archive, Mail, MailOpen, Paperclip, Trash2 } from 'lucide-react';
import type { Folder } from '../api/types';
import { useMessage, useMessageMutations } from '../hooks';
import { MoveMenu } from './MoveMenu';

interface Props {
  accountId: string;
  folder: string;
  uid: number;
  folders: Folder[];
  onClose: () => void;
}

export function MessageView({ accountId, folder, uid, folders, onClose }: Props) {
  const { data: message, isLoading, isError, error } = useMessage(accountId, folder, uid);
  const { move, archive, remove, setRead } = useMessageMutations(accountId, folder);

  // Mark as read when an unread message is opened (once per opened message, so
  // the toolbar's "mark unread" isn't immediately undone).
  const autoMarked = useRef<number | null>(null);
  useEffect(() => {
    if (!message || message.seen || autoMarked.current === uid) return;
    autoMarked.current = uid;
    setRead.mutate({ uid, seen: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, message?.seen]);

  // Actions are optimistic: close the reader immediately; the cache already
  // reflects the change and the IMAP op completes in the background.
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200 px-3 py-2">
        <IconButton
          title={message?.seen ? 'Mark unread' : 'Mark read'}
          disabled={!message}
          onClick={() => setRead.mutate({ uid, seen: !message!.seen })}
        >
          {message?.seen ? <Mail size={18} /> : <MailOpen size={18} />}
        </IconButton>
        <IconButton
          title="Archive"
          onClick={() => {
            archive.mutate({ uid });
            onClose();
          }}
        >
          <Archive size={18} />
        </IconButton>
        <IconButton
          title="Delete"
          onClick={() => {
            remove.mutate({ uid });
            onClose();
          }}
        >
          <Trash2 size={18} />
        </IconButton>

        <MoveMenu
          folders={folders}
          currentFolder={folder}
          onMove={(target) => {
            move.mutate({ uid, target });
            onClose();
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-6 text-sm text-neutral-400">Loading message…</p>}
        {isError && <p className="p-6 text-sm text-red-600">{(error as Error).message}</p>}
        {message && (
          <article className="mx-auto max-w-3xl p-6">
            <h1 className="mb-2 text-xl font-semibold">{message.subject || '(no subject)'}</h1>
            <div className="mb-4 border-b border-neutral-200 pb-4 text-sm text-neutral-600">
              <div>
                <span className="font-medium text-neutral-800">
                  {message.fromName || message.fromAddr}
                </span>{' '}
                {message.fromName && message.fromAddr && (
                  <span className="text-neutral-400">&lt;{message.fromAddr}&gt;</span>
                )}
              </div>
              {message.to && <div>To: {message.to}</div>}
              {message.date && <div>{new Date(message.date).toLocaleString()}</div>}
            </div>

            {message.body.attachments.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {message.body.attachments.map((a, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-700"
                  >
                    <Paperclip size={12} />
                    {a.filename || a.contentType}
                  </span>
                ))}
              </div>
            )}

            <MessageBody html={message.body.html} text={message.body.text} />
          </article>
        )}
      </div>
    </div>
  );
}

function MessageBody({ html, text }: { html: string | null; text: string | null }) {
  if (html) {
    // Render untrusted HTML inside a sandboxed iframe (no scripts, no same-origin).
    return (
      <iframe
        title="message"
        sandbox=""
        srcDoc={html}
        className="h-[60vh] w-full border-0"
      />
    );
  }
  return <pre className="whitespace-pre-wrap font-sans text-sm text-neutral-800">{text || ''}</pre>;
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-2 text-neutral-700 hover:bg-neutral-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
