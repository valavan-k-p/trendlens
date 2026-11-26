/**
 * Smart-money concepts derived from OHLCV only: liquidity sweeps, failed
 * breakouts (traps), order blocks, fair-value gaps, equal highs/lows,
 * high-volume "institutional" bars, and accumulation/distribution flow.
 */
import type { Candle } from '../types';
import type { Swing } from './structure';
import type { Marker, Zone } from './types';

export interface Sweep {
  index: number;
  time: number;
  /** 'buy-side' = swept a swing high (bearish implication); 'sell-side' = swept a low. */
  side: 'buy-side' | 'sell-side';
  level: number;
}

/** A wick through a known swing level that closes back on the original side. */
export function findSweeps(c: Candle[], swings: Swing[], pivot: number, window = 15): Sweep[] {
  const n = c.length;
  const out: Sweep[] = [];
  for (let i = Math.max(1, n - window); i < n; i++) {
    const known = swings.filter((s) => s.index + pivot <= i - 1 && s.index >= i - 60);
    const highs = known.filter((s) => s.type === 'high');
    const lows = known.filter((s) => s.type === 'low');
    const h = highs[highs.length - 1];
    const l = lows[lows.length - 1];
    if (h && c[i].high > h.price && c[i].close < h.price) out.push({ index: i, time: c[i].time, side: 'buy-side', level: h.price });
    if (l && c[i].low < l.price && c[i].close > l.price) out.push({ index: i, time: c[i].time, side: 'sell-side', level: l.price });
  }
  return out;
}

export interface Trap {
  index: number;
  time: number;
  kind: 'bull-trap' | 'bear-trap';
  level: number;
}

/** A close beyond a level that is fully reversed by a close back inside within `confirm` bars. */
export function findTraps(c: Candle[], levels: number[], window = 25, confirm = 3): Trap[] {
  const n = c.length;
  const out: Trap[] = [];
  for (const lv of levels) {
    for (let i = Math.max(1, n - window); i < n - 1; i++) {
      const brokeUp = c[i - 1].close <= lv && c[i].close > lv;
      const brokeDown = c[i - 1].close >= lv && c[i].close < lv;
      if (!brokeUp && !brokeDown) continue;
      for (let k = i + 1; k <= Math.min(n - 1, i + confirm); k++) {
        if (brokeUp && c[k].close < lv) {
          out.push({ index: k, time: c[k].time, kind: 'bull-trap', level: lv });
          break;
        }
        if (brokeDown && c[k].close > lv) {
          out.push({ index: k, time: c[k].time, kind: 'bear-trap', level: lv });
          break;
        }
      }
    }
  }
  return dedupeBy(out, (t) => `${t.index}:${t.kind}`).sort((a, b) => a.index - b.index);
}

/**
 * Order blocks: the last opposite-coloured candle before a displacement leg
 * (3-bar move of at least 1.5 x ATR). A zone is dropped once a close goes
 * through its far side; `tested` records a later touch.
 */
export function findOrderBlocks(c: Candle[], atrLine: number[], lookback = 150): Zone[] {
  const n = c.length;
  const zones: (Zone & { index: number })[] = [];
  for (let i = Math.max(5, n - lookback); i < n - 3; i++) {
    const a = atrLine[i];
    if (!Number.isFinite(a)) continue;
    const move = c[i + 2].close - c[i].open;
    if (Math.abs(move) < 1.5 * a) continue;
    const bullish = move > 0;
    for (let k = i; k >= Math.max(0, i - 5); k--) {
      const bear = c[k].close < c[k].open;
      if (bullish ? bear : !bear && c[k].close > c[k].open) {
        zones.push({
          kind: bullish ? 'bullish-ob' : 'bearish-ob',
          top: c[k].high,
          bottom: c[k].low,
          time: c[k].time,
          tested: false,
          index: k,
        });
        break;
      }
    }
  }
  const alive: Zone[] = [];
  for (const z of dedupeBy(zones, (z) => `${z.index}:${z.kind}`)) {
    let broken = false;
    let tested = false;
    for (let k = z.index + 3; k < n; k++) {
      if (z.kind === 'bullish-ob') {
        if (c[k].close < z.bottom) broken = true;
        else if (c[k].low <= z.top) tested = true;
      } else {
        if (c[k].close > z.top) broken = true;
        else if (c[k].high >= z.bottom) tested = true;
      }
      if (broken) break;
    }
    if (!broken) alive.push({ kind: z.kind, top: z.top, bottom: z.bottom, time: z.time, tested });
  }
  return alive;
}

/** Three-candle imbalances that have not been fully filled. */
export function findFairValueGaps(c: Candle[], lookback = 120): Zone[] {
  const n = c.length;
  const out: Zone[] = [];
  for (let i = Math.max(2, n - lookback); i < n; i++) {
    let zone: Zone | undefined;
    if (c[i].low > c[i - 2].high) zone = { kind: 'bullish-fvg', top: c[i].low, bottom: c[i - 2].high, time: c[i - 1].time, tested: false };
    else if (c[i].high < c[i - 2].low) zone = { kind: 'bearish-fvg', top: c[i - 2].low, bottom: c[i].high, time: c[i - 1].time, tested: false };
    if (!zone) continue;
    let filled = false;
    for (let k = i + 1; k < n && !filled; k++) {
      if (zone.kind === 'bullish-fvg') {
        if (c[k].low <= zone.bottom) filled = true;
        else if (c[k].low < zone.top) zone.tested = true;
      } else {
        if (c[k].high >= zone.top) filled = true;
        else if (c[k].high > zone.bottom) zone.tested = true;
      }
    }
    if (!filled) out.push(zone);
  }
  return out;
}

/** Pairs of swing highs (or lows) within `tolerance` — resting liquidity pools. */
export function equalLevels(swings: Swing[], tolerance: number, recent = 12): { type: 'high' | 'low'; price: number }[] {
  const out: { type: 'high' | 'low'; price: number }[] = [];
  for (const type of ['high', 'low'] as const) {
    const pts = swings.filter((s) => s.type === type).slice(-recent);
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        if (Math.abs(pts[i].price - pts[j].price) <= tolerance) out.push({ type, price: (pts[i].price + pts[j].price) / 2 });
  }
  return dedupeBy(out, (e) => `${e.type}:${e.price.toPrecision(6)}`);
}

export interface InstitutionalBars {
  count: number;
  bullish: number;
  bearish: number;
}

/** Bars with volume >= 2x the 20-bar average and a body >= 60% of range. */
export function institutionalBars(c: Candle[], volAvg: number[], window = 20): InstitutionalBars {
  const res = { count: 0, bullish: 0, bearish: 0 };
  for (let i = Math.max(0, c.length - window); i < c.length; i++) {
    const avg = volAvg[i - 1];
    if (!(avg > 0)) continue;
    const range = c[i].high - c[i].low;
    const body = Math.abs(c[i].close - c[i].open);
    if (c[i].volume >= 2 * avg && range > 0 && body >= 0.6 * range) {
      res.count++;
      if (c[i].close > c[i].open) res.bullish++;
      else res.bearish++;
    }
  }
  return res;
}

export function smartMoneyMarkers(sweeps: Sweep[], traps: Trap[]): Marker[] {
  return [
    ...sweeps.slice(-3).map<Marker>((s) => ({
      time: s.time,
      position: s.side === 'buy-side' ? 'aboveBar' : 'belowBar',
      kind: 'SWEEP',
      text: s.side === 'buy-side' ? 'Sweep ↑' : 'Sweep ↓',
      tone: 'warn',
    })),
    ...traps.slice(-2).map<Marker>((t) => ({
      time: t.time,
      position: t.kind === 'bull-trap' ? 'aboveBar' : 'belowBar',
      kind: 'TRAP',
      text: t.kind === 'bull-trap' ? 'Bull trap' : 'Bear trap',
      tone: 'warn',
    })),
  ];
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
