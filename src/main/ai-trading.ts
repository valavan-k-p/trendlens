/**
 * AI trade signal and news assistant (main process). Keys stay here; the page sends only the
 * compact context, an optional chart image and the chat turns.
 * - Gemini: native generateContent (Google Search grounding for news, low thinking, JSON signals).
 * - Anthropic: Messages API (web search tool for news, low effort).
 * - Other providers: OpenAI-compatible chat, without live search.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AI_PROVIDERS, fallbackChain, isImageUnsupported, isTransientStatus, modelsToTry, parseChatResponse, retryDelayMs, shortError, type AiProviderId } from '@core/ai/providers';
import { GEMINI_BASE, geminiBody, geminiUrl, isSearchUnavailable, parseGemini, withoutOptional, withoutSearch, type GeminiOptions } from '@core/ai/gemini';
import { tokenCost, type CallUsage, type UsageKind } from '@core/ai/usage';
import { NEWS_SYSTEM, SIGNAL_SYSTEM, parseSignal, trimHistory, type ChatTurn } from '@core/ai/trading';
import type { AiCallUsage, AiChatRequest, AiChatResult, AiSignalRequest, AiSignalResult } from '../shared/api';
import { recordUsage } from './ai-usage';
import { newsFor } from './news';
import { HttpError, baseUrlFor, claudeError, headers, request } from './ai';
import { getApiKey, getSettings } from './store';

const SIGNAL_MAX_TOKENS = 400;
const CHAT_MAX_TOKENS = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Answer {
  text: string;
  model: string;
  sources: { title: string; url: string }[];
  tokens?: number;
  note?: string;
  searched: boolean;
  usage: CallUsage;
}

const NO_SEARCH_NOTE = 'Live news search is not available on this key (Google Search grounding needs a paid, billing-enabled Gemini key), so this answer has no news.';

/** Records the call locally and returns its usage with the estimated cost. */
function account(provider: AiProviderId, kind: UsageKind, a: Answer): AiCallUsage {
  const t = Date.now() / 1000;
  recordUsage({ t, provider, model: a.model, kind, ...a.usage });
  return { ...a.usage, cost: tokenCost({ t, model: a.model, ...a.usage }) };
}

interface Target {
  provider: AiProviderId;
  key?: string;
  model: string;
}

/** The main AI, then the chosen fallbacks that have a key (custom server: a base URL) and a model. */
function targets(): Target[] {
  const s = getSettings();
  const usable = (p: AiProviderId) => (p === 'custom' ? !!s.aiBaseUrl?.trim() : !!getApiKey(p) || !!AI_PROVIDERS[p].keyOptional);
  const list = fallbackChain(s.aiProvider, s.aiFallback ?? [], usable)
    .map((p) => ({ provider: p, key: getApiKey(p), model: s.aiModels[p]?.trim() || AI_PROVIDERS[p].defaultModel }))
    .filter((t) => t.model);
  if (!list.length) throw new Error(`Add your ${AI_PROVIDERS[s.aiProvider].name} API key in Settings → AI to use the AI.`);
  return list;
}

/**
 * Tries each AI in order until one answers. Any failure of one provider (quota or rate limit,
 * busy, key rejected, unreachable) moves on to the next; the note says what happened.
 */
async function withFallback(call: (t: Target) => Promise<Answer>): Promise<{ a: Answer; t: Target; note?: string }> {
  const failures: string[] = [];
  for (const t of targets()) {
    try {
      const a = await call(t);
      return { a, t, note: failures.length ? `${failures.join('; ')} → ${AI_PROVIDERS[t.provider].name} answered` : undefined };
    } catch (e) {
      failures.push(`${AI_PROVIDERS[t.provider].name}: ${shortError((e as Error).message ?? String(e))}`);
    }
  }
  throw new Error(failures.length > 1 ? `All AI providers failed. ${failures.join(' | ')}` : failures[0] ?? 'The AI did not answer.');
}

const IMAGE_SKIPPED = 'chart image skipped (text-only model)';

async function gemini(key: string, model: string, o: GeminiOptions): Promise<Answer> {
  const info = AI_PROVIDERS.gemini;
  const base = process.env.TRENDLENS_GEMINI_BASE || GEMINI_BASE;
  const busy: string[] = [];
  let last: unknown;
  let searchNote: string | undefined;
  for (const m of modelsToTry(info, model)) {
    let body = geminiBody(o);
    if (searchNote) body = withoutSearch(body);
    let stripped = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await request(geminiUrl(m, base), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, info.name);
        const r = parseGemini(res);
        return {
          text: r.text,
          model: m,
          sources: r.sources,
          tokens: r.usage.total || undefined,
          searched: !!o.search && !searchNote && (r.queries.length > 0 || r.sources.length > 0),
          note: [busy.length ? `${busy.join(' and ')} busy; ${m} answered.` : '', searchNote ?? ''].filter(Boolean).join(' ') || undefined,
          usage: { input: r.usage.input, output: r.usage.output, thoughts: r.usage.thoughts, toolTokens: r.usage.tool, searches: searchNote ? 0 : r.queries.length },
        };
      } catch (e) {
        last = e;
        const status = e instanceof HttpError ? e.status : undefined;
        if (status !== undefined && body.tools && isSearchUnavailable(status, (e as Error).message)) {
          // e.g. a free-tier key: answer without Google Search and say so.
          body = withoutSearch(body);
          searchNote = NO_SEARCH_NOTE;
          attempt--;
          continue;
        }
        if (status === 400 && !stripped) {
          // An optional setting this model does not accept: drop it and try once more.
          const nb = withoutOptional(body, (e as Error).message);
          if (nb) {
            body = nb;
            stripped = true;
            attempt--;
            continue;
          }
        }
        if (status === undefined || !isTransientStatus(status)) throw e;
        if (attempt === 0) await sleep(retryDelayMs(0));
      }
    }
    busy.push(m);
  }
  throw last;
}

async function claude(key: string, model: string, system: string, turns: ChatTurn[], o: { search: boolean; maxTokens: number }): Promise<Answer> {
  const client = new Anthropic({ apiKey: key });
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.imageBase64
      ? [
          { type: 'image', source: { type: 'base64', media_type: (t.mediaType ?? 'image/png') as 'image/png', data: t.imageBase64 } },
          { type: 'text', text: t.text },
        ]
      : t.text,
  }));
  try {
    let resp: Anthropic.Beta.BetaMessage;
    let loops = 0;
    let tokens = 0;
    const usage: CallUsage = { input: 0, output: 0, thoughts: 0, toolTokens: 0, searches: 0 };
    do {
      resp = await client.beta.messages.create({
        model,
        max_tokens: o.maxTokens,
        system,
        messages,
        output_config: { effort: 'low' },
        ...(o.search ? { tools: [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 3 }] } : {}),
      });
      tokens += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
      usage.input += resp.usage?.input_tokens ?? 0;
      usage.output += resp.usage?.output_tokens ?? 0;
      usage.searches += resp.usage?.server_tool_use?.web_search_requests ?? 0;
      // A long server-tool turn can pause; send it back so the server continues it.
      if (resp.stop_reason === 'pause_turn') messages.push({ role: 'assistant', content: resp.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
    } while (resp.stop_reason === 'pause_turn' && ++loops < 3);
    if (resp.stop_reason === 'refusal') return { text: 'The model declined this request.', model: resp.model, sources: [], tokens, searched: false, usage };
    const sources: Answer['sources'] = [];
    const seen = new Set<string>();
    let searched = false;
    const parts: string[] = [];
    for (const b of resp.content) {
      if (b.type === 'server_tool_use') searched = true;
      if (b.type !== 'text') continue;
      parts.push(b.text);
      for (const c of (b as { citations?: { url?: string; title?: string | null }[] | null }).citations ?? [])
        if (c.url && !seen.has(c.url)) {
          seen.add(c.url);
          sources.push({ title: c.title ?? c.url, url: c.url });
        }
    }
    return { text: parts.join('').trim(), model: resp.model, sources, tokens, searched: searched || sources.length > 0, usage };
  } catch (e) {
    throw claudeError(e);
  }
}

async function compatible(provider: AiProviderId, key: string | undefined, model: string, system: string, turns: ChatTurn[]): Promise<Answer> {
  const info = AI_PROVIDERS[provider];
  const messages = [
    { role: 'system', content: system },
    ...turns.map((t) => ({
      role: t.role,
      content: t.imageBase64 ? [{ type: 'text', text: t.text }, { type: 'image_url', image_url: { url: `data:${t.mediaType ?? 'image/png'};base64,${t.imageBase64}` } }] : t.text,
    })),
  ];
  const url = `${baseUrlFor(provider, getSettings().aiBaseUrl)}/chat/completions`;
  let body: unknown;
  let note: string | undefined;
  try {
    body = await request(url, { method: 'POST', headers: headers(key), body: JSON.stringify({ model, messages }) }, info.name);
  } catch (e) {
    // A text-only model rejected the chart image: ask again with text only.
    if (!(e instanceof HttpError) || !isImageUnsupported(e.status, e.message) || !turns.some((t) => t.imageBase64)) throw e;
    const textOnly = messages.map((m) => (Array.isArray(m.content) ? { ...m, content: (m.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n') } : m));
    body = await request(url, { method: 'POST', headers: headers(key), body: JSON.stringify({ model, messages: textOnly }) }, info.name);
    note = IMAGE_SKIPPED;
  }
  const r = parseChatResponse(body, model);
  const u = (body as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
  return {
    text: r.text,
    model: r.model,
    sources: [],
    tokens: u?.total_tokens,
    searched: false,
    note,
    usage: { input: u?.prompt_tokens ?? 0, output: u?.completion_tokens ?? 0, thoughts: 0, toolTokens: 0, searches: 0 },
  };
}

/** One call to one provider. */
function callTarget(t: Target, system: string, turns: ChatTurn[], o: { json?: boolean; search: boolean; maxTokens: number }): Promise<Answer> {
  if (t.provider === 'gemini')
    return gemini(t.key!, t.model, { system, turns, maxOutputTokens: o.maxTokens, json: o.json, search: o.search, thinkingLevel: 'low', mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' });
  if (t.provider === 'anthropic') return claude(t.key!, t.model, system, turns, { search: o.search, maxTokens: o.maxTokens });
  return compatible(t.provider, t.key, t.model, system, turns);
}

/** One compact trade decision: BUY_CE / BUY_PE / NO_TRADE, or HOLD / EXIT for an open trade. */
export async function aiSignal(req: AiSignalRequest): Promise<AiSignalResult> {
  // News = free RSS headlines for the instrument (works with any provider and a free-tier key).
  const pack = req.news ? await newsFor({ symbol: req.symbol, max: 15 }).catch(() => undefined) : undefined;
  const context = pack?.block ? `${req.context}\n${pack.block}` : req.context;
  const turn: ChatTurn = { role: 'user', text: context, imageBase64: req.imageBase64, mediaType: req.mediaType };
  const { a, t, note: fbNote } = await withFallback((x) => callTarget(x, SIGNAL_SYSTEM, [turn], { json: true, search: false, maxTokens: SIGNAL_MAX_TOKENS }));
  const provider = t.provider;
  const usage = account(provider, 'signal', a);
  const newsNote = req.news ? (pack?.items.length ? `${pack.items.length} free headlines (${pack.label})` : 'no recent headlines found') + (pack?.failed.length ? `; feeds unavailable: ${pack.failed.join(', ')}` : '') : '';
  const note = [fbNote, a.note, newsNote].filter(Boolean).join(' · ');
  return { signal: parseSignal(a.text), raw: a.text.slice(0, 600), model: a.model, provider: AI_PROVIDERS[provider].name, tokens: a.tokens, usage, note: note || undefined, headlines: pack?.items.length };
}

/** News / market assistant turn, with live web search where the provider supports it. */
export async function aiChat(req: AiChatRequest): Promise<AiChatResult> {
  const turns = trimHistory(req.turns, 6);
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new Error('Type a question first.');
  const mode = req.newsMode ?? 'rss';
  // Free RSS headlines for the question's topic go into the last turn (only that turn, to save tokens).
  const last = turns[turns.length - 1];
  const pack = mode !== 'off' ? await newsFor({ question: last.text, symbol: req.symbol, max: 18 }).catch(() => undefined) : undefined;
  if (pack?.block) turns[turns.length - 1] = { ...last, text: `${last.text}\n\n${pack.block}` };
  const search = mode === 'search';
  const { a, t, note: fbNote } = await withFallback((x) => callTarget(x, NEWS_SYSTEM, turns, { search, maxTokens: CHAT_MAX_TOKENS }));
  const provider = t.provider;
  const searchable = provider === 'gemini' || provider === 'anthropic';
  const note = [
    fbNote,
    a.note,
    mode !== 'off' ? (pack?.items.length ? `${pack.items.length} free headlines (${pack.label})` : 'no recent headlines found') + (pack?.failed.length ? `; feeds unavailable: ${pack.failed.join(', ')}` : '') : '',
    search && !searchable ? `${AI_PROVIDERS[provider].name} has no web search here; free headlines only.` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const usage = account(provider, 'chat', a);
  // Sources: the provider's search citations first, then the headlines that were sent.
  const seen = new Set(a.sources.map((s) => s.url));
  const rss = (pack?.items ?? []).filter((h) => !seen.has(h.link)).map((h) => ({ title: `${h.source}: ${h.title}`, url: h.link }));
  return { text: a.text || 'No answer was returned.', sources: [...a.sources, ...rss].slice(0, 10), model: a.model, provider: AI_PROVIDERS[provider].name, searched: a.searched, tokens: a.tokens, usage, note: note || undefined };
}
