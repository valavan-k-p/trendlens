/**
 * The analysis engine: turns an OHLCV series (plus optional higher-timeframe
 * series) into a structured, educational market review. Every number is a
 * deterministic function of the candles; see docs/ANALYSIS.md for the rules.
 */
import * as ind from '../indicators';
import { clamp, formatNum, formatPct, formatPrice, formatVolume } from '../format';
import type { Candle, Series, Timeframe } from '../types';
import { timeframeLabel } from '../types';
import { analyzeStructure, type StructureResult } from './structure';
import { buildLevels, findBreakRetest } from './levels';
import {
  equalLevels,
  findFairValueGaps,
  findOrderBlocks,
  findSweeps,
  findTraps,
  institutionalBars,
  smartMoneyMarkers,
} from './smartMoney';
import type {
  AnalysisReport,
  MarketCondition,
  MarketPhase,
  ModuleResult,
  RiskLevel,
  Signal,
  TimeframeBias,
  Tone,
} from './types';

export const MIN_BARS = 60;

export interface AnalyzeOptions {
  /** Higher-timeframe series for the multi-timeframe alignment module. */
  higher?: Series[];
  /** Pivot half-width for swing detection. */
  pivot?: number;
  now?: number;
}

const toneOf = (score: number, deadband = 10): Tone => (score > deadband ? 'bull' : score < -deadband ? 'bear' : 'neutral');
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const slopeSign = (line: number[], bars: number) => {
  const a = line[line.length - 1];
  const b = line[line.length - 1 - bars];
  return Number.isFinite(a) && Number.isFinite(b) ? sign(a - b) : 0;
};

interface Context {
  c: Candle[];
  close: number[];
  last: Candle;
  atr: number[];
  atrNow: number;
  ema20: number[];
  ema50: number[];
  ema200: number[];
  adx: ind.AdxResult;
  rsi: number[];
  macd: ind.MacdResult;
  bands: ind.BandsResult;
  st: ind.SupertrendResult;
  volumeAvailable: boolean;
  volAvg: number[];
}

function buildContext(c: Candle[], volumeAvailable: boolean): Context {
  const close = ind.closes(c);
  const atrLine = ind.atr(c, 14);
  return {
    c,
    close,
    last: c[c.length - 1],
    atr: atrLine,
    atrNow: ind.lastFinite(atrLine),
    ema20: ind.ema(close, 20),
    ema50: ind.ema(close, 50),
    ema200: ind.ema(close, 200),
    adx: ind.adx(c, 14),
    rsi: ind.rsi(close, 14),
    macd: ind.macd(close),
    bands: ind.bollinger(close, 20, 2),
    st: ind.supertrend(c, 10, 3),
    volumeAvailable,
    volAvg: ind.sma(c.map((x) => x.volume), 20),
  };
}

// ---------------------------------------------------------------- modules

function structureModule(ctx: Context, s: StructureResult): ModuleResult {
  const lastEvent = s.events[s.events.length - 1];
  const barsSinceEvent = lastEvent ? ctx.c.length - 1 - lastEvent.index : Infinity;
  let score = s.trend * 55 + s.swingTrend * 25;
  score += s.trend !== 0 ? ((s.integrity - 50) / 50) * 20 : 0;
  if (lastEvent?.kind === 'CHoCH' && barsSinceEvent <= 10) score = lastEvent.direction * Math.max(Math.abs(score) * 0.6, 30);
  score = clamp(Math.round(score), -100, 100);

  const trendText = s.trend === 1 ? 'Uptrend' : s.trend === -1 ? 'Downtrend' : 'Undetermined';
  const items: Signal[] = [
    { label: 'Structural trend', value: trendText, tone: toneOf(s.trend * 50) },
    {
      label: 'Swing sequence',
      value: `${s.lastHigh?.label ?? '—'} / ${s.lastLow?.label ?? '—'}`,
      tone: toneOf(s.swingTrend * 50),
      detail: 'Latest swing high label / latest swing low label',
    },
    {
      label: 'Structure integrity',
      value: `${s.integrity}%`,
      tone: s.integrity >= 67 ? 'bull' : s.integrity >= 40 ? 'neutral' : 'warn',
      detail: 'Share of the last six swings that agree with the structural trend',
    },
  ];
  if (lastEvent)
    items.push({
      label: 'Last break',
      value: `${lastEvent.kind} ${lastEvent.direction === 1 ? '↑' : '↓'} ${formatPrice(lastEvent.level)}`,
      tone: lastEvent.direction === 1 ? 'bull' : 'bear',
      detail: `${barsSinceEvent} bar(s) ago`,
    });
  const summary =
    s.trend === 0
      ? 'No decisive break of a confirmed swing yet; structure is undetermined.'
      : `${trendText} by structure${lastEvent?.kind === 'CHoCH' && barsSinceEvent <= 10 ? ', freshly shifted (change of character)' : ''}; integrity ${s.integrity}%.`;
  return { id: 'structure', title: 'Market Structure', score, summary, items };
}

function trendMatrixModule(ctx: Context): ModuleResult {
  const p = ctx.last.close;
  const e20 = ind.last(ctx.ema20);
  const e50 = ind.last(ctx.ema50);
  const e200 = ind.last(ctx.ema200);
  const adxNow = ind.last(ctx.adx.adx);
  const diSpread = ind.last(ctx.adx.plusDI) - ind.last(ctx.adx.minusDI);
  const stDir = ind.last(ctx.st.direction);
  const slope = ind.last(ind.linregSlope(ctx.close, 20));
  const slopeAtr = ctx.atrNow > 0 ? slope / ctx.atrNow : 0;

  let align = 0;
  if (Number.isFinite(e200)) {
    if (e20 > e50 && e50 > e200) align = 1;
    else if (e20 < e50 && e50 < e200) align = -1;
  } else if (Number.isFinite(e50)) align = sign(e20 - e50);

  const pricePos = [e20, e50, e200].filter(Number.isFinite).reduce((s, e) => s + sign(p - e), 0);
  const dirTerm = 0.3 * align + 0.2 * (pricePos / 3) + 0.2 * (Number.isFinite(stDir) ? stDir : 0) + 0.3 * clamp(slopeAtr * 2, -1, 1);
  const adxWeight = Number.isFinite(adxNow) ? clamp(0.5 + adxNow / 50, 0.5, 1.3) : 1;
  const score = clamp(Math.round(dirTerm * 100 * adxWeight), -100, 100);

  const items: Signal[] = [
    { label: 'EMA 20/50/200', value: align === 1 ? 'Bullish stack' : align === -1 ? 'Bearish stack' : 'Mixed', tone: toneOf(align * 50) },
    { label: 'Price vs EMAs', value: `${pricePos > 0 ? 'Above' : pricePos < 0 ? 'Below' : 'Around'} (${pricePos > 0 ? '+' : ''}${pricePos})`, tone: toneOf(pricePos * 20) },
    {
      label: 'ADX (14)',
      value: formatNum(adxNow),
      tone: adxNow >= 25 ? 'bull' : adxNow < 18 ? 'warn' : 'neutral',
      detail: adxNow >= 25 ? 'Trending' : adxNow < 18 ? 'Weak / ranging' : 'Developing',
    },
    { label: '+DI − −DI', value: formatNum(diSpread), tone: toneOf(diSpread, 3) },
    { label: 'Supertrend (10,3)', value: stDir === 1 ? 'Up' : stDir === -1 ? 'Down' : '—', tone: toneOf((stDir || 0) * 50) },
    { label: 'Regression slope', value: `${formatNum(slopeAtr, 2)} ATR/bar`, tone: toneOf(slopeAtr * 100, 5) },
  ];
  const strength = adxNow >= 35 ? 'strong' : adxNow >= 25 ? 'established' : adxNow >= 18 ? 'developing' : 'weak';
  return {
    id: 'trend',
    title: 'Trend Strength Matrix',
    score,
    summary: `${score > 10 ? 'Bullish' : score < -10 ? 'Bearish' : 'Neutral'} trend alignment, ${strength} directional strength (ADX ${formatNum(adxNow)}).`,
    items,
  };
}

interface MomentumOut {
  module: ModuleResult;
  expansion: 'Expanding' | 'Fading' | 'Steady';
  divergence?: 'bearish' | 'bullish';
}

function momentumModule(ctx: Context, s: StructureResult): MomentumOut {
  const r = ind.last(ctx.rsi);
  const h = ctx.macd.histogram;
  const hNow = ind.last(h);
  const hChange = hNow - ind.last(h, 3);
  const rocNow = ind.last(ind.roc(ctx.close, 10));
  const stoch = ind.stochastic(ctx.c, 14, 3, 3);
  const k = ind.last(stoch.k);
  const tr = ind.trueRange(ctx.c);
  const rangeRatio = ctx.atrNow > 0 ? (tr.slice(-3).reduce((a, b) => a + b, 0) / 3) / ctx.atrNow : 1;

  let expansion: MomentumOut['expansion'] = 'Steady';
  const absRising = Math.abs(hNow) > Math.abs(ind.last(h, 1)) && Math.abs(ind.last(h, 1)) > Math.abs(ind.last(h, 2));
  const absFalling = Math.abs(hNow) < Math.abs(ind.last(h, 1)) && Math.abs(ind.last(h, 1)) < Math.abs(ind.last(h, 2));
  if (absRising && rangeRatio >= 1.0) expansion = 'Expanding';
  else if (absFalling) expansion = 'Fading';

  // RSI divergence on the last two swing highs / lows.
  let divergence: MomentumOut['divergence'];
  const highs = s.swings.filter((x) => x.type === 'high').slice(-2);
  const lows = s.swings.filter((x) => x.type === 'low').slice(-2);
  const recentEnough = (i: number) => ctx.c.length - 1 - i <= 30;
  if (highs.length === 2 && recentEnough(highs[1].index) && highs[1].price > highs[0].price && ctx.rsi[highs[1].index] < ctx.rsi[highs[0].index] - 2)
    divergence = 'bearish';
  if (lows.length === 2 && recentEnough(lows[1].index) && lows[1].price < lows[0].price && ctx.rsi[lows[1].index] > ctx.rsi[lows[0].index] + 2)
    divergence = 'bullish';

  const macdScale = ctx.atrNow > 0 ? clamp((hNow / ctx.atrNow) * 150, -30, 30) : 0;
  let score = (r - 50) * 1.4 + macdScale + clamp(rocNow * 3, -20, 20);
  if (divergence === 'bearish') score -= 20;
  if (divergence === 'bullish') score += 20;
  score = clamp(Math.round(score), -100, 100);

  const items: Signal[] = [
    { label: 'RSI (14)', value: formatNum(r), tone: r >= 70 ? 'warn' : r <= 30 ? 'warn' : toneOf((r - 50) * 2), detail: r >= 70 ? 'Overbought' : r <= 30 ? 'Oversold' : undefined },
    { label: 'MACD histogram', value: `${formatNum(hNow, 4)} (${hChange >= 0 ? 'rising' : 'falling'})`, tone: toneOf(sign(hNow) * 30) },
    { label: 'Rate of change (10)', value: formatPct(rocNow), tone: toneOf(rocNow * 10) },
    { label: 'Stochastic %K', value: formatNum(k), tone: k >= 80 || k <= 20 ? 'warn' : 'neutral' },
    { label: 'Market pulse', value: expansion, tone: expansion === 'Expanding' ? toneOf(sign(hNow) * 50) : expansion === 'Fading' ? 'warn' : 'neutral', detail: 'Momentum expansion tracker: MACD histogram magnitude and bar range vs ATR' },
  ];
  if (divergence) items.push({ label: 'RSI divergence', value: divergence === 'bearish' ? 'Bearish' : 'Bullish', tone: 'warn' });

  return {
    expansion,
    divergence,
    module: {
      id: 'momentum',
      title: 'Momentum',
      score,
      summary: `${score > 10 ? 'Positive' : score < -10 ? 'Negative' : 'Flat'} momentum, ${expansion.toLowerCase()}${divergence ? `, with ${divergence} RSI divergence` : ''}.`,
      items,
    },
  };
}

interface VolatilityOut {
  module: ModuleResult;
  regime: 'Compressed' | 'Normal' | 'Elevated' | 'Extreme';
  ranging: boolean;
}

function volatilityModule(ctx: Context): VolatilityOut {
  const atrPct = ctx.atr.map((a, i) => (ctx.close[i] > 0 ? (100 * a) / ctx.close[i] : NaN));
  const rank = ind.lastFinite(ind.percentRank(atrPct, Math.min(100, ctx.c.length - 15)));
  const bwRank = ind.lastFinite(ind.percentRank(ctx.bands.bandwidth, Math.min(100, ctx.c.length - 20)));
  const adxNow = ind.last(ctx.adx.adx);
  const regime: VolatilityOut['regime'] = rank >= 90 ? 'Extreme' : rank >= 70 ? 'Elevated' : rank <= 20 ? 'Compressed' : 'Normal';
  const ranging = (Number.isFinite(adxNow) && adxNow < 20) || (bwRank <= 25 && adxNow < 25);
  const squeeze = bwRank <= 15;
  const items: Signal[] = [
    { label: 'ATR (14)', value: `${formatPrice(ctx.atrNow)} (${formatNum(ind.last(atrPct), 2)}%)`, tone: 'neutral' },
    { label: 'ATR percentile (100)', value: `${formatNum(rank, 0)}`, tone: rank >= 90 ? 'warn' : 'neutral' },
    { label: 'Bollinger width pct.', value: formatNum(bwRank, 0), tone: squeeze ? 'warn' : 'neutral', detail: squeeze ? 'Squeeze — compression often precedes expansion' : undefined },
    { label: 'Regime', value: regime, tone: regime === 'Extreme' ? 'warn' : 'neutral' },
    { label: 'Range conditions', value: ranging ? 'Yes' : 'No', tone: ranging ? 'warn' : 'neutral', detail: 'ADX < 20, or narrow bands with ADX < 25' },
  ];
  return {
    regime,
    ranging,
    module: {
      id: 'volatility',
      title: 'Volatility & Risk Regime',
      score: null,
      summary: `${regime} volatility (ATR at the ${formatNum(rank, 0)}th percentile of the last 100 bars)${squeeze ? '; bands are in a squeeze' : ''}.`,
      items,
    },
  };
}

function liquidityModule(ctx: Context): ModuleResult {
  if (!ctx.volumeAvailable)
    return {
      id: 'liquidity',
      title: 'Liquidity Participation',
      score: 0,
      summary: 'This data source reports no traded volume for the instrument; participation cannot be measured.',
      items: [{ label: 'Volume', value: 'Unavailable', tone: 'neutral' }],
    };
  const c = ctx.c;
  const vNow = ctx.last.volume;
  const avg = ind.last(ctx.volAvg, 1);
  const rvol = avg > 0 ? vNow / avg : NaN;
  const rvol5 = avg > 0 ? c.slice(-5).reduce((s, x) => s + x.volume, 0) / 5 / avg : NaN;
  const obvLine = ind.obv(c);
  const obvDir = slopeSign(obvLine, 10);
  const cmfNow = ind.last(ind.cmf(c, 20));
  const mfiNow = ind.last(ind.mfi(c, 14));
  const priceDir = slopeSign(ctx.close, 10);
  let score = obvDir * 30 + clamp(cmfNow * 200, -40, 40) + (mfiNow - 50) * 0.6;
  if (rvol5 > 1.2) score *= 1.2;
  score = clamp(Math.round(score), -100, 100);
  const items: Signal[] = [
    { label: 'Last volume', value: formatVolume(vNow), tone: 'neutral' },
    { label: 'Relative volume', value: `${formatNum(rvol, 2)}× (5-bar ${formatNum(rvol5, 2)}×)`, tone: rvol5 >= 1.5 ? 'bull' : rvol5 < 0.7 ? 'warn' : 'neutral', detail: 'Versus the 20-bar average' },
    { label: 'OBV (10-bar)', value: obvDir > 0 ? 'Rising' : obvDir < 0 ? 'Falling' : 'Flat', tone: toneOf(obvDir * 50), detail: obvDir !== 0 && obvDir !== priceDir ? 'Diverging from price' : undefined },
    { label: 'Chaikin money flow (20)', value: formatNum(cmfNow, 3), tone: toneOf(cmfNow * 500) },
    { label: 'Money flow index (14)', value: formatNum(mfiNow), tone: mfiNow >= 80 || mfiNow <= 20 ? 'warn' : toneOf((mfiNow - 50) * 2) },
  ];
  return {
    id: 'liquidity',
    title: 'Liquidity Participation',
    score,
    summary: `${rvol5 >= 1.2 ? 'Above-average' : rvol5 < 0.8 ? 'Below-average' : 'Average'} participation; money flow is ${score > 10 ? 'supportive of buyers' : score < -10 ? 'favouring sellers' : 'balanced'}.`,
    items,
  };
}

interface SmartMoneyOut {
  module: ModuleResult;
  sweeps: ReturnType<typeof findSweeps>;
  traps: ReturnType<typeof findTraps>;
  zones: ReturnType<typeof findOrderBlocks>;
}

function smartMoneyModule(ctx: Context, s: StructureResult, levelPrices: number[], pivot: number): SmartMoneyOut {
  const c = ctx.c;
  const n = c.length;
  const sweeps = findSweeps(c, s.swings, pivot, 15);
  const traps = findTraps(c, levelPrices, 25, 3);
  const obs = findOrderBlocks(c, ctx.atr, 150);
  const fvgs = findFairValueGaps(c, 120);
  const p = ctx.last.close;
  const nearest = (kind: string, below: boolean) =>
    [...obs, ...fvgs]
      .filter((z) => z.kind === kind && (below ? z.top <= p * 1.0005 : z.bottom >= p * 0.9995))
      .sort((a, b) => (below ? b.top - a.top : a.bottom - b.bottom))[0];
  const zones = [
    nearest('bullish-ob', true),
    nearest('bearish-ob', false),
    nearest('bullish-fvg', true),
    nearest('bearish-fvg', false),
  ].filter((z): z is NonNullable<typeof z> => !!z);
  const eq = equalLevels(s.swings, ctx.atrNow * 0.15);
  const inst = ctx.volumeAvailable ? institutionalBars(c, ctx.volAvg, 20) : undefined;
  const ad = ctx.volumeAvailable ? ind.adLine(c) : undefined;
  const adDir = ad ? slopeSign(ad, 20) : 0;
  const priceDir = slopeSign(ctx.close, 20);

  let score = 0;
  const lastSweep = sweeps[sweeps.length - 1];
  if (lastSweep) score += (lastSweep.side === 'sell-side' ? 1 : -1) * (n - 1 - lastSweep.index <= 5 ? 30 : 15);
  const lastTrap = traps[traps.length - 1];
  if (lastTrap) score += (lastTrap.kind === 'bear-trap' ? 1 : -1) * (n - 1 - lastTrap.index <= 5 ? 30 : 15);
  if (inst && inst.count) score += clamp((inst.bullish - inst.bearish) * 12, -30, 30);
  score += adDir * 15;
  if (zones.some((z) => z.kind === 'bullish-ob' && p - z.top <= ctx.atrNow)) score += 10;
  if (zones.some((z) => z.kind === 'bearish-ob' && z.bottom - p <= ctx.atrNow)) score -= 10;
  score = clamp(Math.round(score), -100, 100);

  const items: Signal[] = [];
  items.push(
    lastSweep
      ? {
          label: 'Liquidity sweep',
          value: `${lastSweep.side === 'buy-side' ? 'Buy-side (above high)' : 'Sell-side (below low)'} @ ${formatPrice(lastSweep.level)}`,
          tone: lastSweep.side === 'sell-side' ? 'bull' : 'bear',
          detail: `${n - 1 - lastSweep.index} bar(s) ago — wick through a swing level that closed back inside`,
        }
      : { label: 'Liquidity sweep', value: 'None in last 15 bars', tone: 'neutral' },
  );
  items.push(
    lastTrap
      ? {
          label: 'Trap detection',
          value: `${lastTrap.kind === 'bull-trap' ? 'Bull trap' : 'Bear trap'} @ ${formatPrice(lastTrap.level)}`,
          tone: lastTrap.kind === 'bear-trap' ? 'bull' : 'bear',
          detail: `${n - 1 - lastTrap.index} bar(s) ago — breakout reversed within 3 bars`,
        }
      : { label: 'Trap detection', value: 'No failed breakouts', tone: 'neutral' },
  );
  for (const z of zones) {
    const name = { 'bullish-ob': 'Bullish order block', 'bearish-ob': 'Bearish order block', 'bullish-fvg': 'Bullish fair-value gap', 'bearish-fvg': 'Bearish fair-value gap' }[z.kind];
    items.push({ label: name, value: `${formatPrice(z.bottom)} – ${formatPrice(z.top)}`, tone: z.kind.startsWith('bullish') ? 'bull' : 'bear', detail: z.tested ? 'Tested since formation' : 'Untested' });
  }
  if (eq.length) items.push({ label: 'Equal highs/lows', value: eq.slice(0, 3).map((e) => `${e.type === 'high' ? 'EQH' : 'EQL'} ${formatPrice(e.price)}`).join(', '), tone: 'warn', detail: 'Resting liquidity pools' });
  if (inst) items.push({ label: 'Institutional activity', value: inst.count ? `${inst.count} bar(s): ${inst.bullish} up / ${inst.bearish} down` : 'None detected', tone: toneOf((inst.bullish - inst.bearish) * 30), detail: 'Volume ≥ 2× average with a body ≥ 60% of range, last 20 bars' });
  if (ad) items.push({ label: 'Accumulation / distribution', value: adDir > 0 ? (priceDir < 0 ? 'Accumulation (divergent)' : 'Accumulating') : adDir < 0 ? (priceDir > 0 ? 'Distribution (divergent)' : 'Distributing') : 'Flat', tone: toneOf(adDir * 50) });

  return {
    sweeps,
    traps,
    zones,
    module: {
      id: 'smart-money',
      title: 'Smart Money & Institutional Zones',
      score,
      summary:
        `${lastSweep ? `Recent ${lastSweep.side} liquidity sweep. ` : ''}${lastTrap ? `${lastTrap.kind === 'bull-trap' ? 'Bull' : 'Bear'} trap at ${formatPrice(lastTrap.level)}. ` : ''}` +
        `${zones.length} active institutional zone(s) near price.`,
      items,
    },
  };
}

// ------------------------------------------------------------ multi-timeframe

/** Compact bias for one series: structure + EMA alignment + RSI + Supertrend. */
export function quickBias(c: Candle[]): number {
  if (c.length < 30) return 0;
  const close = ind.closes(c);
  const s = analyzeStructure(c, 3);
  const e20 = ind.last(ind.ema(close, 20));
  const e50 = ind.lastFinite(ind.ema(close, 50));
  const r = ind.last(ind.rsi(close, 14));
  const st = ind.last(ind.supertrend(c, 10, 3).direction);
  const p = close[close.length - 1];
  let score = s.trend * 35 + s.swingTrend * 10;
  score += Number.isFinite(e50) ? sign(e20 - e50) * 15 + sign(p - e50) * 10 : sign(p - e20) * 15;
  score += clamp((r - 50) * 0.8, -15, 15);
  score += Number.isFinite(st) ? st * 15 : 0;
  return clamp(Math.round(score), -100, 100);
}

function biasLabel(score: number): TimeframeBias['bias'] {
  return score >= 20 ? 'Bullish' : score <= -20 ? 'Bearish' : 'Neutral';
}

function mtfModule(tf: Timeframe, ownScore: number, higher: Series[]): { module: ModuleResult; rows: TimeframeBias[] } {
  const rows: TimeframeBias[] = [{ timeframe: tf, score: ownScore, bias: biasLabel(ownScore) }];
  for (const h of higher) {
    const sc = quickBias(h.candles);
    rows.push({ timeframe: h.timeframe, score: sc, bias: biasLabel(sc) });
  }
  if (rows.length === 1)
    return {
      rows,
      module: { id: 'mtf', title: 'Multi-Timeframe Alignment', score: null, summary: 'Higher-timeframe data was not available.', items: [] },
    };
  const higherRows = rows.slice(1);
  const avgHigher = higherRows.reduce((s, r) => s + r.score, 0) / higherRows.length;
  const dirs = rows.map((r) => sign(r.bias === 'Bullish' ? 1 : r.bias === 'Bearish' ? -1 : 0));
  const dominant = sign(dirs.reduce<number>((a, b) => a + b, 0));
  const aligned = dominant === 0 ? 0 : dirs.filter((d) => d === dominant).length;
  const alignment = Math.round((100 * aligned) / rows.length);
  return {
    rows,
    module: {
      id: 'mtf',
      title: 'Multi-Timeframe Alignment',
      score: clamp(Math.round(avgHigher), -100, 100),
      summary: `${alignment}% of ${rows.length} timeframes agree${dominant ? ` on a ${dominant > 0 ? 'bullish' : 'bearish'} bias` : ''}.`,
      items: rows.map((r) => ({ label: timeframeLabel(r.timeframe), value: `${r.bias} (${r.score > 0 ? '+' : ''}${r.score})`, tone: toneOf(r.score, 19) })),
    },
  };
}

// ------------------------------------------------------------------- phase

function marketPhase(ctx: Context, s: StructureResult, ranging: boolean): MarketPhase {
  const n = ctx.c.length;
  const e50 = ctx.ema50;
  const ref = Math.max(0, n - 60);
  const prior = Number.isFinite(e50[ref]) && Number.isFinite(e50[n - 20]) ? (e50[n - 20] - e50[ref]) / (ctx.atrNow || 1) : 0;
  if (ranging) {
    if (prior > 2) return 'Distribution';
    if (prior < -2) return 'Accumulation';
    return 'Range';
  }
  if (s.trend === 1 && s.swingTrend !== -1) return 'Markup';
  if (s.trend === -1 && s.swingTrend !== 1) return 'Markdown';
  return 'Transition';
}

// ------------------------------------------------------------------- report

export function analyze(series: Series, opts: AnalyzeOptions = {}): AnalysisReport {
  const c = series.candles.filter((x) => [x.open, x.high, x.low, x.close].every(Number.isFinite));
  if (c.length < MIN_BARS) throw new Error(`At least ${MIN_BARS} bars are needed for analysis; received ${c.length}.`);
  const pivot = opts.pivot ?? (c.length > 400 ? 4 : 3);
  const volumeAvailable = series.meta.volumeAvailable && c.slice(-50).some((x) => x.volume > 0);
  const ctx = buildContext(c, volumeAvailable);
  const s = analyzeStructure(c, pivot);
  const levelSet = buildLevels(c, s.swings, ctx.atrNow);
  const retest = findBreakRetest(c, levelSet.all, ctx.atrNow);

  const structure = structureModule(ctx, s);
  const trend = trendMatrixModule(ctx);
  const mom = momentumModule(ctx, s);
  const vol = volatilityModule(ctx);
  const liq = liquidityModule(ctx);
  const sm = smartMoneyModule(
    ctx,
    s,
    levelSet.all.filter((l) => l.kind !== 'psychological').map((l) => l.price),
    pivot,
  );

  // Price behaviour module.
  const p = ctx.last.close;
  const sup = levelSet.support;
  const res = levelSet.resistance;
  const psych = levelSet.all.filter((l) => l.kind === 'psychological');
  const distSup = sup ? (p - sup.price) / ctx.atrNow : Infinity;
  const distRes = res ? (res.price - p) / ctx.atrNow : Infinity;
  let pbScore = 0;
  if (retest) pbScore += retest.direction * (retest.holding ? 40 : -15);
  if (distSup < 0.75) pbScore += 15;
  if (distRes < 0.75) pbScore -= 15;
  const priceBehavior: ModuleResult = {
    id: 'price-behavior',
    title: 'Price Behaviour & Key Levels',
    score: clamp(pbScore, -100, 100),
    summary: `Nearest support ${formatPrice(sup?.price)}${sup ? ` (${formatNum(distSup, 1)} ATR below)` : ''}, resistance ${formatPrice(res?.price)}${res ? ` (${formatNum(distRes, 1)} ATR above)` : ''}.${retest ? ` ${retest.direction === 1 ? 'Bullish' : 'Bearish'} break-and-retest of ${formatPrice(retest.level)} is ${retest.holding ? 'holding' : 'failing'}.` : ''}`,
    items: [
      { label: 'Nearest support', value: sup ? `${formatPrice(sup.price)} · ${sup.touches} touch(es)` : '—', tone: 'bull', detail: sup ? `Strength ${sup.strength}/100` : undefined },
      { label: 'Nearest resistance', value: res ? `${formatPrice(res.price)} · ${res.touches} touch(es)` : '—', tone: 'bear', detail: res ? `Strength ${res.strength}/100` : undefined },
      { label: 'Psychological levels', value: psych.map((l) => formatPrice(l.price)).join(' / '), tone: 'neutral' },
      retest
        ? { label: 'Break & retest', value: `${retest.direction === 1 ? 'Bullish' : 'Bearish'} @ ${formatPrice(retest.level)}`, tone: retest.holding ? toneOf(retest.direction * 50) : 'warn', detail: retest.holding ? 'Retest holding' : 'Price closed back through the level' }
        : { label: 'Break & retest', value: 'None in last 30 bars', tone: 'neutral' },
    ],
  };

  // Directional composite.
  const preliminary = Math.round(0.3 * structure.score! + 0.25 * trend.score! + 0.2 * mom.module.score! + 0.15 * sm.module.score! + 0.1 * (liq.score ?? 0));
  const mtf = mtfModule(series.timeframe, preliminary, opts.higher ?? []);
  const weighted: [ModuleResult, number][] = [
    [structure, 0.26],
    [trend, 0.2],
    [mom.module, 0.16],
    [sm.module, 0.1],
    [priceBehavior, 0.06],
    [liq, volumeAvailable ? 0.06 : 0],
    [mtf.module, mtf.module.score === null ? 0 : 0.16],
  ];
  const wSum = weighted.reduce((s2, [, w]) => s2 + w, 0);
  const biasScore = clamp(Math.round(weighted.reduce((s2, [m, w]) => s2 + (m.score ?? 0) * w, 0) / wSum), -100, 100);

  // Condition.
  let condition: MarketCondition;
  if (vol.ranging && Math.abs(biasScore) < 40) condition = 'Consolidating';
  else if (biasScore >= 60) condition = 'Strong Bullish';
  else if (biasScore >= 20) condition = 'Bullish';
  else if (biasScore <= -60) condition = 'Strong Bearish';
  else if (biasScore <= -20) condition = 'Bearish';
  else condition = 'Neutral';

  // Confidence: magnitude + agreement among directional modules, minus data/regime penalties.
  const directional = weighted.filter(([m, w]) => w > 0 && m.score !== null && Math.abs(m.score) > 10);
  const agree = directional.length ? directional.filter(([m]) => sign(m.score!) === sign(biasScore)).length / directional.length : 0;
  const dataNotes: string[] = [];
  let penalty = 0;
  if (vol.regime === 'Extreme') penalty += 10;
  if (c.length < 150) {
    penalty += 10;
    dataNotes.push(`Only ${c.length} bars were available; longer history improves reliability.`);
  }
  if (!volumeAvailable) {
    penalty += 5;
    dataNotes.push('No traded volume reported for this instrument; volume-based modules were excluded.');
  }
  if (!ind.lastFinite(ctx.ema200)) dataNotes.push('Fewer than 200 bars: EMA 200 is unavailable.');
  if ((opts.higher ?? []).length === 0) dataNotes.push('Multi-timeframe alignment was skipped (no higher-timeframe data).');
  const confidence = Math.round(clamp(0.45 * Math.abs(biasScore) + 50 * agree - penalty, 5, 95));

  // Strength index: trend strength + momentum magnitude + expansion + participation.
  const adxNow = ind.last(ctx.adx.adx);
  const adxPart = Number.isFinite(adxNow) ? clamp((adxNow / 45) * 100, 0, 100) : 30;
  const momPart = Math.abs(mom.module.score!);
  const expPart = mom.expansion === 'Expanding' ? 85 : mom.expansion === 'Fading' ? 25 : 50;
  const rvol5 = volumeAvailable && ind.last(ctx.volAvg, 1) > 0 ? c.slice(-5).reduce((s2, x) => s2 + x.volume, 0) / 5 / ind.last(ctx.volAvg, 1) : 1;
  const volPart = clamp(rvol5 * 50, 0, 100);
  const strengthIndex = Math.round(clamp(0.4 * adxPart + 0.25 * momPart + 0.2 * expPart + 0.15 * volPart, 0, 100));
  const strengthLabel =
    strengthIndex >= 70 ? 'Strong — likely to continue' : strengthIndex >= 50 ? 'Moderate' : strengthIndex >= 35 ? 'Weak — losing traction' : 'Very weak';

  const phase = marketPhase(ctx, s, vol.ranging);

  // Risk environment.
  const flags: string[] = [];
  const bias = sign(biasScore);
  const rsiNow = ind.last(ctx.rsi);
  const ext = ctx.atrNow > 0 ? (p - ind.last(ctx.ema20)) / ctx.atrNow : 0;
  const hiAll = Math.max(...c.slice(-50).map((x) => x.high));
  const loAll = Math.min(...c.slice(-50).map((x) => x.low));
  const rangePos = hiAll > loAll ? (p - loAll) / (hiAll - loAll) : 0.5;
  if ((vol.ranging && rangePos > 0.3 && rangePos < 0.7) || confidence < 30)
    flags.push('No-trade zone: price is mid-range or signals conflict — directional edge is low.');
  if ((bias > 0 && (ext > 2.5 || rsiNow > 75)) || (bias < 0 && (ext < -2.5 || rsiNow < 25)))
    flags.push(`Late-entry warning: price is ${formatNum(Math.abs(ext), 1)} ATR from the 20 EMA${rsiNow > 75 || rsiNow < 25 ? ` with RSI ${formatNum(rsiNow)}` : ''}; the move is extended.`);
  const higherBias = mtf.rows.slice(1).map((r) => r.score);
  if (higherBias.length && bias !== 0 && higherBias.every((h) => sign(h) === -bias && Math.abs(h) >= 20))
    flags.push('Counter-trend alert: this timeframe opposes every higher timeframe.');
  if (vol.regime === 'Extreme') flags.push('Volatility is extreme relative to recent history.');
  if (bias > 0 && distRes < 0.5) flags.push(`Resistance ${formatPrice(res?.price)} is within half an ATR.`);
  if (bias < 0 && distSup < 0.5) flags.push(`Support ${formatPrice(sup?.price)} is within half an ATR.`);
  if (mom.divergence && sign(biasScore) === (mom.divergence === 'bearish' ? 1 : -1)) flags.push(`${mom.divergence === 'bearish' ? 'Bearish' : 'Bullish'} RSI divergence against the current bias.`);
  const recentAgainst = [...sm.sweeps, ...sm.traps].some(
    (e) => c.length - 1 - e.index <= 5 && ('side' in e ? (e.side === 'buy-side' ? -1 : 1) : e.kind === 'bear-trap' ? 1 : -1) === -bias,
  );
  if (recentAgainst && bias !== 0) flags.push('A recent liquidity sweep or trap points against the current bias.');
  let riskLevel: RiskLevel = flags.length === 0 ? 'Low' : flags.length === 1 ? 'Moderate' : flags.length === 2 ? 'Elevated' : 'High';
  if (vol.regime === 'Extreme' && riskLevel === 'Low') riskLevel = 'Elevated';

  const riskModule: ModuleResult = {
    id: 'risk',
    title: 'Risk Control',
    score: null,
    summary: flags.length ? `${riskLevel} risk: ${flags.length} caution flag(s).` : 'No caution flags raised.',
    items: [
      { label: 'Risk environment', value: riskLevel, tone: riskLevel === 'Low' ? 'bull' : riskLevel === 'Moderate' ? 'neutral' : 'warn' },
      { label: 'Distance from 20 EMA', value: `${formatNum(ext, 2)} ATR`, tone: Math.abs(ext) > 2.5 ? 'warn' : 'neutral' },
      { label: 'Position in 50-bar range', value: `${Math.round(rangePos * 100)}%`, tone: 'neutral' },
      ...flags.map<Signal>((f) => ({ label: f.split(':')[0], value: f.includes(':') ? f.slice(f.indexOf(':') + 1).trim() : f, tone: 'warn' })),
    ],
  };

  const phaseModule: ModuleResult = {
    id: 'phase',
    title: 'Market Phase',
    score: null,
    summary: {
      Markup: 'Markup: rising structure with expanding participation in the trend direction.',
      Markdown: 'Markdown: falling structure; sellers control swings.',
      Accumulation: 'Accumulation: sideways range after a decline — potential base building.',
      Distribution: 'Distribution: sideways range after an advance — potential topping.',
      Range: 'Range: no prevailing trend before or during the current consolidation.',
      Transition: 'Transition: structure and swing sequence disagree; the trend is changing hands.',
    }[phase],
    items: [{ label: 'Phase', value: phase, tone: phase === 'Markup' || phase === 'Accumulation' ? 'bull' : phase === 'Markdown' || phase === 'Distribution' ? 'bear' : 'neutral' }],
  };

  const insight = buildInsight({ condition, phase, structure: s, mom, vol: vol.regime, ranging: vol.ranging, sup: sup?.price, res: res?.price, mtfSummary: mtf.module.summary, liq, volumeAvailable });
  const verdict = buildVerdict(condition, riskLevel, flags, sup?.price, res?.price);

  return {
    symbol: series.meta.symbol,
    name: series.meta.name,
    currency: series.meta.currency,
    timeframe: series.timeframe,
    generatedAt: opts.now ?? Date.now(),
    lastPrice: p,
    lastTime: ctx.last.time,
    barsAnalyzed: c.length,
    condition,
    biasScore,
    confidence,
    strengthIndex,
    strengthLabel,
    phase,
    risk: { level: riskLevel, flags },
    insight,
    verdict,
    keyLevels: { support: sup?.price, resistance: res?.price },
    modules: [structure, phaseModule, trend, mom.module, vol.module, liq, priceBehavior, sm.module, mtf.module, riskModule],
    levels: levelSet.all,
    zones: sm.zones,
    markers: [...s.markers, ...smartMoneyMarkers(sm.sweeps, sm.traps)].sort((a, b) => a.time - b.time),
    mtf: mtf.rows,
    dataNotes,
  };
}

function buildInsight(x: {
  condition: MarketCondition;
  phase: MarketPhase;
  structure: StructureResult;
  mom: MomentumOut;
  vol: string;
  ranging: boolean;
  sup?: number;
  res?: number;
  mtfSummary: string;
  liq: ModuleResult;
  volumeAvailable: boolean;
}): string {
  const parts: string[] = [];
  const t = x.structure.trend;
  parts.push(
    `The market reads ${x.condition.toLowerCase()} in a ${x.phase.toLowerCase()} phase` +
      (t !== 0 ? `, with ${t === 1 ? 'higher highs and higher lows' : 'lower highs and lower lows'} defining structure` : '') +
      '.',
  );
  parts.push(
    `Momentum is ${x.mom.module.score! > 10 ? 'positive' : x.mom.module.score! < -10 ? 'negative' : 'flat'} and ${x.mom.expansion.toLowerCase()}` +
      (x.mom.divergence ? `, though a ${x.mom.divergence} RSI divergence suggests the move may be tiring` : '') +
      `, under ${x.vol.toLowerCase()} volatility${x.ranging ? ' and range-bound conditions' : ''}.`,
  );
  if (x.volumeAvailable) parts.push(x.liq.summary);
  if (x.sup !== undefined || x.res !== undefined)
    parts.push(`Key decision zones sit at ${formatPrice(x.sup)} (support) and ${formatPrice(x.res)} (resistance).`);
  if (!x.mtfSummary.startsWith('Higher-timeframe data was not')) parts.push(`Timeframe check: ${x.mtfSummary}`);
  return parts.join(' ');
}

function buildVerdict(condition: MarketCondition, risk: RiskLevel, flags: string[], sup?: number, res?: number): string {
  const lvl = (v?: number) => formatPrice(v);
  let core: string;
  switch (condition) {
    case 'Strong Bullish':
      core = `Bullish context is well established; it stays valid while price holds above ${lvl(sup)}.`;
      break;
    case 'Bullish':
      core = `Context leans bullish; confirmation would come from acceptance above ${lvl(res)}, invalidation below ${lvl(sup)}.`;
      break;
    case 'Strong Bearish':
      core = `Bearish context is well established; it stays valid while price holds below ${lvl(res)}.`;
      break;
    case 'Bearish':
      core = `Context leans bearish; confirmation would come from acceptance below ${lvl(sup)}, invalidation above ${lvl(res)}.`;
      break;
    case 'Consolidating':
      core = `Price is consolidating between ${lvl(sup)} and ${lvl(res)}; direction is likely to be decided by a break of either edge.`;
      break;
    default:
      core = 'Signals are mixed and no side has control; clarity is lacking.';
  }
  const caution = flags.some((f) => f.startsWith('No-trade'))
    ? ' Conditions point to standing aside until structure clarifies.'
    : flags.some((f) => f.startsWith('Late-entry'))
      ? ' The move is extended, so chasing carries elevated risk.'
      : risk === 'High' || risk === 'Elevated'
        ? ` Risk is ${risk.toLowerCase()}.`
        : '';
  return `${core}${caution} Educational read only — not a trade recommendation.`;
}
