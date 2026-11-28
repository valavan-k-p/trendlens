/**
 * Optional chart-image review using the user's own API key for one of several AI providers.
 * Keys are decrypted here in the main process and never sent to the renderer.
 * Anthropic goes through its official SDK; every other provider through the
 * OpenAI-compatible Chat Completions endpoint.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  AI_PROVIDERS,
  apiErrorMessage,
  buildChatBody,
  chatModelIds,
  describeHttpError,
  isTransientStatus,
  modelsToTry,
  normalizeBaseUrl,
  parseChatResponse,
  retryDelayMs,
  type AiProviderId,
} from '@core/ai/providers';
import type { AiTestRequest, AiTestResult, ChartReviewRequest, ChartReviewResult } from '../shared/api';
import { getApiKey, getSettings } from './store';

const SYSTEM = `You are a technical-analysis tutor inside a personal desktop app.
The user shares a screenshot of a price chart. Write an educational, structured review of what the chart shows.

Use exactly these sections, as Markdown headings:
## Market Condition  (Bullish / Bearish / Neutral / Consolidating, one line of reasoning)
## Confidence  (Low / Medium / High, and what limits it)
## Structure  (trend, swing sequence, breaks of structure, market phase)
## Momentum & Volatility
## Liquidity & Smart-Money Observations  (sweeps, traps, order blocks, imbalances — only if visible)
## Key Levels  (support, resistance, psychological levels; give prices only if they are legible on the chart)
## Risk Environment  (no-trade zones, late-entry or counter-trend cautions)
## Insight Summary  (3-4 sentences)
## Bottom Line

Rules: describe what is visible and say plainly when something cannot be read from the image (symbol, timeframe, exact prices).
Do not invent numbers. Do not give buy/sell instructions, position sizes, or personalised financial advice;
frame conclusions as context and conditions. End with: "Educational review only — not financial advice."`;

const TIMEOUT_MS = 180_000;
const CUT_OFF = '\n\n_(Response was cut off at the output limit.)_';

export async function reviewChart(req: ChartReviewRequest): Promise<ChartReviewResult> {
  const settings = getSettings();
  const provider = settings.aiProvider;
  const info = AI_PROVIDERS[provider];
  const apiKey = getApiKey(provider);
  if (!apiKey && !info.keyOptional) throw new Error(`Add your ${info.name} API key in Settings to use AI chart review.`);
  const model = settings.aiModels[provider]?.trim() || info.defaultModel;
  if (!model) throw new Error(`Enter a model name for ${info.name} in Settings.`);

  const text = [
    req.prompt?.trim() ? `User note: ${req.prompt.trim()}` : 'Please review this chart.',
    req.context ? `\nThe app's own rule-based analysis of the currently loaded instrument (may or may not match the screenshot):\n${req.context}` : '',
  ].join('\n');

  if (provider === 'anthropic') return reviewWithClaude(apiKey!, model, req, text);

  const baseUrl = baseUrlFor(provider, settings.aiBaseUrl);
  const candidates = modelsToTry(info, model);
  const busy: string[] = [];
  let last: unknown;
  for (const m of candidates) {
    const payload = JSON.stringify(buildChatBody({ model: m, system: SYSTEM, text, mediaType: req.mediaType, imageBase64: req.imageBase64 }));
    // Two tries per model (one retry after a short wait); then move on to the next model.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = await request(`${baseUrl}/chat/completions`, { method: 'POST', headers: headers(apiKey), body: payload }, info.name);
        const r = parseChatResponse(body, m);
        const note = busy.length ? `${busy.join(' and ')} ${busy.length > 1 ? 'were' : 'was'} busy, so ${m} reviewed this chart.` : attempt ? `${m} was busy at first; it answered on a retry.` : undefined;
        if (r.refused) return { text: r.text || 'The model declined to review this image.', model: r.model, provider: info.name, refused: true, note };
        return { text: (r.text || 'No review text was returned.') + (r.truncated ? CUT_OFF : ''), model: r.model, provider: info.name, refused: false, note };
      } catch (e) {
        last = e;
        const status = e instanceof HttpError ? e.status : undefined;
        if (status === undefined || !isTransientStatus(status)) throw e;
        if (attempt === 0) await new Promise((res) => setTimeout(res, retryDelayMs(attempt)));
      }
    }
    busy.push(m);
  }
  if (candidates.length > 1 && last instanceof Error)
    throw new Error(`${info.name} is busy right now: ${candidates.join(', ')} all returned “try again later”. This is on Google's side and usually passes within minutes. ${last.message}`);
  throw last;
}

/** An HTTP failure from a provider, keeping the status so busy/rate-limit errors can be retried. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function reviewWithClaude(apiKey: string, model: string, req: ChartReviewRequest, text: string): Promise<ChartReviewResult> {
  const label = AI_PROVIDERS.anthropic.name;
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'high' },
      // Server-side refusal fallback: on a safety decline the API re-runs the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: req.mediaType, data: req.imageBase64 } },
            { type: 'text', text },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return { text: 'The model declined to review this image. Try a cleaner chart screenshot.', model: response.model, provider: label, refused: true };
    }
    const out = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const truncated = response.stop_reason === 'max_tokens' ? CUT_OFF : '';
    return { text: (out || 'No review text was returned.') + truncated, model: response.model, provider: label, refused: false };
  } catch (error) {
    throw claudeError(error);
  }
}

export function claudeError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) return new Error('The Anthropic API key was rejected. Check it in Settings.');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error('This API key cannot use the selected model.');
  if (error instanceof Anthropic.NotFoundError) return new Error('Anthropic could not find that model. Check the model name in Settings.');
  if (error instanceof Anthropic.RateLimitError) return new Error('Rate limited by the Anthropic API — try again shortly.');
  if (error instanceof Anthropic.BadRequestError) return new Error(`Request rejected: ${error.message}`);
  if (error instanceof Anthropic.APIError) return new Error(`Anthropic API error ${error.status ?? ''}: ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Anthropic API. Check your connection.');
  return error instanceof Error ? error : new Error(String(error));
}

export function baseUrlFor(provider: AiProviderId, custom?: string): string {
  if (provider === 'custom') {
    if (!custom?.trim()) throw new Error('Enter the server base URL for the OpenAI-compatible provider in Settings.');
    return normalizeBaseUrl(custom);
  }
  return AI_PROVIDERS[provider].baseUrl!;
}

export function headers(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-Title': 'TrendLens' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/** fetch with a timeout; turns HTTP and network failures into plain-language errors. */
export async function request(url: string, init: RequestInit, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error(`${label} did not answer within ${TIMEOUT_MS / 1000} s.`);
    throw new Error(`Could not reach ${label}. Check your connection and, for a custom server, the base URL.`);
  }
  const raw = await res.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const detail = (body !== undefined ? apiErrorMessage(body) : undefined) ?? raw.slice(0, 200).trim();
    throw new HttpError(describeHttpError(res.status, label, detail || undefined), res.status);
  }
  if (body === undefined) throw new Error(`${label} returned an unreadable response.`);
  return body;
}

/** Checks a key (typed or stored) by listing the provider's models. */
export async function testAi(req: AiTestRequest): Promise<AiTestResult> {
  const info = AI_PROVIDERS[req.provider];
  if (!info) return { ok: false, models: [], error: 'Unknown AI provider.' };
  const apiKey = req.key?.trim() || getApiKey(req.provider);
  if (!apiKey && !info.keyOptional) return { ok: false, models: [], error: `Enter a ${info.name} API key first.` };
  try {
    if (req.provider === 'anthropic') {
      const client = new Anthropic({ apiKey: apiKey!, timeout: 30_000 });
      const models: string[] = [];
      try {
        for await (const m of client.models.list()) models.push(m.id);
      } catch (error) {
        throw claudeError(error);
      }
      return { ok: true, models };
    }
    const base = baseUrlFor(req.provider, req.baseUrl ?? getSettings().aiBaseUrl);
    // OpenRouter's model list is public, so check the key on its own endpoint first.
    if (req.provider === 'openrouter') await request(`${base}/key`, { headers: headers(apiKey) }, info.name);
    const body = await request(`${base}/models`, { headers: headers(apiKey) }, info.name);
    return { ok: true, models: chatModelIds(body) };
  } catch (e) {
    return { ok: false, models: [], error: (e as Error).message };
  }
}
