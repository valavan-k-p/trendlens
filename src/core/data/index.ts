import type { ProviderId, Timeframe } from '../types';

export * from './resample';
export { parseCsv, inferTimeframe } from './csv';

/** Higher timeframes consulted by the multi-timeframe alignment module. */
export const HIGHER_TIMEFRAMES: Record<Timeframe, Timeframe[]> = {
  '1m': ['5m', '15m'],
  '5m': ['15m', '1h'],
  '15m': ['1h', '1d'],
  '30m': ['4h', '1d'],
  '1h': ['4h', '1d'],
  '4h': ['1d', '1wk'],
  '1d': ['1wk', '1mo'],
  '1wk': ['1mo'],
  '1mo': [],
};

/** Request shape shared by the renderer and the main process. */
export interface SeriesRequest {
  provider: ProviderId;
  symbol: string;
  timeframe: Timeframe;
}

/** Plain-looking crypto pair (e.g. BTCUSDT) that Binance can serve directly. */
export function looksLikeBinancePair(symbol: string): boolean {
  return /^[A-Z0-9]{2,10}(USDT|USDC|FDUSD|BTC|ETH|BNB)$/.test(symbol.toUpperCase()) && !symbol.includes('-') && !symbol.includes('.');
}
