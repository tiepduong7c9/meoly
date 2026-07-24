import { z } from 'zod';
import { env } from '../env.js';
import { chat } from './provider.js';
import type { AiAction } from '../types.js';

export interface ClassifyInput {
  subject: string | null;
  fromName: string | null;
  fromAddr: string | null;
  folder: string;
  body: string | null;
}

export interface Classification {
  category: string;
  action: AiAction;
  confidence: number;
  reasoning: string;
}

const resultSchema = z.object({
  category: z.string().min(1).max(40),
  action: z.enum(['keep', 'mark_read', 'archive', 'delete']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(500),
});

const SYSTEM_PROMPT = `You triage a user's unread email. For each message decide a single action:
- "keep": important or needs a human reply; leave it unread in the inbox.
- "mark_read": informational, already-known, or low-value notifications the user does not need to act on.
- "archive": no longer needs the inbox but may be worth keeping (receipts, confirmations, newsletters worth retaining).
- "delete": clear junk, spam, or promotional mail with no lasting value (delete is soft — it goes to Trash).

Be conservative: when unsure, prefer "keep" and a low confidence. Respond with ONLY a JSON object:
{"category": string, "action": "keep"|"mark_read"|"archive"|"delete", "confidence": number 0..1, "reasoning": string}`;

function buildUserPrompt(input: ClassifyInput): string {
  const from = [input.fromName, input.fromAddr && `<${input.fromAddr}>`]
    .filter(Boolean)
    .join(' ');
  const body = (input.body ?? '').slice(0, env.ai.maxBodyChars);
  return [
    `Folder: ${input.folder}`,
    `From: ${from || '(unknown)'}`,
    `Subject: ${input.subject ?? '(no subject)'}`,
    '',
    'Body:',
    body || '(empty)',
  ].join('\n');
}

/** Extract a JSON object from a model reply that may wrap it in prose/fences. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('Model reply was not valid JSON');
  }
}

/** Classify one message. Throws on provider/parse failure so the caller can
 *  record an error suggestion rather than silently dropping it. */
export async function classify(input: ClassifyInput): Promise<Classification> {
  const content = await chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    { json: true },
  );
  return resultSchema.parse(extractJson(content));
}
