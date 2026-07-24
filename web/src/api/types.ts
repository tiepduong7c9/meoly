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

export type AiAction = 'keep' | 'mark_read' | 'archive' | 'delete';
export type AiDecision = AiAction | 'reject';
/** Bulk decision: 'approve' applies each suggestion's own action. */
export type AiBatchAction = AiDecision | 'approve';

export type AiSuggestionStatus =
  | 'pending'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'error'
  | 'superseded';

export interface AiSuggestion {
  id: string;
  accountId: string;
  folderPath: string;
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromAddr: string | null;
  category: string | null;
  action: AiAction;
  confidence: number | null;
  reasoning: string | null;
  model: string | null;
  status: AiSuggestionStatus;
  appliedAction: AiAction | null;
  source: 'ai_auto' | 'web' | 'telegram' | null;
  dryRun: boolean;
  error: string | null;
  createdAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

export interface AiStatus {
  enabled: boolean;
  dryRun: boolean;
  model: string;
  paused: boolean;
  queueDepth: number;
  counts: Record<string, number>;
}

export interface AiGlobalSettings {
  paused: boolean;
  llmApiBaseUrl: string | null;
  llmApiKey: null;
  llmApiKeySet: boolean;
  llmModel: string | null;
  telegramBotToken: null;
  telegramBotTokenSet: boolean;
  telegramChatId: string | null;
}

export interface AiGlobalSettingsPatch {
  paused?: boolean;
  llmApiBaseUrl?: string | null;
  llmApiKey?: string | null;
  llmModel?: string | null;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
}

export interface AiAccountSettings {
  accountId: string;
  enabled: boolean;
  targetFolders: string[];
  autoApply: boolean;
  autoApplyMinConf: number;
  autoApplyActions: AiAction[];
}
