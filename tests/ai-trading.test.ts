import { describe, expect, it } from 'vitest';
import { analyze } from '@core/analysis/engine';
import { NEWS_SYSTEM, SIGNAL_SYSTEM, parseSignal, signalContext, trimHistory, type ChatTurn } from '@core/ai/trading';
import { geminiBody, geminiUrl, parseGemini, withoutOptional } from '@core/ai/gemini';
import { fromCloses, series, zigzag } from './fixtures';

const candles = fromCloses(zigzag(220, 25000, 30, 18), { step: 300 });
const report = analyze(series(candles, '5m'));

describe('AI trade signal prompt', () => {
  it('builds a compact context with the engine verdict, indicators, recent bars and options', () => {
    const ctx = signalContext({
      report,
      candles,
      options: {
        underlying: 'NIFTY',
        expiry: '2026-12-01',
        daysToExpiry: 4.06,
        lotSize: 65,
        spot: 25676,
        source: 'MT4',
        rows: [{ strike: 25700, ce: { ltp: 138.85, iv: 14.09, delta: 0.47 }, pe: { ltp: 165.95, iv: 14.09, delta: -0.53 } }],
      },
      openTrade: { option: 'NIFTY 25700 PE 01-Dec', entry: '142', stopLoss: '120', target: '185', since: 1795750000 },
    });
    expect(ctx).toMatch(/^TEST 5m last /);
    expect(ctx).toContain(`Engine: ${report.condition} bias ${report.biasScore}`);
    expect(ctx).toMatch(/EMA20 [\d.]+ EMA50 [\d.]+ RSI14 [\d.]+ ATR14 [\d.]+/);
    expect(ctx).toMatch(/Last 12 bars o,h,l,c: /);
    expect(ctx).toContain('Options NIFTY exp 2026-12-01 (4.1d) lot 65 spot 25676 [MT4]:');
    expect(ctx).toContain('25700 CE 138.85 iv14.1 d0.47 | PE 165.95 iv14.1 d-0.53');
    expect(ctx).toContain('OPEN trade: NIFTY 25700 PE 01-Dec entry 142 SL 120 target 185');
    // Token budget: the whole context stays small (a few hundred tokens ≈ under ~3,000 characters).
    expect(ctx.length).toBeLessThan(3000);
    expect(SIGNAL_SYSTEM.length).toBeLessThan(1400);
  });

  it('says when no option prices are available', () => {
    expect(signalContext({ report, candles })).toContain('Options: no live option prices; give spot levels');
  });

  it('reads the strict JSON reply, also inside code fences or with long field names', () => {
    expect(parseSignal('{"a":"BUY_PE","opt":"NIFTY 25700 PE 01-Dec","entry":"140-145","target":"185","sl":"118","note":"Lower highs, rejection at 25730"}')).toEqual({
      action: 'BUY_PE',
      option: 'NIFTY 25700 PE 01-Dec',
      entry: '140-145',
      target: '185',
      stopLoss: '118',
      note: 'Lower highs, rejection at 25730',
    });
    expect(parseSignal('```json\n{"a":"no trade","opt":"","entry":"","target":"","sl":"","note":"Inside 25704-25730 range"}\n```')).toEqual({
      action: 'NO_TRADE',
      option: undefined,
      entry: undefined,
      target: undefined,
      stopLoss: undefined,
      note: 'Inside 25704-25730 range',
    });
    expect(parseSignal('Sure! {"action":"HOLD","target":"200","stop_loss":"150"}')).toMatchObject({ action: 'HOLD', target: '200', stopLoss: '150' });
    expect(parseSignal('{"a":"SELL","opt":"x"}')).toBeUndefined();
    expect(parseSignal('no json here')).toBeUndefined();
    expect(parseSignal('{"a": BUY_CE}')).toBeUndefined();
  });

  it('keeps chat history short and sends images only once', () => {
    const turns: ChatTurn[] = [
      { role: 'assistant', text: 'old' },
      ...Array.from({ length: 9 }, (_, i): ChatTurn => ({ role: i % 2 ? 'assistant' : 'user', text: `t${i}`, imageBase64: 'AAA', mediaType: 'image/png' })),
    ];
    const kept = trimHistory(turns, 6);
    expect(kept[0].role).toBe('user');
    expect(kept.length).toBeLessThanOrEqual(6);
    expect(kept.slice(0, -1).every((t) => !t.imageBase64)).toBe(true);
    expect(kept.at(-1)!.imageBase64).toBe('AAA');
    expect(NEWS_SYSTEM).toMatch(/credible/);
  });
});

describe('Gemini native requests', () => {
  it('builds generateContent with search, low thinking, JSON and image settings', () => {
    expect(geminiUrl('gemini-3.8-flash')).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    const b = geminiBody({
      system: 'sys',
      turns: [
        { role: 'user', text: 'q1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'chart?', imageBase64: 'IMG', mediaType: 'image/jpeg' },
      ],
      maxOutputTokens: 400,
      search: true,
      json: true,
      thinkingLevel: 'low',
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
    });
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'q1' }] },
      { role: 'model', parts: [{ text: 'a1' }] },
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'IMG' } }, { text: 'chart?' }] },
    ]);
    expect(b.tools).toEqual([{ google_search: {} }]);
    expect(b.generationConfig).toEqual({ maxOutputTokens: 400, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' });
    // No image → no media resolution; no search → no tools.
    const plain = geminiBody({ system: 's', turns: [{ role: 'user', text: 'x' }], maxOutputTokens: 10, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' });
    expect(plain.tools).toBeUndefined();
    expect(plain.generationConfig).toEqual({ maxOutputTokens: 10 });
  });

  it('drops only the optional setting a 400 error names', () => {
    const b = geminiBody({ system: 's', turns: [{ role: 'user', text: 'x', imageBase64: 'I' }], maxOutputTokens: 10, json: true, thinkingLevel: 'low', mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' });
    expect(withoutOptional(b, 'Invalid value at generation_config.thinking_config.thinking_level')!.generationConfig).toEqual({ maxOutputTokens: 10, responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' });
    // A parse error that mentions "JSON payload" must not switch JSON output off.
    expect(withoutOptional(b, 'Invalid JSON payload received. Unknown name "thinkingLevel" at generation_config.thinking_config')!.generationConfig).toEqual({ maxOutputTokens: 10, responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' });
    expect(withoutOptional(b, 'mediaResolution is not supported')!.generationConfig).toEqual({ maxOutputTokens: 10, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json' });
    expect(withoutOptional(b, 'Request contains an invalid argument.')!.generationConfig).toEqual({ maxOutputTokens: 10 });
    expect(withoutOptional({ generationConfig: { maxOutputTokens: 10 } }, 'bad')).toBeUndefined();
  });

  it('reads text without thought parts, de-duplicated sources and token use', () => {
    const r = parseGemini({
      candidates: [
        {
          content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Direction: Bearish (65%), 1-3 days\n' }, { text: '• OPEC+ hike — Reuters' }] },
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: ['crude oil news today'],
            groundingChunks: [{ web: { uri: 'https://www.reuters.com/a', title: 'reuters.com' } }, { web: { uri: 'https://www.reuters.com/a', title: 'dup' } }, { web: { uri: 'ftp://x', title: 'bad' } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 820, candidatesTokenCount: 140, thoughtsTokenCount: 60, totalTokenCount: 1020 },
    });
    expect(r.text).toBe('Direction: Bearish (65%), 1-3 days\n• OPEC+ hike — Reuters');
    expect(r.sources).toEqual([{ title: 'reuters.com', url: 'https://www.reuters.com/a' }]);
    expect(r.queries).toEqual(['crude oil news today']);
    expect(r.usage).toEqual({ input: 820, output: 140, thoughts: 60, tool: 0, total: 1020 });
    expect(() => parseGemini({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/blocked/);
    expect(() => parseGemini({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] })).toThrow(/MAX_TOKENS/);
    expect(() => parseGemini({})).toThrow(/no answer/);
  });
});

import { priceFor, summarizeUsage, tokenCost, usd, type UsageRecord } from '@core/ai/usage';
import { sessionText } from '@core/ai/trading';
import { sessionInfo } from '@core/options/option-contracts';
import { isSearchUnavailable, withoutSearch } from '@core/ai/gemini';

describe('AI usage and cost', () => {
  const t = Date.UTC(2026, 10, 27, 10, 0) / 1000; // 27 Nov 2026 15:30 IST
  const rec = (o: Partial<UsageRecord>): UsageRecord => ({ t, provider: 'gemini', model: 'gemini-3.8-flash', kind: 'signal', input: 1650, output: 90, thoughts: 201, toolTokens: 0, searches: 0, ...o });

  it('prices Gemini 3.8 Flash at $0.75 / $3.75 per 1M now and $1.50 / $7.50 from 2027', () => {
    expect(priceFor('gemini-3.8-flash', t)).toEqual({ input: 0.75, output: 3.75 });
    expect(priceFor('gemini-3.8-flash', Date.UTC(2027, 0, 1, 12) / 1000)).toMatchObject({ input: 1.5, output: 7.5 });
    expect(priceFor('unknown-model', t)).toBeUndefined();
    // 1,650 in + 291 out/thinking: 1650 × 0.75 + 291 × 3.75 = 2328.75 per 1M → $0.00232875.
    expect(tokenCost(rec({}))).toBeCloseTo(0.00232875, 10);
    expect(tokenCost(rec({ toolTokens: 1000 }))).toBeCloseTo(0.00232875 + 0.00075, 10); // search results billed as input
    expect(usd(0.00232875)).toBe('$0.0023');
    expect(usd(0)).toBe('$0');
    expect(usd(1.234)).toBe('$1.23');
  });

  it('totals today, this month and all time, with searches beyond the free 5,000', () => {
    const s = summarizeUsage(
      [
        rec({}),
        rec({ kind: 'chat', searches: 2, toolTokens: 900 }),
        rec({ t: t - 3 * 86400 }), // earlier this month
        rec({ t: t - 40 * 86400 }), // last month
        rec({ model: 'mystery', t }),
        rec({ t: t - 86400, searches: 5000 }),
      ],
      t,
    );
    expect(s.today.calls).toBe(3);
    expect(s.today.searches).toBe(2);
    expect(s.today.unpriced).toBe(1);
    expect(s.month.calls).toBe(5);
    expect(s.all.calls).toBe(6);
    expect(s.paidSearchesThisMonth).toBe(2);
    expect(s.searchCostThisMonth).toBeCloseTo(0.028, 10);
  });
});

describe('market session for signals', () => {
  const ist = (d: number, h: number, m: number) => Date.UTC(2026, 10, d, h, m) / 1000 - 19800;
  it('knows NSE is closed after 15:30 and finds the next weekday open', () => {
    expect(sessionInfo('NSE', ist(27, 15, 58))).toMatchObject({ open: false, nextOpen: ist(30, 9, 15) }); // Fri → Mon 30 Nov
    expect(sessionInfo('NSE', ist(27, 14, 15))).toMatchObject({ open: true, minutesToClose: 75 });
    expect(sessionInfo('NSE', ist(27, 8, 0))).toMatchObject({ open: false, nextOpen: ist(27, 9, 15) });
    expect(sessionInfo('MCX', ist(27, 20, 0))).toMatchObject({ open: true });
    expect(sessionText('NSE', ist(27, 15, 58)).text).toBe('NSE CLOSED (09:15–15:30 IST); next open Mon 30 Nov 09:15 IST');
    expect(sessionText('NSE', ist(27, 14, 15)).text).toBe('NSE OPEN, 75 min to close (09:15–15:30 IST)');
  });

  it('puts the session in the prompt and keeps the full reason and news', () => {
    expect(signalContext({ report, candles, session: 'NSE CLOSED (09:15–15:30 IST)' })).toContain('Session: NSE CLOSED');
    const long = 'Price hovering directly on support after liquidity sweep with compressed momentum';
    expect(parseSignal(`{"a":"NO_TRADE","note":"${long}","news":"FII selling, weak global cues ↓"}`)).toMatchObject({ note: long, news: 'FII selling, weak global cues ↓' });
    expect(SIGNAL_SYSTEM).toContain('If Session is CLOSED');
  });

  it('answers without search when the key cannot use Google Search', () => {
    expect(isSearchUnavailable(400, 'Search grounding is not supported for this tier')).toBe(true);
    expect(isSearchUnavailable(429, 'Quota exceeded for google_search')).toBe(true);
    expect(isSearchUnavailable(400, 'Invalid value at thinking_level')).toBe(false);
    expect(withoutSearch({ contents: [], tools: [{ google_search: {} }] })).toEqual({ contents: [] });
  });
});
