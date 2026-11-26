import { describe, expect, it } from 'vitest';
import { buildCatalog, candidatePeriods, choosePeriod, describeMt4Symbol, pickBestSource, encodeHst401, HST_HEADER, parseHst, splitHstName, type Mt4FileInfo } from '@core/data/mt4';
import { analyze } from '@core/analysis/engine';
import type { Candle } from '@core/types';
import { fromCloses, zigzag } from './fixtures';

const bars: Candle[] = [
  { time: 1_764_000_000, open: 25900, high: 25950.5, low: 25880, close: 25935, volume: 142 },
  { time: 1_764_000_300, open: 25935, high: 25960, low: 25920.25, close: 25955.75, volume: 98 },
];

describe('MT4 .hst parsing', () => {
  it('round-trips a v401 file with header fields', () => {
    const f = parseHst(encodeHst401('MCRUDEOIL', 15, 0, bars));
    expect(f).toMatchObject({ version: 401, symbol: 'MCRUDEOIL', period: 15, digits: 0 });
    expect(f.candles).toEqual(bars);
  });

  it('reads the legacy v400 layout (open, low, high, close order)', () => {
    const buf = new Uint8Array(HST_HEADER + 44);
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, 400, true);
    'EURUSD'.split('').forEach((ch, i) => (buf[68 + i] = ch.charCodeAt(0)));
    dv.setInt32(80, 60, true);
    dv.setInt32(84, 5, true);
    dv.setInt32(HST_HEADER, 1_700_000_000, true);
    dv.setFloat64(HST_HEADER + 4, 1.1, true); // open
    dv.setFloat64(HST_HEADER + 12, 1.09, true); // low
    dv.setFloat64(HST_HEADER + 20, 1.12, true); // high
    dv.setFloat64(HST_HEADER + 28, 1.11, true); // close
    dv.setFloat64(HST_HEADER + 36, 77, true); // volume
    const f = parseHst(buf);
    expect(f.symbol).toBe('EURUSD');
    expect(f.candles[0]).toEqual({ time: 1_700_000_000, open: 1.1, high: 1.12, low: 1.09, close: 1.11, volume: 77 });
  });

  it('keeps bars ascending and lets a repeated time replace the earlier bar', () => {
    const f = parseHst(encodeHst401('X', 5, 2, [bars[0], { ...bars[0], close: 1 }, bars[1]]));
    expect(f.candles.map((c) => c.close)).toEqual([1, 25955.75]);
  });

  it('rejects unknown versions and truncated files', () => {
    expect(() => parseHst(new Uint8Array(10))).toThrow(/too short/);
    const bad = encodeHst401('X', 5, 2, []);
    new DataView(bad.buffer).setInt32(0, 509, true);
    expect(() => parseHst(bad)).toThrow(/version 509/);
  });

  it('feeds the analysis engine', () => {
    const c = fromCloses(zigzag(240, 25000, 10, 12));
    const r = analyze({ meta: { symbol: 'NIFTY', provider: 'mt4', volumeAvailable: true }, timeframe: '15m', candles: parseHst(encodeHst401('NIFTY', 15, 2, c)).candles });
    expect(['Bullish', 'Strong Bullish']).toContain(r.condition);
  });
});

describe('MT4 file names and catalog', () => {
  it('splits file names on the longest period suffix', () => {
    expect(splitHstName('NIFTY15.hst')).toEqual({ symbol: 'NIFTY', period: 15 });
    expect(splitHstName('BANKNIFTY1440.hst')).toEqual({ symbol: 'BANKNIFTY', period: 1440 });
    expect(splitHstName('MNAG43200.hst')).toEqual({ symbol: 'MNAG', period: 43200 });
    expect(splitHstName('BNC_619005.hst')).toEqual({ symbol: 'BNC_61900', period: 5 });
    expect(splitHstName('news.dat')).toBeNull();
  });

  const f = (server: string, symbol: string, period: number, mtimeMs = 1): Mt4FileInfo => ({ server, symbol, period, path: `${server}/${symbol}${period}.hst`, size: 1000, mtimeMs });

  it('groups files per symbol, prefers the server with more timeframes, lists instruments before options', () => {
    const cat = buildCatalog([
      f('Live', 'EURUSD', 5, 50),
      f('Algo', 'EURUSD', 5, 10),
      f('Algo', 'EURUSD', 60, 10),
      f('Algo', 'BNC_61900', 5),
      f('Algo', 'NIFTY', 15),
      f('Algo', 'NIFTY', 1),
    ]);
    expect(cat.map((s) => s.symbol)).toEqual(['EURUSD', 'NIFTY', 'BNC_61900']);
    expect(cat[0]).toMatchObject({ server: 'Algo', periods: [5, 60] });
    expect(cat[1].periods).toEqual([1, 15]);
    expect(cat[2].kind).toBe('option');
  });

  it('uses the exact timeframe or resamples from the closest finer one', () => {
    expect(choosePeriod([1, 5, 15], '15m')).toEqual({ period: 15, resample: false });
    expect(choosePeriod([1, 5, 15, 60], '4h')).toEqual({ period: 60, resample: true });
    expect(choosePeriod([5, 1440], '1wk')).toEqual({ period: 1440, resample: true });
    expect(choosePeriod([15], '5m')).toBeNull();
  });

  it('prefers a finer file with much longer history when it is just as recent', () => {
    const mk = (period: number, n: number, end: number) => ({ period, candles: Array.from({ length: n }, (_, i) => ({ time: end - (n - 1 - i) * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 })) });
    const end = 1_764_000_000;
    // 15m file has 117 bars; 5m file resampled to 15m has 811 bars ending at the same bar.
    expect(pickBestSource([mk(15, 117, end), mk(5, 811, end)], '15m')!.period).toBe(5);
    // Not enough extra history: keep the exact file.
    expect(pickBestSource([mk(15, 500, end), mk(5, 600, end)], '15m')!.period).toBe(15);
    // A richer finer file that stopped a day earlier loses to the fresher exact file.
    expect(pickBestSource([mk(15, 117, end), mk(5, 811, end - 86400)], '15m')!.period).toBe(15);
    expect(candidatePeriods([1, 5, 15, 30, 60], '15m')).toEqual([15, 5, 1]);
  });

  it('describes known instruments and option strikes', () => {
    expect(describeMt4Symbol('MCRUDEOIL')).toBe('MCX Crude Oil');
    expect(describeMt4Symbol('BNC_61900')).toBe('BANKNIFTY call 61900');
    expect(describeMt4Symbol('NFW_P_25500')).toBe('NIFTY weekly put 25500');
  });
});
