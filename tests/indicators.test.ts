import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  bollinger,
  cmf,
  ema,
  macd,
  mfi,
  obv,
  rsi,
  sma,
  stochastic,
  supertrend,
  vwap,
  wma,
  linregSlope,
} from '@core/indicators';
import type { Candle } from '@core/types';

const close = (vals: number[]) => vals;

/** Classic Wilder RSI example series (as published by StockCharts "ChartSchool"). */
const RSI_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
  46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
  43.42, 42.66, 43.13,
];
/** Published RSI(14) values for the series above, starting at index 14. */
const RSI_EXPECTED = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87,
  45.46, 37.3, 33.08, 37.77,
];

function candlesFrom(rows: [number, number, number, number, number?][]): Candle[] {
  return rows.map(([o, h, l, c, v], i) => ({ time: i * 60, open: o, high: h, low: l, close: c, volume: v ?? 1000 }));
}

/** Deterministic pseudo-random OHLCV walk for cross-checking against naive formulas. */
function walk(n: number, seed = 7): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 100;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o * (1 + (rnd() - 0.5) * 0.04);
    const h = Math.max(o, c) * (1 + rnd() * 0.01);
    const l = Math.min(o, c) * (1 - rnd() * 0.01);
    out.push({ time: 1_700_000_000 + i * 3600, open: o, high: h, low: l, close: c, volume: Math.round(1000 + rnd() * 9000) });
    p = c;
  }
  return out;
}

describe('moving averages', () => {
  it('SMA matches hand values and warms up with NaN', () => {
    const r = sma(close([1, 2, 3, 4, 5]), 3);
    expect(r.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(r.slice(2)).toEqual([2, 3, 4]);
  });

  it('EMA is SMA-seeded with alpha 2/(n+1)', () => {
    const r = ema(close([2, 4, 6, 8, 10]), 3);
    // seed = (2+4+6)/3 = 4; alpha = 0.5 -> 6 ; 8
    expect(r[2]).toBe(4);
    expect(r[3]).toBe(6);
    expect(r[4]).toBe(8);
  });

  it('WMA weights recent values more', () => {
    const r = wma(close([1, 2, 3]), 3);
    expect(r[2]).toBeCloseTo((1 * 1 + 2 * 2 + 3 * 3) / 6, 10);
  });
});

describe('RSI (Wilder)', () => {
  it('reproduces the published reference series', () => {
    const r = rsi(RSI_CLOSES, 14);
    expect(r.slice(0, 14).every(Number.isNaN)).toBe(true);
    // Exact first value by hand: avg gain 3.34/14, avg loss 1.40/14 -> RS 2.3857 -> 70.464.
    expect(r[14]).toBeCloseTo(100 - 100 / (1 + 3.34 / 1.4), 8);
    // The published table rounds its intermediate averages, so allow 0.15 of drift.
    RSI_EXPECTED.forEach((v, k) => expect(Math.abs(r[14 + k] - v)).toBeLessThan(0.15));
  });

  it('is 100 for a strictly rising series and 0 for a falling one', () => {
    const up = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi(up.slice().reverse(), 14).at(-1)).toBe(0);
  });
});

describe('MACD', () => {
  it('histogram equals macd - signal and macd equals ema12 - ema26', () => {
    const c = walk(120).map((x) => x.close);
    const m = macd(c);
    const e12 = ema(c, 12);
    const e26 = ema(c, 26);
    for (let i = 40; i < c.length; i++) {
      expect(m.macd[i]).toBeCloseTo(e12[i] - e26[i], 10);
      expect(m.histogram[i]).toBeCloseTo(m.macd[i] - m.signal[i], 10);
    }
  });
});

describe('ATR / ADX', () => {
  it('ATR equals Wilder smoothing of true range', () => {
    const c = walk(60);
    const a = atr(c, 14);
    const tr = c.map((x, i) =>
      i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)),
    );
    let ref = tr.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
    expect(a[13]).toBeCloseTo(ref, 10);
    for (let i = 14; i < c.length; i++) {
      ref = (ref * 13 + tr[i]) / 14;
      expect(a[i]).toBeCloseTo(ref, 10);
    }
  });

  it('ADX is high and +DI dominates in a steady uptrend', () => {
    const c = candlesFrom(Array.from({ length: 80 }, (_, i) => [100 + i, 101.5 + i, 99.5 + i, 101 + i] as [number, number, number, number]));
    const r = adx(c, 14);
    expect(r.adx.at(-1)!).toBeGreaterThan(50);
    expect(r.plusDI.at(-1)!).toBeGreaterThan(r.minusDI.at(-1)!);
  });

  it('ADX stays within 0..100', () => {
    const r = adx(walk(300), 14);
    r.adx.filter(Number.isFinite).forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    });
  });
});

describe('Bollinger', () => {
  it('uses population standard deviation', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    // mean 5, population sd 2
    expect(b.middle[7]).toBe(5);
    expect(b.upper[7]).toBeCloseTo(9, 10);
    expect(b.lower[7]).toBeCloseTo(1, 10);
    expect(b.percentB[7]).toBeCloseTo(1, 10);
  });
});

describe('oscillators and volume', () => {
  it('stochastic %K is 100 at the period high close', () => {
    const c = candlesFrom(Array.from({ length: 20 }, (_, i) => [i, i + 1, i - 1, i + 1] as [number, number, number, number]));
    const s = stochastic(c, 14, 1, 3);
    expect(s.k.at(-1)).toBe(100);
  });

  it('OBV adds volume on up closes and subtracts on down closes', () => {
    const c = candlesFrom([
      [10, 11, 9, 10, 100],
      [10, 12, 9, 11, 200],
      [11, 12, 9, 10, 50],
      [10, 11, 9, 10, 70],
    ]);
    expect(obv(c)).toEqual([0, 200, 150, 150]);
  });

  it('MFI is bounded and CMF is +1 when every bar closes at its high', () => {
    const c = candlesFrom(Array.from({ length: 30 }, (_, i) => [i, i + 2, i - 1, i + 2, 500] as [number, number, number, number, number]));
    expect(cmf(c, 20).at(-1)).toBeCloseTo(1, 10);
    expect(mfi(c, 14).at(-1)).toBe(100);
  });

  it('VWAP resets each exchange day', () => {
    const day = 86400;
    const c: Candle[] = [
      { time: 0, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { time: 3600, open: 20, high: 20, low: 20, close: 20, volume: 1 },
      { time: day, open: 30, high: 30, low: 30, close: 30, volume: 1 },
    ];
    expect(vwap(c)).toEqual([10, 15, 30]);
  });
});

describe('trend helpers', () => {
  it('Supertrend flips to up in a rising market', () => {
    const c = candlesFrom(Array.from({ length: 60 }, (_, i) => {
      const p = i < 30 ? 200 - i * 2 : 140 + (i - 30) * 3;
      return [p, p + 1, p - 1, p + (i < 30 ? -0.5 : 0.5)] as [number, number, number, number];
    }));
    const s = supertrend(c, 10, 3);
    expect(s.direction[25]).toBe(-1);
    expect(s.direction.at(-1)).toBe(1);
    expect(s.line.at(-1)!).toBeLessThan(c.at(-1)!.close);
  });

  it('linear-regression slope recovers a linear trend', () => {
    const v = Array.from({ length: 30 }, (_, i) => 3 * i + 7);
    expect(linregSlope(v, 10).at(-1)).toBeCloseTo(3, 10);
  });
});
