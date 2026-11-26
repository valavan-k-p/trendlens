import type { Candle, Series, Timeframe } from '@core/types';

/** Builds candles from a list of closes with small deterministic wicks. */
export function fromCloses(closes: number[], opts: { wick?: number; volume?: (i: number) => number; start?: number; step?: number } = {}): Candle[] {
  const wick = opts.wick ?? 0.3;
  const start = opts.start ?? 1_700_000_000;
  const step = opts.step ?? 3600;
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return {
      time: start + i * step,
      open: o,
      high: Math.max(o, c) + wick,
      low: Math.min(o, c) - wick,
      close: c,
      volume: opts.volume ? opts.volume(i) : 1000,
    };
  });
}

/** Zig-zag trend: legs of `up` bars rising by `rise` then `down` bars falling by `fall`. */
export function zigzag(n: number, start: number, rise: number, fall: number, up = 6, down = 3): number[] {
  const out: number[] = [];
  let p = start;
  let i = 0;
  while (out.length < n) {
    const leg = i % 2 === 0 ? up : down;
    const d = i % 2 === 0 ? rise : -fall;
    for (let k = 0; k < leg && out.length < n; k++) {
      p += d;
      out.push(p);
    }
    i++;
  }
  return out;
}

/** Oscillation between two bounds — a sideways range. */
export function range(n: number, mid: number, amp: number, period = 12): number[] {
  return Array.from({ length: n }, (_, i) => mid + amp * Math.sin((2 * Math.PI * i) / period));
}

export function series(candles: Candle[], timeframe: Timeframe = '1h', volumeAvailable = true): Series {
  return {
    meta: { symbol: 'TEST', name: 'Test instrument', provider: 'csv', volumeAvailable },
    timeframe,
    candles,
  };
}
