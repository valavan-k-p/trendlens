import { describe, expect, it } from 'vitest';
import { formatWatchlist, parseWatchlist } from '@core/watchlist';

describe('watchlist parsing', () => {
  it('keeps =X and =F as part of Yahoo symbols', () => {
    expect(parseWatchlist('EURUSD=X=EURUSD, GC=F=GOLD, CL=F, JPY=X')).toEqual([
      { symbol: 'EURUSD=X', label: 'EURUSD', provider: 'yahoo' },
      { symbol: 'GC=F', label: 'GOLD', provider: 'yahoo' },
      { symbol: 'CL=F', label: undefined, provider: 'yahoo' },
      { symbol: 'JPY=X', label: undefined, provider: 'yahoo' },
    ]);
  });

  it('handles plain labels, labels starting with X/F, and Binance pairs', () => {
    expect(parseWatchlist('^NSEI=NIFTY\nAAPL=Xapple, btcusdt=BTC, FOO=Fancy')).toEqual([
      { symbol: '^NSEI', label: 'NIFTY', provider: 'yahoo' },
      { symbol: 'AAPL', label: 'Xapple', provider: 'yahoo' },
      { symbol: 'BTCUSDT', label: 'BTC', provider: 'binance' },
      { symbol: 'FOO', label: 'Fancy', provider: 'yahoo' },
    ]);
  });

  it('round-trips through formatWatchlist', () => {
    const text = 'EURUSD=X=EURUSD, GC=F=GOLD, AAPL, BTCUSDT=BTCUSD';
    expect(formatWatchlist(parseWatchlist(text))).toBe(text);
  });
});
