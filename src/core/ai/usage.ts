/**
 * AI usage accounting: what each call used (input, output, thinking, search) and an estimated
 * cost at the provider's published paid-tier prices. Providers do not report remaining credits
 * through their APIs, so these are TrendLens's own counts of the calls it made.
 */
import type { AiProviderId } from './providers';

export type UsageKind = 'signal' | 'chat' | 'review';

export interface CallUsage {
  input: number;
  output: number;
  thoughts: number;
  /** Tokens of search results fed to the model (billed as input). */
  toolTokens: number;
  /** Web searches the model ran. */
  searches: number;
}

export interface UsageRecord extends CallUsage {
  t: number;
  provider: AiProviderId;
  model: string;
  kind: UsageKind;
}

interface Price {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens (thinking included). */
  output: number;
  /** Price applies from this date (YYYY-MM-DD); the latest matching entry wins. */
  from?: string;
}

/** Gemini API paid-tier prices (Google AI pricing page, read 27 Nov 2026). */
const PRICES: Record<string, Price[]> = {
  'gemini-3.8-flash': [
    { input: 0.75, output: 3.75 },
    { input: 1.5, output: 7.5, from: '2027-01-01' },
  ],
  'gemini-3.6-flash': [
    { input: 0.75, output: 3.75 },
    { input: 1.5, output: 7.5, from: '2027-01-01' },
  ],
  'gemini-3.5-flash-lite': [{ input: 0.3, output: 2.5 }],
  // Z.ai lists these as free.
  'glm-4.6v-flash': [{ input: 0, output: 0 }],
  'glm-4.5-flash': [{ input: 0, output: 0 }],
  'glm-4.7-flash': [{ input: 0, output: 0 }],
};

/** Gemini 3+: 5,000 grounded searches free per month, then $14 per 1,000. */
export const SEARCH_FREE_PER_MONTH = 5000;
export const SEARCH_USD_PER_1000 = 14;

export function priceFor(model: string, t: number): Price | undefined {
  const list = PRICES[model];
  if (!list) return undefined;
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  return [...list].filter((p) => !p.from || p.from <= day).pop();
}

/** Estimated USD for one call's tokens at paid-tier prices (searches are counted separately). */
export function tokenCost(r: Pick<UsageRecord, 'model' | 't'> & CallUsage): number | undefined {
  const p = priceFor(r.model, r.t);
  if (!p) return undefined;
  return ((r.input + r.toolTokens) * p.input + (r.output + r.thoughts) * p.output) / 1e6;
}

export interface UsageTotals extends CallUsage {
  calls: number;
  /** Token cost of the calls with a known price. */
  cost: number;
  /** Calls whose model has no known price (cost not included). */
  unpriced: number;
}

const empty = (): UsageTotals => ({ calls: 0, input: 0, output: 0, thoughts: 0, toolTokens: 0, searches: 0, cost: 0, unpriced: 0 });

function add(a: UsageTotals, r: UsageRecord): UsageTotals {
  const c = tokenCost(r);
  return {
    calls: a.calls + 1,
    input: a.input + r.input,
    output: a.output + r.output,
    thoughts: a.thoughts + r.thoughts,
    toolTokens: a.toolTokens + r.toolTokens,
    searches: a.searches + r.searches,
    cost: a.cost + (c ?? 0),
    unpriced: a.unpriced + (c === undefined ? 1 : 0),
  };
}

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

export interface UsageSummary {
  today: UsageTotals;
  month: UsageTotals;
  all: UsageTotals;
  /** Searches this calendar month beyond the free 5,000, and their estimated cost. */
  paidSearchesThisMonth: number;
  searchCostThisMonth: number;
}

export function summarizeUsage(records: UsageRecord[], now = Date.now() / 1000): UsageSummary {
  const today = istDay(now);
  const month = today.slice(0, 7);
  let t = empty();
  let m = empty();
  let all = empty();
  for (const r of records) {
    all = add(all, r);
    const d = istDay(r.t);
    if (d.slice(0, 7) === month) m = add(m, r);
    if (d === today) t = add(t, r);
  }
  const paidSearches = Math.max(0, m.searches - SEARCH_FREE_PER_MONTH);
  return { today: t, month: m, all, paidSearchesThisMonth: paidSearches, searchCostThisMonth: (paidSearches * SEARCH_USD_PER_1000) / 1000 };
}

/** "$0.0021" style with enough digits for tiny amounts. */
export function usd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}
