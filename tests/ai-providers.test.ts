import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDERS,
  apiErrorMessage,
  buildChatBody,
  chatModelIds,
  describeHttpError,
  detectProvider,
  isTransientStatus,
  modelsToTry,
  normalizeBaseUrl,
  parseChatResponse,
  retryDelayMs,
} from '@core/ai/providers';

describe('AI provider key detection', () => {
  it('recognises each provider by its key prefix', () => {
    expect(detectProvider('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('anthropic');
    expect(detectProvider('sk-or-v1-0123456789abcdef0123456789')).toBe('openrouter');
    expect(detectProvider('AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv')).toBe('gemini');
    expect(detectProvider('gsk_0123456789abcdefghij')).toBe('groq');
    expect(detectProvider('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toBe('openai');
    expect(detectProvider('  sk-AbCdEfGhIjKlMnOpQrStUvWxYz  ')).toBe('openai');
  });

  it('returns undefined for unknown formats instead of guessing', () => {
    expect(detectProvider('hello')).toBeUndefined();
    expect(detectProvider('')).toBeUndefined();
    expect(detectProvider('sk-short')).toBeUndefined();
  });

  it('gives every hosted provider a base URL and a default model', () => {
    for (const p of Object.values(AI_PROVIDERS)) {
      if (p.id === 'anthropic' || p.id === 'custom') continue;
      expect(p.baseUrl, p.id).toMatch(/^https:\/\/[^/]+.*[^/]$/);
      expect(p.defaultModel, p.id).not.toBe('');
    }
  });
});

describe('OpenAI-compatible requests', () => {
  it('sends the system prompt, the text and the image as a data URL', () => {
    const body = buildChatBody({ model: 'm', system: 'sys', text: 'hi', mediaType: 'image/png', imageBase64: 'AAAA' }) as any;
    expect(body.model).toBe('m');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('normalises custom base URLs', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1');
    expect(() => normalizeBaseUrl('file:///c:/x')).toThrow(/http/);
    expect(() => normalizeBaseUrl('not a url')).toThrow(/valid/);
  });
});

describe('OpenAI-compatible responses', () => {
  it('reads the answer text and model', () => {
    const r = parseChatResponse({ model: 'gpt-x', choices: [{ finish_reason: 'stop', message: { content: ' ## Market Condition\nBullish ' } }] }, 'req');
    expect(r).toEqual({ text: '## Market Condition\nBullish', model: 'gpt-x', refused: false, truncated: false });
  });

  it('joins content parts and flags truncation', () => {
    const r = parseChatResponse({ choices: [{ finish_reason: 'length', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }, 'req');
    expect(r.text).toBe('a\nb');
    expect(r.model).toBe('req');
    expect(r.truncated).toBe(true);
  });

  it('reports refusals and content filtering', () => {
    expect(parseChatResponse({ choices: [{ message: { content: null, refusal: 'I cannot help.' } }] }, 'm')).toMatchObject({ refused: true, text: 'I cannot help.' });
    expect(parseChatResponse({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }, 'm').refused).toBe(true);
  });

  it('surfaces OpenAI- and Gemini-style error bodies', () => {
    expect(apiErrorMessage({ error: { message: 'Incorrect API key provided' } })).toBe('Incorrect API key provided');
    expect(apiErrorMessage([{ error: { code: 400, message: 'API key not valid.' } }])).toBe('API key not valid.');
    expect(apiErrorMessage({ choices: [] })).toBeUndefined();
    expect(() => parseChatResponse({ error: { message: 'boom' } }, 'm')).toThrow('boom');
    expect(() => parseChatResponse({ choices: [] }, 'm')).toThrow(/no answer/);
  });

  it('explains HTTP failures in plain language', () => {
    expect(describeHttpError(401, 'OpenAI', 'bad key')).toMatch(/rejected the API key \(bad key\)/);
    expect(describeHttpError(400, 'Google Gemini', 'Please pass a valid API key')).toMatch(/rejected the API key/);
    expect(describeHttpError(400, 'OpenAI', 'Invalid image')).toMatch(/rejected the request \(HTTP 400\)/);
    expect(describeHttpError(404, 'Groq')).toMatch(/model/);
    expect(describeHttpError(429, 'Google Gemini')).toMatch(/quota/);
  });

  it('lists chat models from a /models response, dropping non-chat ones', () => {
    const ids = chatModelIds({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'models/gemini-2.5-flash' }, { id: 'gpt-5' }] });
    expect(ids).toEqual(['gemini-2.5-flash', 'gpt-5']);
    // Gemini's list also has live-audio, speech and image-generation models that cannot review a chart.
    const gem = chatModelIds({
      data: ['models/gemini-3.8-flash', 'models/gemini-3.8-live', 'models/gemini-3.8-flash-tts', 'models/gemini-3.1-flash-image', 'models/gemini-nano-banana-2.1', 'models/gemini-3.5-flash-lite'].map((id) => ({ id })),
    });
    expect(gem).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  });

  it('retries busy and rate-limited answers only', () => {
    expect([429, 500, 502, 503, 504].every(isTransientStatus)).toBe(true);
    expect([400, 401, 403, 404].some(isTransientStatus)).toBe(false);
    expect([retryDelayMs(0), retryDelayMs(1)]).toEqual([2000, 5000]);
  });

  it('falls back to other image-capable Gemini models only from the default', () => {
    expect(modelsToTry(AI_PROVIDERS.gemini, 'gemini-3.8-flash')).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
    expect(modelsToTry(AI_PROVIDERS.gemini, 'gemini-3.6-flash')).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
    // A model the user chose on purpose is never swapped.
    expect(modelsToTry(AI_PROVIDERS.gemini, 'gemini-4-neon')).toEqual(['gemini-4-neon']);
    expect(modelsToTry(AI_PROVIDERS.openai, 'gpt-5')).toEqual(['gpt-5']);
  });

  it('defaults Gemini to the current stable Flash model', () => {
    expect(AI_PROVIDERS.gemini.defaultModel).toBe('gemini-3.8-flash');
    expect(detectProvider('AIzaSyD-ExampleExampleExampleExample12')).toBe('gemini');
  });
});

import { fallbackChain as chainOf, isImageUnsupported as imageUnsupported, shortError as short } from '@core/ai/providers';

describe('AI fallback', () => {
  it('tries the main AI first, then ticked fallbacks that can be used, each once', () => {
    const keys = new Set(['gemini', 'groq', 'openrouter']);
    const usable = (p: string) => keys.has(p);
    expect(chainOf('gemini', ['groq', 'openrouter'], usable)).toEqual(['gemini', 'groq', 'openrouter']);
    expect(chainOf('gemini', ['openai', 'groq', 'gemini', 'groq'], usable)).toEqual(['gemini', 'groq']); // no key for OpenAI; no repeats
    expect(chainOf('anthropic', ['groq'], usable)).toEqual(['groq']); // main AI has no key: start with the fallback
    expect(chainOf('gemini', [], () => false)).toEqual([]);
  });

  it('recognises a text-only model refusing the chart image', () => {
    expect(imageUnsupported(400, 'Model does not support image input')).toBe(true);
    expect(imageUnsupported(422, "Invalid content type 'image_url'")).toBe(true);
    expect(imageUnsupported(400, 'Invalid API key')).toBe(false);
    expect(imageUnsupported(429, 'image quota exceeded')).toBe(false);
  });

  it('keeps fallback notes short', () => {
    expect(short("Error invoking remote method 'ai:signal': Error: Google Gemini rate limit or quota reached (Resource exhausted). Try again shortly.")).toBe(
      'Google Gemini rate limit or quota reached (Resource exhausted).',
    );
    expect(short('x'.repeat(200))).toHaveLength(108);
  });

  it('knows the free NVIDIA, Z.ai and Cohere endpoints', () => {
    expect(detectProvider('nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe('nvidia');
    expect(AI_PROVIDERS.nvidia).toMatchObject({ baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b' });
    expect(AI_PROVIDERS.zai).toMatchObject({ baseUrl: 'https://api.z.ai/api/paas/v4', defaultModel: 'glm-4.6v-flash' });
    expect(AI_PROVIDERS.cohere.baseUrl).toBe('https://api.cohere.ai/compatibility/v1');
  });

  it('defaults Groq and OpenRouter to free models that read images', () => {
    expect(AI_PROVIDERS.groq.defaultModel).toBe('qwen/qwen3.8-27b');
    expect(AI_PROVIDERS.openrouter.defaultModel).toMatch(/:free$/);
  });
});
