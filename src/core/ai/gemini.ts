/**
 * Google Gemini native API (generateContent), used instead of the OpenAI-compatible endpoint
 * where it matters: Google Search grounding for news, a low thinking level and capped output to
 * keep token use down, and JSON output for trade signals.
 * POST {base}/models/{model}:generateContent with header x-goog-api-key.
 */
import type { ChatTurn } from './trading';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const geminiUrl = (model: string, base = GEMINI_BASE) => `${base.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;

export interface GeminiOptions {
  system: string;
  turns: ChatTurn[];
  maxOutputTokens: number;
  /** Ground the answer with Google Search. */
  search?: boolean;
  /** Ask for application/json output. */
  json?: boolean;
  /** Gemini 3 thinking level; 'low' keeps thinking tokens down. */
  thinkingLevel?: 'low' | 'medium' | 'high';
  /** Lower image cost (Gemini 3: medium ≈ 560 tokens per image instead of 1120). */
  mediaResolution?: 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH';
}

export function geminiBody(o: GeminiOptions): Record<string, unknown> {
  const contents = o.turns.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [...(t.imageBase64 ? [{ inlineData: { mimeType: t.mediaType ?? 'image/png', data: t.imageBase64 } }] : []), { text: t.text }],
  }));
  const generationConfig: Record<string, unknown> = { maxOutputTokens: o.maxOutputTokens };
  if (o.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: o.thinkingLevel };
  if (o.json) generationConfig.responseMimeType = 'application/json';
  if (o.mediaResolution && o.turns.some((t) => t.imageBase64)) generationConfig.mediaResolution = o.mediaResolution;
  const body: Record<string, unknown> = { systemInstruction: { parts: [{ text: o.system }] }, contents, generationConfig };
  if (o.search) body.tools = [{ google_search: {} }];
  return body;
}

/**
 * After a 400 that names an optional setting (thinking, media resolution, JSON mode), returns the
 * body without the settings it mentions so the request can be retried once; undefined if nothing
 * optional can be dropped.
 */
/** True when an error says the search tool is not available (e.g. a free-tier key: grounding is paid only). */
export function isSearchUnavailable(status: number, message: string): boolean {
  return (status === 400 || status === 403 || status === 429) && /search|grounding|google_search|tool/i.test(message);
}

/** The body without the Google Search tool. */
export function withoutSearch(body: Record<string, unknown>): Record<string, unknown> {
  const { tools: _t, ...rest } = body;
  return rest;
}

export function withoutOptional(body: Record<string, unknown>, error: string): Record<string, unknown> | undefined {
  const gc = { ...((body.generationConfig as Record<string, unknown>) ?? {}) };
  const before = Object.keys(gc).length;
  // Match field names, not words like "JSON payload" that appear in every parse error.
  const e = error.toLowerCase().replace(/_/g, '');
  const thinking = /thinkingconfig|thinkinglevel/.test(e);
  const media = /mediaresolution/.test(e);
  const mime = /responsemimetype/.test(e);
  const all = !thinking && !media && !mime;
  if (all || thinking) delete gc.thinkingConfig;
  if (all || media) delete gc.mediaResolution;
  if (all || mime) delete gc.responseMimeType;
  return Object.keys(gc).length < before ? { ...body, generationConfig: gc } : undefined;
}

export interface GeminiResult {
  text: string;
  sources: { title: string; url: string }[];
  queries: string[];
  finishReason?: string;
  usage: { input: number; output: number; thoughts: number; tool: number; total: number };
}

export function parseGemini(body: unknown): GeminiResult {
  const b = body as {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
      finishReason?: string;
      groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[]; webSearchQueries?: string[] };
    }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number; totalTokenCount?: number };
    promptFeedback?: { blockReason?: string };
  };
  if (b?.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${b.promptFeedback.blockReason}).`);
  const c = b?.candidates?.[0];
  if (!c) throw new Error('Gemini returned no answer.');
  const text = (c.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
  const seen = new Set<string>();
  const sources = (c.groundingMetadata?.groundingChunks ?? [])
    .map((g) => ({ title: g.web?.title ?? '', url: g.web?.uri ?? '' }))
    .filter((s) => /^https?:\/\//.test(s.url) && !seen.has(s.url) && seen.add(s.url));
  const u = b.usageMetadata ?? {};
  if (!text && c.finishReason && c.finishReason !== 'STOP') throw new Error(`Gemini stopped without an answer (${c.finishReason}).`);
  return {
    text,
    sources,
    queries: c.groundingMetadata?.webSearchQueries ?? [],
    finishReason: c.finishReason,
    usage: { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thoughts: u.thoughtsTokenCount ?? 0, tool: u.toolUsePromptTokenCount ?? 0, total: u.totalTokenCount ?? 0 },
  };
}
