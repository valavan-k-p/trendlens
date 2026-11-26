import { describe, expect, it } from 'vitest';
import { analyze, quickBias } from '@core/analysis/engine';
import { analyzeStructure, findSwings } from '@core/analysis/structure';
import { findBreakRetest, psychologicalLevels, psychologicalStep } from '@core/analysis/levels';
import { findFairValueGaps, findSweeps, findTraps } from '@core/analysis/smartMoney';
import type { Candle } from '@core/types';
import { fromCloses, range, series, zigzag } from './fixtures';

const uptrend = () => fromCloses(zigzag(240, 100, 1, 1.2));
const downtrend = () => fromCloses(zigzag(240, 400, -1, -1.2).map((v) => v));

describe('swings and structure', () => {
  it('finds alternating swing highs and lows', () => {
    const s = findSwings(uptrend(), 2);
    expect(s.length).toBeGreaterThan(10);
    for (let i = 1; i < s.length; i++) expect(s[i].type).not.toBe(s[i - 1].type);
  });

  it('labels an uptrend HH/HL with BOS events and high integrity', () => {
    const r = analyzeStructure(uptrend(), 2);
    expect(r.trend).toBe(1);
    expect(r.swingTrend).toBe(1);
    expect(r.integrity).toBeGreaterThanOrEqual(80);
    expect(r.events.at(-1)!.kind).toBe('BOS');
    expect(r.lastHigh!.label).toBe('HH');
    expect(r.lastLow!.label).toBe('HL');
  });

  it('labels a downtrend LH/LL', () => {
    // zigzag with negative rise and fall: legs alternate falling 6 bars, rising 3 bars
    const r = analyzeStructure(downtrend(), 2);
    expect(r.trend).toBe(-1);
    expect(r.swingTrend).toBe(-1);
  });

  it('reports a CHoCH when an uptrend breaks down', () => {
    const closes = [...zigzag(120, 100, 1, 1.2), ...zigzag(60, 160, -1.5, -0.8)];
    const r = analyzeStructure(fromCloses(closes), 2);
    expect(r.events.some((e) => e.kind === 'CHoCH' && e.direction === -1)).toBe(true);
    expect(r.trend).toBe(-1);
  });
});

describe('levels', () => {
  it('chooses round-number steps near 1% of price', () => {
    expect(psychologicalStep(24500)).toBe(250);
    expect(psychologicalStep(1.0845)).toBeCloseTo(0.01, 10);
    expect(psychologicalStep(180)).toBe(2);
    const lv = psychologicalLevels(24510).map((l) => l.price);
    expect(lv).toEqual([24500, 24750]);
  });

  it('detects a holding bullish break and retest', () => {
    const closes = [...range(60, 100, 2), 101, 103, 105, 104, 102.6, 102.4, 103, 104, 105];
    const c = fromCloses(closes, { wick: 0.2 });
    const r = findBreakRetest(c, [{ price: 102, kind: 'resistance', touches: 3, strength: 60 }], 1, 20);
    expect(r).toBeDefined();
    expect(r!.direction).toBe(1);
    expect(r!.holding).toBe(true);
  });
});

describe('smart money', () => {
  it('flags a buy-side liquidity sweep', () => {
    const closes = range(80, 100, 3);
    const c = fromCloses(closes, { wick: 0.2 });
    const swings = findSwings(c, 2);
    const lastHigh = swings.filter((s) => s.type === 'high').at(-1)!;
    // A final bar wicks above the last swing high and closes back below it.
    const prev = c.at(-1)!;
    c.push({ time: prev.time + 3600, open: prev.close, high: lastHigh.price + 1, low: prev.close - 0.5, close: lastHigh.price - 1.5, volume: 1000 });
    const sweeps = findSweeps(c, findSwings(c, 2), 2, 5);
    expect(sweeps.some((s) => s.side === 'buy-side')).toBe(true);
  });

  it('flags a bull trap when a breakout is reversed', () => {
    const c = fromCloses([...range(40, 100, 1), 100.5, 102, 101.4, 99.5, 99.4], { wick: 0.1 });
    const traps = findTraps(c, [101], 10, 3);
    expect(traps.map((t) => t.kind)).toContain('bull-trap');
  });

  it('finds an unfilled bullish fair-value gap', () => {
    const c: Candle[] = [
      { time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
      { time: 2, open: 100.5, high: 106, low: 100.4, close: 105.8, volume: 1 },
      { time: 3, open: 105.8, high: 108, low: 103, close: 107, volume: 1 },
      { time: 4, open: 107, high: 109, low: 104, close: 108, volume: 1 },
    ];
    const g = findFairValueGaps(c);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: 'bullish-fvg', bottom: 101, top: 103 });
  });
});

describe('analysis report', () => {
  it('reads a clean uptrend as bullish with a markup phase', () => {
    const r = analyze(series(uptrend()));
    expect(['Bullish', 'Strong Bullish']).toContain(r.condition);
    expect(r.biasScore).toBeGreaterThan(20);
    expect(r.phase).toBe('Markup');
    expect(r.confidence).toBeGreaterThan(40);
    expect(r.modules.map((m) => m.id)).toEqual(['structure', 'phase', 'trend', 'momentum', 'volatility', 'liquidity', 'price-behavior', 'smart-money', 'mtf', 'risk']);
    expect(r.verdict).toMatch(/not a trade recommendation/);
  });

  it('reads a clean downtrend as bearish', () => {
    const r = analyze(series(downtrend()));
    expect(['Bearish', 'Strong Bearish']).toContain(r.condition);
    expect(r.biasScore).toBeLessThan(-20);
    expect(r.phase).toBe('Markdown');
  });

  it('reads a sideways market as consolidating or neutral with a no-trade flag', () => {
    const r = analyze(series(fromCloses(range(240, 100, 2, 16), { wick: 0.4 })));
    expect(['Consolidating', 'Neutral']).toContain(r.condition);
    expect(Math.abs(r.biasScore)).toBeLessThan(40);
  });

  it('keeps all scores inside their documented ranges', () => {
    for (const c of [uptrend(), downtrend(), fromCloses(range(200, 50, 5))]) {
      const r = analyze(series(c));
      expect(r.biasScore).toBeGreaterThanOrEqual(-100);
      expect(r.biasScore).toBeLessThanOrEqual(100);
      for (const v of [r.confidence, r.strengthIndex]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      for (const m of r.modules) if (m.score !== null) expect(Math.abs(m.score)).toBeLessThanOrEqual(100);
    }
  });

  it('uses higher timeframes and raises a counter-trend alert when they disagree', () => {
    const lower = series(downtrend(), '15m');
    const higherUp = [series(uptrend(), '1h'), series(uptrend(), '1d')];
    const r = analyze(lower, { higher: higherUp });
    expect(r.mtf).toHaveLength(3);
    expect(r.mtf[1].bias).toBe('Bullish');
    expect(r.risk.flags.some((f) => f.startsWith('Counter-trend'))).toBe(true);
  });

  it('excludes volume modules when the source has no volume', () => {
    const r = analyze(series(uptrend(), '1h', false));
    expect(r.modules.find((m) => m.id === 'liquidity')!.items[0].value).toBe('Unavailable');
    expect(r.dataNotes.join(' ')).toMatch(/volume/i);
  });

  it('refuses too-short series', () => {
    expect(() => analyze(series(uptrend().slice(0, 30)))).toThrow(/At least 60 bars/);
  });

  it('quickBias agrees with trend direction', () => {
    expect(quickBias(uptrend())).toBeGreaterThan(30);
    expect(quickBias(downtrend())).toBeLessThan(-30);
  });
});
