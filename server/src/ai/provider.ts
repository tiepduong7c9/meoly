import { env } from '../env.js';
import { getGlobalSettings } from './store.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Ask the server to constrain output to a JSON object. */
  json?: boolean;
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

class ProviderError extends Error {}

/**
 * Minimal OpenAI-compatible chat client (LMStudio, Ollama, OpenAI, ...).
 * One retry on transient failure, hard timeout via AbortController.
 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const gs = getGlobalSettings();
  const apiBaseUrl = gs.llmApiBaseUrl ?? env.ai.apiBaseUrl;
  const model = gs.llmModel ?? env.ai.model;
  const apiKey = gs.llmApiKey ?? env.ai.apiKey;
  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const base: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0,
    stream: false,
  };
  // response_format is best-effort: the classifier tolerates prose-wrapped JSON,
  // and some OpenAI-compatible servers 400 on an unknown field. Drop it and
  // retry once on a 400 rather than failing every classification.
  let useJson = opts.json ?? false;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = useJson ? { ...base, response_format: { type: 'json_object' } } : base;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.ai.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        // A 400 while asking for JSON mode is most likely the server rejecting
        // response_format — retry once without it.
        if (res.status === 400 && useJson) {
          useJson = false;
          lastErr = new ProviderError(`LLM API 400: ${detail}`);
          continue;
        }
        throw new ProviderError(`LLM API ${res.status}: ${detail}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new ProviderError('LLM API returned no content');
      return content;
    } catch (err) {
      lastErr = err;
      // Don't retry a JSON-shape problem we caused; only transient/network/timeout.
      if (err instanceof ProviderError && !/^LLM API 5/.test(err.message)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
}
