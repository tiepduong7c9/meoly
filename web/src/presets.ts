export interface ProviderPreset {
  label: string;
  host: string;
  port: number;
  secure: boolean;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  gmail: { label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true },
  outlook: { label: 'Outlook / Office 365', host: 'outlook.office365.com', port: 993, secure: true },
  icloud: { label: 'iCloud', host: 'imap.mail.me.com', port: 993, secure: true },
  fastmail: { label: 'Fastmail', host: 'imap.fastmail.com', port: 993, secure: true },
  custom: { label: 'Custom', host: '', port: 993, secure: true },
};
