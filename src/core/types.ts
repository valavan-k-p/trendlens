/** One OHLCV bar. `time` is UNIX seconds (UTC) of the bar open. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1wk' | '1mo';

export const TIMEFRAMES: { id: Timeframe; label: string; seconds: number }[] = [
  { id: '1m', label: '1 min', seconds: 60 },
  { id: '5m', label: '5 min', seconds: 300 },
  { id: '15m', label: '15 min', seconds: 900 },
  { id: '30m', label: '30 min', seconds: 1800 },
  { id: '1h', label: '1 hour', seconds: 3600 },
  { id: '4h', label: '4 hour', seconds: 14400 },
  { id: '1d', label: 'Daily', seconds: 86400 },
  { id: '1wk', label: 'Weekly', seconds: 604800 },
  { id: '1mo', label: 'Monthly', seconds: 2592000 },
];

export function timeframeSeconds(tf: Timeframe): number {
  return TIMEFRAMES.find((t) => t.id === tf)!.seconds;
}

export function timeframeLabel(tf: Timeframe): string {
  return TIMEFRAMES.find((t) => t.id === tf)!.label;
}

export type AssetClass = 'equity' | 'index' | 'forex' | 'crypto' | 'commodity' | 'etf' | 'other';

export interface SymbolInfo {
  /** Provider-specific symbol, e.g. RELIANCE.NS, ^NSEI, EURUSD=X, BTCUSDT */
  symbol: string;
  name: string;
  exchange: string;
  assetClass: AssetClass;
  provider: ProviderId;
  currency?: string;
}

export type ProviderId = 'yahoo' | 'binance' | 'csv';

export interface SeriesMeta {
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  timezone?: string;
  /** Offset of exchange time from UTC, in seconds (for session-based VWAP). */
  gmtOffset?: number;
  provider: ProviderId;
  /** True when the provider reports no real traded volume (forex, many indices). */
  volumeAvailable: boolean;
}

export interface Series {
  meta: SeriesMeta;
  timeframe: Timeframe;
  candles: Candle[];
}

export interface Quote {
  symbol: string;
  name?: string;
  price: number;
  previousClose: number;
  change: number;
  changePct: number;
  currency?: string;
  time: number;
}
