export interface AccountRow {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: number; // 0 | 1
  username: string;
  secret_enc: string;
  created_at: string;
}

/** Account as exposed to the client — never includes the secret. */
export interface AccountPublic {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  createdAt: string;
}

export interface FolderRow {
  account_id: string;
  path: string;
  name: string;
  special_use: string | null;
  uidvalidity: number | null;
  uidnext: number | null;
  unseen: number;
  total: number;
  last_synced_at: string | null;
  sync_status: 'idle' | 'syncing' | 'error';
  sync_error: string | null;
}

export interface MessageRow {
  account_id: string;
  folder_path: string;
  uid: number;
  message_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  date: string | null;
  flags: string | null;
  seen: number;
  flagged: number;
  has_attachments: number;
  snippet: string | null;
  uidvalidity: number;
  synced_at: string;
}

export interface BodyRow {
  account_id: string;
  folder_path: string;
  uid: number;
  html: string | null;
  text: string | null;
  attachments_json: string | null;
  fetched_at: string;
}

export interface Attachment {
  filename: string | null;
  contentType: string;
  size: number;
}
