/**
 * Price behaviour: support/resistance from clustered swing points,
 * psychological (round-number) levels, and break-and-retest detection.
 */
import type { Candle } from '../types';
import type { Swing } from './structure';
import type { Level } from './types';

interface Cluster {
  sum: number;
  count: number;
  lastIndex: number;
  price: number;
}

/**
 * Groups swing prices that lie within `tolerance` of each other. Each cluster's
 * price is the mean of its members; strength grows with touches and recency.
 */
export function clusterLevels(swings: Swing[], lastIndex: number, tolerance: number, lookback = 200): Level[] {
  const pts = swings.filter((s) => s.index >= lastIndex - lookback).sort((a, b) => a.price - b.price);
  const clusters: Cluster[] = [];
  for (const s of pts) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(s.price - c.price) <= tolerance) {
      c.sum += s.price;
      c.count++;
      c.price = c.sum / c.count;
      c.lastIndex = Math.max(c.lastIndex, s.index);
    } else {
      clusters.push({ sum: s.price, count: 1, lastIndex: s.index, price: s.price });
    }
  }
  return clusters.map((c) => {
    const recency = 1 - Math.min(1, (lastIndex - c.lastIndex) / lookback);
    const strength = Math.round(Math.min(100, c.count * 22 + recency * 34));
    return { price: c.price, kind: 'support' as const, touches: c.count, strength };
  });
}

/** A "nice" round-number step near 1% of price: 1, 2, 2.5 or 5 x 10^k. */
export function psychologicalStep(price: number): number {
  const target = Math.abs(price) * 0.01;
  if (!(target > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(target));
  const options = [1, 2, 2.5, 5, 10].map((m) => m * mag);
  return options.reduce((best, s) => (Math.abs(Math.log(s / target)) < Math.abs(Math.log(best / target)) ? s : best));
}

export function psychologicalLevels(price: number): Level[] {
  const step = psychologicalStep(price);
  const major = step * (step * 4 > price * 0.05 ? 2 : 5);
  const below = Math.floor(price / step) * step;
  const above = Math.ceil(price / step) * step;
  const set = new Set([below, above === below ? above + step : above]);
  const out: Level[] = [];
  for (const p of set) {
    const isMajor = Math.abs(p / major - Math.round(p / major)) < 1e-9;
    out.push({ price: round(p, step), kind: 'psychological', touches: 0, strength: isMajor ? 60 : 35 });
  }
  return out;
}

function round(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  return Number(v.toFixed(decimals));
}

export interface LevelSet {
  all: Level[];
  support?: Level;
  resistance?: Level;
}

/** Classifies clustered levels relative to the last close and keeps the nearest few. */
export function buildLevels(c: Candle[], swings: Swing[], atrValue: number, keep = 4): LevelSet {
  const close = c[c.length - 1].close;
  const tol = Math.max(atrValue * 0.6, close * 0.0005);
  const clusters = clusterLevels(swings, c.length - 1, tol);
  const supports = clusters
    .filter((l) => l.price < close)
    .map((l) => ({ ...l, kind: 'support' as const }))
    .sort((a, b) => b.price - a.price)
    .slice(0, keep);
  const resistances = clusters
    .filter((l) => l.price >= close)
    .map((l) => ({ ...l, kind: 'resistance' as const }))
    .sort((a, b) => a.price - b.price)
    .slice(0, keep);
  const psych = psychologicalLevels(close);
  return {
    all: [...supports, ...resistances, ...psych],
    support: supports[0],
    resistance: resistances[0],
  };
}

export interface RetestResult {
  direction: 1 | -1;
  level: number;
  breakIndex: number;
  holding: boolean;
}

/**
 * Break and retest: within the last `window` bars price closed through a level,
 * then traded back to within `0.35 * ATR` of it. `holding` means every close since
 * the break stayed on the breakout side.
 */
export function findBreakRetest(c: Candle[], levels: Level[], atrValue: number, window = 30): RetestResult | undefined {
  const n = c.length;
  const tol = atrValue * 0.35;
  let best: RetestResult | undefined;
  for (const lv of levels) {
    if (lv.kind === 'psychological') continue;
    for (let i = Math.max(1, n - window); i < n - 1; i++) {
      const up = c[i - 1].close <= lv.price && c[i].close > lv.price;
      const down = c[i - 1].close >= lv.price && c[i].close < lv.price;
      if (!up && !down) continue;
      const dir: 1 | -1 = up ? 1 : -1;
      let retested = false;
      let holding = true;
      for (let k = i + 1; k < n; k++) {
        if (dir === 1) {
          if (c[k].low <= lv.price + tol) retested = true;
          if (c[k].close < lv.price) holding = false;
        } else {
          if (c[k].high >= lv.price - tol) retested = true;
          if (c[k].close > lv.price) holding = false;
        }
      }
      if (retested && (!best || i > best.breakIndex)) best = { direction: dir, level: lv.price, breakIndex: i, holding };
    }
  }
  return best;
}
