/** Binance public market-data API (no key required). Pure URL builders and parsers. */
import type { Candle, Quote, Series, SymbolInfo, Timeframe } from '../types';

const BASE = 'https://api.binance.com';

const INTERVAL: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1wk': '1w',
  '1mo': '1M',
};

export function klinesUrl(symbol: string, tf: Timeframe, limit = 600): string {
  return `${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${INTERVAL[tf]}&limit=${limit}`;
}

export function tickerUrl(symbols: string[]): string {
  return `${BASE}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols.map((s) => s.toUpperCase())))}`;
}

export const allPricesUrl = `${BASE}/api/v3/ticker/price`;

/** Binance klines are arrays: [openTime, open, high, low, close, volume, closeTime, ...]. */
export function parseKlines(json: unknown, symbol: string, tf: Timeframe): Series {
  if (!Array.isArray(json)) {
    const msg = (json as { msg?: string })?.msg;
    throw new Error(`Binance: ${msg ?? 'unexpected response'}`);
  }
  const candles: Candle[] = json.map((k: unknown[]) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
  const quote = QUOTE_ASSETS.find((q) => symbol.toUpperCase().endsWith(q));
  return {
    timeframe: tf,
    candles,
    meta: {
      symbol: symbol.toUpperCase(),
      name: quote ? `${symbol.toUpperCase().slice(0, -quote.length)} / ${quote}` : symbol.toUpperCase(),
      currency: quote,
      exchange: 'Binance',
      timezone: 'UTC',
      gmtOffset: 0,
      provider: 'binance',
      volumeAvailable: true,
    },
  };
}

const QUOTE_ASSETS = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY', 'BRL', 'JPY'];

/** Filters the full Binance price list by a free-text query. */
export function searchSymbols(allPrices: unknown, query: string, max = 10): SymbolInfo[] {
  if (!Array.isArray(allPrices)) return [];
  const q = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!q) return [];
  const matches = (allPrices as { symbol: string }[])
    .map((p) => p.symbol)
    .filter((s) => s.includes(q))
    .sort((a, b) => score(a, q) - score(b, q))
    .slice(0, max);
  return matches.map((s) => {
    const quote = QUOTE_ASSETS.find((x) => s.endsWith(x));
    return {
      symbol: s,
      name: quote ? `${s.slice(0, -quote.length)} / ${quote}` : s,
      exchange: 'Binance',
      assetClass: 'crypto' as const,
      provider: 'binance' as const,
      currency: quote,
    };
  });
}

function score(s: string, q: string): number {
  let v = s.startsWith(q) ? 0 : 10;
  if (s.endsWith('USDT')) v -= 5;
  return v + s.length / 100;
}

export function parseTickers(json: unknown): Quote[] {
  if (!Array.isArray(json)) return [];
  return json.map((t: Record<string, string | number>) => {
    const price = Number(t.lastPrice);
    const prev = Number(t.prevClosePrice) || price - Number(t.priceChange);
    return {
      symbol: String(t.symbol),
      price,
      previousClose: prev,
      change: Number(t.priceChange),
      changePct: Number(t.priceChangePercent),
      time: Math.floor(Number(t.closeTime) / 1000),
    };
  });
}
