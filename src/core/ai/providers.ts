/**
 * AI providers for the optional chart-image review. Pure helpers only (no network):
 * provider catalogue, key detection, and the OpenAI-compatible request/response shapes
 * used by every provider except Anthropic (which goes through its own SDK).
 */

export type AiProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'groq' | 'nvidia' | 'zai' | 'cohere' | 'custom';
/** 'auto' picks the provider from the key's prefix when the key is saved. */
export type AiProviderSetting = AiProviderId | 'auto';

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  /** Short name for messages, e.g. "Gemini". */
  name: string;
  /** OpenAI-compatible base URL (ends without a slash). Anthropic uses its SDK instead. */
  baseUrl?: string;
  defaultModel: string;
  keyHint: string;
  keysUrl?: string;
  /** Local servers such as Ollama need no key. */
  keyOptional?: boolean;
  note?: string;
  /** Image-capable models tried, in order, when the default model is overloaded or rate-limited. */
  fallbackModels?: string[];
}

export const AI_PROVIDERS: Record<AiProviderId, AiProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-opus-5-5',
    keyHint: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
    keyHint: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Stable since Sep 2026 and accepts images; gemini-2.5-flash is deprecated (rerouted from 1 Dec 2026).
    defaultModel: 'gemini-3.8-flash',
    // Stable Gemini models that accept images, used only while the chosen model is busy.
    fallbackModels: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    keyHint: 'AIza…',
    keysUrl: 'https://aistudio.google.com/apikey',
    note: 'Google AI Studio keys include a free usage tier.',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    label: 'OpenRouter (many models, one key)',
    baseUrl: 'https://openrouter.ai/api/v1',
    // A free model (OpenRouter's ':free' variants cost nothing; openrouter/auto routes to paid models).
    defaultModel: 'google/gemma-4-31b-it:free',
    keyHint: 'sk-or-…',
    keysUrl: 'https://openrouter.ai/keys',
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // On Groq's free plan and reads images (chart screenshots).
    defaultModel: 'qwen/qwen3.8-27b',
    keyHint: 'gsk_…',
    keysUrl: 'https://console.groq.com/keys',
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    label: 'NVIDIA NIM (free endpoints)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // Free endpoint, reads images.
    defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    keyHint: 'nvapi-…',
    keysUrl: 'https://build.nvidia.com',
    note: 'Free with an NVIDIA Developer Program account; rate-limited per model.',
  },
  zai: {
    id: 'zai',
    name: 'Z.ai',
    label: 'Z.ai GLM (free Flash models)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    // Listed as free on Z.ai's pricing page, under vision models.
    defaultModel: 'glm-4.6v-flash',
    keyHint: 'Z.ai API key',
    keysUrl: 'https://z.ai/manage-apikey/apikey-list',
    note: 'GLM-4.6V-Flash, GLM-4.5-Flash and GLM-4.7-Flash are free.',
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere',
    label: 'Cohere (trial key)',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-a-plus-05-2026',
    keyHint: 'Cohere API key',
    keysUrl: 'https://dashboard.cohere.com/api-keys',
    note: 'Trial keys: 1,000 calls a month, 20 a minute. Text only: the chart image is skipped.',
  },
  custom: {
    id: 'custom',
    name: 'Custom server',
    label: 'Other OpenAI-compatible (DeepSeek, Ollama, LM Studio…)',
    defaultModel: '',
    keyHint: 'key (leave empty for a local server)',
    keyOptional: true,
    note: 'Enter the server base URL, e.g. http://localhost:11434/v1 for Ollama. The model must accept images.',
  },
};

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProviderId[];

/** Guesses the provider from a key's well-known prefix; undefined when it cannot tell. */
export function detectProvider(key: string): AiProviderId | undefined {
  const k = key.trim();
  if (/^sk-ant-/i.test(k)) return 'anthropic';
  if (/^sk-or-/i.test(k)) return 'openrouter';
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) return 'gemini';
  if (/^gsk_/i.test(k)) return 'groq';
  if (/^nvapi-/i.test(k)) return 'nvidia';
  if (/^sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/.test(k)) return 'openai';
  return undefined;
}

/** Normalises a user-entered base URL: http(s) only, no trailing slash, no /chat/completions suffix. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '');
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('The base URL is not a valid address (e.g. http://localhost:11434/v1).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The base URL must start with http:// or https://.');
  return u;
}

export interface ChatImageRequest {
  model: string;
  system: string;
  text: string;
  mediaType: string;
  imageBase64: string;
}

/** OpenAI Chat Completions body with an inline base64 image (also accepted by Gemini, OpenRouter, Groq, Ollama). */
export function buildChatBody(r: ChatImageRequest): Record<string, unknown> {
  return {
    model: r.model,
    messages: [
      { role: 'system', content: r.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: r.text },
          { type: 'image_url', image_url: { url: `data:${r.mediaType};base64,${r.imageBase64}` } },
        ],
      },
    ],
  };
}

export interface ChatResult {
  text: string;
  model: string;
  refused: boolean;
  truncated: boolean;
}

/** Reads a Chat Completions response; throws with the API's own message on an error payload. */
export function parseChatResponse(body: unknown, requestedModel: string): ChatResult {
  const err = apiErrorMessage(body);
  if (err) throw new Error(err);
  const b = body as { model?: string; choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: string | null } }[] };
  const choice = b?.choices?.[0];
  if (!choice) throw new Error('The AI service returned no answer.');
  const model = b.model || requestedModel;
  const msg = choice.message ?? {};
  if (msg.refusal) return { text: String(msg.refusal), model, refused: true, truncated: false };
  if (choice.finish_reason === 'content_filter') return { text: 'The model declined to review this image. Try a cleaner chart screenshot.', model, refused: true, truncated: false };
  const content = msg.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p: { text?: string }) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
        : '';
  return { text: text.trim(), model, refused: false, truncated: choice.finish_reason === 'length' };
}

/** Extracts an error message from OpenAI-style ({error:{message}}) or Gemini-style ([{error:{message}}]) bodies. */
export function apiErrorMessage(body: unknown): string | undefined {
  const b = Array.isArray(body) ? body[0] : body;
  const e = (b as { error?: unknown } | null)?.error;
  if (!e) return undefined;
  if (typeof e === 'string') return e;
  const m = (e as { message?: unknown }).message;
  return typeof m === 'string' && m ? m : 'The AI service returned an error.';
}

/** Plain-language message for an HTTP failure from a provider. */
export function describeHttpError(status: number, providerLabel: string, detail?: string): string {
  const d = detail ? ` (${detail})` : '';
  // Gemini answers a bad key with HTTP 400 "API key not valid".
  if (status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(detail ?? ''))) return `${providerLabel} rejected the API key${d}. Check it in Settings.`;
  if (status === 404) return `${providerLabel} could not find that model or address${d}. Check the model name in Settings.`;
  if (status === 402) return `${providerLabel} says the account has no credit${d}.`;
  if (status === 429) return `${providerLabel} rate limit or quota reached${d}. Try again shortly.`;
  if (status >= 500) return `${providerLabel} is having problems (HTTP ${status})${d}. Try again later.`;
  return `${providerLabel} rejected the request (HTTP ${status})${d}.`;
}

/** HTTP statuses worth retrying: overloaded / unavailable / gateway errors and rate limits. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Models to try for one review: the chosen model first, then the provider's fallbacks. Fallbacks
 * apply only when the chosen model is the provider default or itself a fallback, so a model the
 * user picked on purpose is never silently swapped for another.
 */
export function modelsToTry(info: AiProviderInfo, model: string): string[] {
  const fb = info.fallbackModels ?? [];
  if (model !== info.defaultModel && !fb.includes(model)) return [model];
  return [model, ...fb.filter((m) => m !== model)];
}

/**
 * The order AI providers are tried in: the main one first, then the chosen fallbacks, each once,
 * keeping only those that can be used (a saved key, or a base URL for the custom server).
 */
export function fallbackChain(primary: AiProviderId, fallbacks: readonly AiProviderId[], usable: (p: AiProviderId) => boolean): AiProviderId[] {
  const out: AiProviderId[] = [];
  for (const p of [primary, ...fallbacks]) if (AI_PROVIDERS[p] && !out.includes(p) && usable(p)) out.push(p);
  return out;
}

/** A provider refusing an image because the model is text-only. */
export function isImageUnsupported(status: number, message: string): boolean {
  return (status === 400 || status === 404 || status === 415 || status === 422) && /image|vision|multimodal|image_url|modalit/i.test(message);
}

/** First sentence of an error, short enough for a one-line note. */
export function shortError(message: string): string {
  const m = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim();
  const first = m.split(/(?<=[.!?])\s/)[0];
  return first.length > 110 ? `${first.slice(0, 107)}…` : first;
}

/** Wait before retry n (0-based): 2 s, then 5 s. */
export const retryDelayMs = (attempt: number) => (attempt === 0 ? 2000 : 5000);

/** Model ids from a /models listing, without embedding, audio and image-generation models. */
export function chatModelIds(body: unknown): string[] {
  const data = (body as { data?: { id?: string }[] })?.data ?? [];
  // Drops models that cannot answer a chat request about an image (embeddings, speech, live audio, image/video generation).
  const skip = /embed|tts|whisper|dall-e|audio|realtime|transcribe|moderation|image-gen|imagen|-image|banana|-live|search|davinci|babbage|aqa|veo/i;
  return [...new Set(data.map((m) => String(m.id ?? '').replace(/^models\//, '')).filter((id) => id && !skip.test(id)))].sort();
}
