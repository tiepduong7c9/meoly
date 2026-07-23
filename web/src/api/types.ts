export interface Account {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  createdAt: string;
}

export interface Folder {
  path: string;
  name: string;
  specialUse: string | null;
  unseen: number;
  total: number;
  lastSyncedAt: string | null;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncError: string | null;
}

export interface MessageSummary {
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddr: string | null;
  to: string | null;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface Attachment {
  filename: string | null;
  contentType: string;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  body: {
    html: string | null;
    text: string | null;
    attachments: Attachment[];
  };
}

export interface NewAccountInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}
