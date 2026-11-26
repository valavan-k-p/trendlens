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

  it('reads MT4-prefixed symbols in their original case', () => {
    expect(parseWatchlist('MT4:USOil=USOIL, mt4:NIFTY#, MT4:SENSEX-FUT')).toEqual([
      { symbol: 'USOil', label: 'USOIL', provider: 'mt4' },
      { symbol: 'NIFTY#', label: undefined, provider: 'mt4' },
      { symbol: 'SENSEX-FUT', label: undefined, provider: 'mt4' },
    ]);
  });

  it('round-trips through formatWatchlist', () => {
    const text = 'MT4:MCRUDEOIL=MCX CRUDE, EURUSD=X=EURUSD, GC=F=GOLD, AAPL, BTCUSDT=BTCUSD';
    expect(formatWatchlist(parseWatchlist(text))).toBe(text);
  });
});
