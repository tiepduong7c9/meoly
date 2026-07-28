export type AuthType = 'password' | 'xoauth2';

export interface AccountRow {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: number; // 0 | 1
  username: string;
  secret_enc: string; // encrypted app password, or refresh token when xoauth2
  auth_type: AuthType;
  oauth_provider: string | null;
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
  authType: AuthType;
  createdAt: string;
}

export interface FolderRow {
  account_id: string;
  path: string;
  name: string;
  special_use: string | null;
  selectable: number;
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

/** Actions the AI can suggest / the user can apply to a message. */
export type AiAction = 'keep' | 'mark_read' | 'archive' | 'delete';

export type AiSuggestionStatus =
  | 'pending'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'error'
  | 'superseded';

export type AiDecisionSource = 'ai_auto' | 'web' | 'telegram';

export interface AiAccountSettingsRow {
  account_id: string;
  enabled: number;
  target_folders: string; // JSON string[]
  auto_apply: number;
  auto_apply_min_conf: number;
  auto_apply_actions: string; // JSON string[]
}

export interface AiSuggestionRow {
  id: string;
  account_id: string;
  folder_path: string;
  uid: number;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  category: string | null;
  action: AiAction;
  confidence: number | null;
  reasoning: string | null;
  model: string | null;
  status: AiSuggestionStatus;
  applied_action: AiAction | null;
  source: AiDecisionSource | null;
  dry_run: number;
  error: string | null;
  created_at: string;
  reviewed_at: string | null;
  applied_at: string | null;
}
