/**
 * Yahoo Finance public chart/search/spark endpoints (no key required).
 * Pure URL builders and response parsers; the network call happens in the
 * Electron main process.
 */
import type { AssetClass, Candle, Quote, Series, SymbolInfo, Timeframe } from '../types';
import { resample } from './resample';

const BASE = 'https://query1.finance.yahoo.com';

/** Yahoo interval and history range used for each app timeframe. */
export const YAHOO_PLAN: Record<Timeframe, { interval: string; range: string; resampleTo?: Timeframe }> = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '30m': { interval: '30m', range: '2mo' },
  '1h': { interval: '60m', range: '6mo' },
  '4h': { interval: '60m', range: '2y', resampleTo: '4h' },
  '1d': { interval: '1d', range: '2y' },
  '1wk': { interval: '1wk', range: '10y' },
  '1mo': { interval: '1mo', range: 'max' },
};

export function chartUrl(symbol: string, tf: Timeframe): string {
  const p = YAHOO_PLAN[tf];
  return `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${p.interval}&range=${p.range}&includePrePost=false&events=div%2Csplit`;
}

export function searchUrl(query: string): string {
  return `${BASE}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0&listsCount=0`;
}

export function sparkUrl(symbols: string[]): string {
  return `${BASE}/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(',')}&range=1d&interval=5m`;
}

interface YahooChart {
  chart: {
    result?: {
      meta: Record<string, unknown> & {
        symbol: string;
        currency?: string;
        exchangeName?: string;
        fullExchangeName?: string;
        exchangeTimezoneName?: string;
        gmtoffset?: number;
        instrumentType?: string;
        shortName?: string;
        longName?: string;
      };
      timestamp?: number[];
      indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] };
    }[];
    error?: { code: string; description: string } | null;
  };
}

export function parseChart(json: unknown, tf: Timeframe): Series {
  const j = json as YahooChart;
  if (j?.chart?.error) throw new Error(`Yahoo: ${j.chart.error.description || j.chart.error.code}`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error('Yahoo returned no data for this symbol.');
  const ts = r.timestamp ?? [];
  const q = r.indicators.quote[0] ?? { open: [], high: [], low: [], close: [], volume: [] };
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
  }
  // Yahoo occasionally repeats the final (live) bar's timestamp; keep the last one.
  const dedup: Candle[] = [];
  for (const c of candles) {
    if (dedup.length && dedup[dedup.length - 1].time === c.time) dedup[dedup.length - 1] = c;
    else if (!dedup.length || c.time > dedup[dedup.length - 1].time) dedup.push(c);
  }
  const m = r.meta;
  const plan = YAHOO_PLAN[tf];
  const gmtOffset = typeof m.gmtoffset === 'number' ? m.gmtoffset : 0;
  const out = plan.resampleTo ? resample(dedup, plan.resampleTo, gmtOffset) : dedup;
  return {
    timeframe: tf,
    candles: out,
    meta: {
      symbol: m.symbol,
      name: m.longName ?? m.shortName,
      currency: m.currency,
      exchange: m.fullExchangeName ?? m.exchangeName,
      timezone: m.exchangeTimezoneName,
      gmtOffset,
      provider: 'yahoo',
      volumeAvailable: out.slice(-50).some((c) => c.volume > 0),
    },
  };
}

const TYPE_MAP: Record<string, AssetClass> = {
  EQUITY: 'equity',
  INDEX: 'index',
  CURRENCY: 'forex',
  CRYPTOCURRENCY: 'crypto',
  FUTURE: 'commodity',
  ETF: 'etf',
  MUTUALFUND: 'other',
};

export function parseSearch(json: unknown): SymbolInfo[] {
  const quotes = (json as { quotes?: Record<string, unknown>[] })?.quotes ?? [];
  return quotes
    .filter((q) => typeof q.symbol === 'string' && q.quoteType !== 'OPTION')
    .map((q) => ({
      symbol: q.symbol as string,
      name: ((q.longname ?? q.shortname ?? q.symbol) as string).trim(),
      exchange: (q.exchDisp ?? q.exchange ?? '') as string,
      assetClass: TYPE_MAP[q.quoteType as string] ?? 'other',
      provider: 'yahoo' as const,
    }));
}

export function parseSpark(json: unknown): Quote[] {
  const results = (json as { spark?: { result?: { symbol: string; response?: { meta: Record<string, unknown> }[] }[] } })?.spark?.result ?? [];
  const out: Quote[] = [];
  for (const r of results) {
    const m = r.response?.[0]?.meta;
    if (!m) continue;
    const price = Number(m.regularMarketPrice);
    const prev = Number(m.previousClose ?? m.chartPreviousClose);
    if (!Number.isFinite(price)) continue;
    const change = Number.isFinite(prev) ? price - prev : 0;
    out.push({
      symbol: r.symbol,
      name: (m.shortName ?? m.longName) as string | undefined,
      price,
      previousClose: prev,
      change,
      changePct: Number.isFinite(prev) && prev !== 0 ? (100 * change) / prev : 0,
      currency: m.currency as string | undefined,
      time: Number(m.regularMarketTime) || 0,
    });
  }
  return out;
}
