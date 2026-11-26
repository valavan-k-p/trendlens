import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartUrl, parseChart, parseSearch, parseSpark } from '@core/data/yahoo';
import { klinesUrl, parseKlines, searchSymbols } from '@core/data/binance';
import { inferTimeframe, parseCsv, parseTimeValue } from '@core/data/csv';
import { resample } from '@core/data/resample';
import { looksLikeBinancePair } from '@core/data';
import { analyze } from '@core/analysis/engine';
import type { Candle } from '@core/types';

const rec = (f: string) => JSON.parse(readFileSync(resolve(__dirname, 'recorded', f), 'utf8'));

describe('Yahoo provider', () => {
  it('builds chart URLs per timeframe', () => {
    expect(chartUrl('^NSEI', '15m')).toContain('/chart/%5ENSEI?interval=15m&range=1mo');
    expect(chartUrl('AAPL', '4h')).toContain('interval=60m&range=2y');
  });

  it('parses a recorded chart response into clean, ordered candles', () => {
    const s = parseChart(rec('yahoo-chart-reliance-60m.json'), '1h');
    expect(s.meta.symbol).toBe('RELIANCE.NS');
    expect(s.meta.currency).toBe('INR');
    expect(s.meta.gmtOffset).toBe(19800);
    expect(s.candles.length).toBeGreaterThan(50);
    for (let i = 1; i < s.candles.length; i++) expect(s.candles[i].time).toBeGreaterThan(s.candles[i - 1].time);
    for (const c of s.candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close) - 1e-6);
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close) + 1e-6);
    }
  });

  it('runs the full analysis on recorded market data', () => {
    const r = analyze(parseChart(rec('yahoo-chart-reliance-60m.json'), '1h'));
    expect(r.symbol).toBe('RELIANCE.NS');
    expect(r.insight.length).toBeGreaterThan(40);
  });

  it('surfaces Yahoo errors', () => {
    expect(() => parseChart(rec('yahoo-chart-error.json'), '1d')).toThrow(/No data found/);
  });

  it('parses search results with asset classes', () => {
    const r = parseSearch(rec('yahoo-search-nifty.json'));
    expect(r.find((x) => x.symbol === '^NSEI')).toMatchObject({ assetClass: 'index', exchange: 'NSE', provider: 'yahoo' });
  });

  it('parses spark quotes with change vs previous close', () => {
    const q = parseSpark(rec('yahoo-spark.json'));
    expect(q.map((x) => x.symbol).sort()).toEqual(['AAPL', 'EURUSD=X', '^NSEI']);
    for (const x of q) expect(x.change).toBeCloseTo(x.price - x.previousClose, 8);
  });
});

describe('Binance provider', () => {
  it('parses recorded klines', () => {
    const s = parseKlines(rec('binance-btcusdt-1h.json'), 'BTCUSDT', '1h');
    expect(s.candles).toHaveLength(300);
    expect(s.meta.name).toBe('BTC / USDT');
    expect(s.candles[1].time - s.candles[0].time).toBe(3600);
    expect(klinesUrl('btcusdt', '1wk')).toContain('symbol=BTCUSDT&interval=1w');
  });

  it('reports API errors', () => {
    expect(() => parseKlines({ code: -1121, msg: 'Invalid symbol.' }, 'XX', '1h')).toThrow(/Invalid symbol/);
  });

  it('searches the price list, preferring USDT pairs that start with the query', () => {
    const r = searchSymbols([{ symbol: 'ETHBTC' }, { symbol: 'ETHUSDT' }, { symbol: 'WETHUSDT' }, { symbol: 'BTCUSDT' }], 'eth');
    expect(r[0].symbol).toBe('ETHUSDT');
    expect(r.map((x) => x.symbol)).not.toContain('BTCUSDT');
  });

  it('recognises plain crypto pairs', () => {
    expect(looksLikeBinancePair('BTCUSDT')).toBe(true);
    expect(looksLikeBinancePair('BTC-USD')).toBe(false);
    expect(looksLikeBinancePair('RELIANCE.NS')).toBe(false);
  });
});

describe('CSV import', () => {
  it('parses a TradingView-style export', () => {
    const csv = 'time,open,high,low,close,Volume\n1700000000,1,2,0.5,1.5,100\n1700003600,1.5,2.5,1,2,200\n';
    const s = parseCsv(csv, 'demo');
    expect(s.candles).toHaveLength(2);
    expect(s.timeframe).toBe('1h');
    expect(s.meta.volumeAvailable).toBe(true);
  });

  it('handles semicolons, quoted thousands and dd-mm-yyyy dates', () => {
    const csv = 'Date;Open;High;Low;Close\n02-01-2025;"1,000";"1,010";990;"1,005"\n03-01-2025;1005;1020;1000;1015\n';
    const s = parseCsv(csv);
    expect(s.candles[0]).toMatchObject({ open: 1000, high: 1010, close: 1005, time: Date.UTC(2025, 0, 2) / 1000 });
    expect(s.timeframe).toBe('1d');
    expect(s.meta.volumeAvailable).toBe(false);
  });

  it('rejects files without price columns', () => {
    expect(() => parseCsv('date,foo\n2024-01-01,1\n')).toThrow(/missing a "open"/);
  });

  it('parses common time formats', () => {
    expect(parseTimeValue('2024-01-05')).toBe(Date.UTC(2024, 0, 5) / 1000);
    expect(parseTimeValue('2024-01-05 09:15')).toBe(Date.UTC(2024, 0, 5, 9, 15) / 1000);
    expect(parseTimeValue('1704067200000')).toBe(1704067200);
  });
});

describe('resampling', () => {
  const hourly: Candle[] = Array.from({ length: 8 }, (_, i) => ({ time: i * 3600, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 10 }));

  it('aggregates hourly bars into 4h OHLCV', () => {
    const r = resample(hourly, '4h');
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ time: 0, open: 0, high: 4, low: -1, close: 3.5, volume: 40 });
  });

  it('aligns buckets to the exchange day and stamps bars with the bucket start', () => {
    // IST is UTC+5:30, so 4h buckets start at 22:30, 02:30, 06:30 UTC.
    const r = resample(hourly, '4h', 19800);
    expect(r.map((c) => c.time)).toEqual([-5400, 9000, 23400]);
    // A gap at the start of a bucket must not shift the bar's time.
    const gapped = resample(hourly.slice(1), '4h');
    expect(gapped[0].time).toBe(0);
  });

  it('can anchor intraday buckets to a broker grid (e.g. hourly bars at :45)', () => {
    const fiveMin: Candle[] = Array.from({ length: 24 }, (_, i) => ({ time: 3600 * 13 + i * 300, open: i, high: i + 1, low: i - 1, close: i, volume: 1 }));
    const anchor = 3600 * 13 + 45 * 60; // a 13:45 bar from the broker
    const r = resample(fiveMin, '1h', 0, anchor);
    // 13:00..14:55 spans the 12:45, 13:45 and 14:45 broker bars.
    expect(r.map((c) => c.time)).toEqual([3600 * 12 + 45 * 60, 3600 * 13 + 45 * 60, 3600 * 14 + 45 * 60]);
    expect(r[0]).toMatchObject({ open: 0, close: 8 }); // 13:00..13:40 belong to the 12:45 bar
    expect(r[1].open).toBe(9);
  });

  it('infers the timeframe from bar spacing', () => {
    expect(inferTimeframe(hourly)).toBe('1h');
  });
});
