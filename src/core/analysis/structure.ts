/**
 * Market structure: swing points (fractal pivots), HH/HL/LH/LL labelling,
 * break of structure (BOS) and change of character (CHoCH).
 */
import type { Candle } from '../types';
import type { Marker } from './types';

export interface Swing {
  index: number;
  time: number;
  price: number;
  type: 'high' | 'low';
  label?: 'HH' | 'LH' | 'HL' | 'LL';
}

export interface StructureEvent {
  index: number;
  time: number;
  kind: 'BOS' | 'CHoCH';
  direction: 1 | -1;
  level: number;
}

export interface StructureResult {
  swings: Swing[];
  events: StructureEvent[];
  /** +1 up, -1 down, 0 undetermined — from the most recent break. */
  trend: -1 | 0 | 1;
  /** Trend read purely from the last two swing highs and lows. */
  swingTrend: -1 | 0 | 1;
  /** 0..100: share of recent swing labels consistent with `trend`. */
  integrity: number;
  lastHigh?: Swing;
  lastLow?: Swing;
  markers: Marker[];
}

/**
 * Fractal pivots: bar i is a swing high when its high is the strict maximum of
 * the `left` bars before it and >= the `right` bars after it (and mirrored for
 * lows). Consecutive pivots of the same type are merged into the more extreme one
 * so highs and lows alternate.
 */
export function findSwings(c: Candle[], left = 3, right = left): Swing[] {
  const raw: Swing[] = [];
  for (let i = left; i < c.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - left; k <= i + right && (isHigh || isLow); k++) {
      if (k === i) continue;
      if (k < i) {
        if (c[k].high >= c[i].high) isHigh = false;
        if (c[k].low <= c[i].low) isLow = false;
      } else {
        if (c[k].high > c[i].high) isHigh = false;
        if (c[k].low < c[i].low) isLow = false;
      }
    }
    if (isHigh) raw.push({ index: i, time: c[i].time, price: c[i].high, type: 'high' });
    if (isLow) raw.push({ index: i, time: c[i].time, price: c[i].low, type: 'low' });
  }
  const out: Swing[] = [];
  for (const s of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.type === s.type) {
      const moreExtreme = s.type === 'high' ? s.price > prev.price : s.price < prev.price;
      if (moreExtreme) out[out.length - 1] = s;
    } else {
      out.push(s);
    }
  }
  let lastH: Swing | undefined;
  let lastL: Swing | undefined;
  for (const s of out) {
    if (s.type === 'high') {
      if (lastH) s.label = s.price > lastH.price ? 'HH' : 'LH';
      lastH = s;
    } else {
      if (lastL) s.label = s.price > lastL.price ? 'HL' : 'LL';
      lastL = s;
    }
  }
  return out;
}

export function analyzeStructure(c: Candle[], pivot = 3): StructureResult {
  const swings = findSwings(c, pivot);
  const events: StructureEvent[] = [];
  let trend: -1 | 0 | 1 = 0;
  let si = 0;
  let activeHigh: Swing | undefined;
  let activeLow: Swing | undefined;
  for (let i = 0; i < c.length; i++) {
    // A swing becomes known only once its right-side bars have printed.
    while (si < swings.length && swings[si].index + pivot <= i) {
      const s = swings[si++];
      if (s.type === 'high') activeHigh = s;
      else activeLow = s;
    }
    if (activeHigh && c[i].close > activeHigh.price) {
      events.push({ index: i, time: c[i].time, kind: trend === -1 ? 'CHoCH' : 'BOS', direction: 1, level: activeHigh.price });
      trend = 1;
      activeHigh = undefined;
    } else if (activeLow && c[i].close < activeLow.price) {
      events.push({ index: i, time: c[i].time, kind: trend === 1 ? 'CHoCH' : 'BOS', direction: -1, level: activeLow.price });
      trend = -1;
      activeLow = undefined;
    }
  }

  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  let swingTrend: -1 | 0 | 1 = 0;
  if (lastHigh?.label === 'HH' && lastLow?.label === 'HL') swingTrend = 1;
  else if (lastHigh?.label === 'LH' && lastLow?.label === 'LL') swingTrend = -1;

  const recent = swings.filter((s) => s.label).slice(-6);
  const consistent = recent.filter((s) =>
    trend === 1 ? s.label === 'HH' || s.label === 'HL' : trend === -1 ? s.label === 'LH' || s.label === 'LL' : false,
  ).length;
  const integrity = recent.length ? Math.round((100 * consistent) / recent.length) : 0;

  const markers: Marker[] = [];
  for (const s of swings.slice(-8)) {
    if (!s.label) continue;
    const bull = s.label === 'HH' || s.label === 'HL';
    markers.push({
      time: s.time,
      position: s.type === 'high' ? 'aboveBar' : 'belowBar',
      kind: s.label,
      text: s.label,
      tone: bull ? 'bull' : 'bear',
    });
  }
  for (const e of events.slice(-3)) {
    markers.push({
      time: e.time,
      position: e.direction === 1 ? 'belowBar' : 'aboveBar',
      kind: e.kind,
      text: e.kind,
      tone: e.direction === 1 ? 'bull' : 'bear',
    });
  }

  return { swings, events, trend, swingTrend, integrity, lastHigh, lastLow, markers };
}
