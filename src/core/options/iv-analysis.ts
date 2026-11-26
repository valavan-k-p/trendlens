/**
 * Implied volatility and Greeks for a whole chain.
 *
 * Model choice (shown to the user, never silent):
 * - Options on futures (MCX): Black-76 on the reported futures price.
 * - Options on spot (NSE/BSE index and stock options): Black-Scholes with the carry yield q implied
 *   by put-call parity near the money (equivalent to Black-76 on the parity forward). When parity
 *   cannot be measured, the user's dividend-yield assumption is used and labelled as assumed.
 * Provider IV/Greeks are used when present and sane; everything else is calculated and labelled.
 */
import { atmStrike, moneyness, type Moneyness, type Side } from './option-chain';
import { yearsToExpiry } from './option-contracts';
import { impliedVolatility, parityForward, perPoint, priceGreeks, thetaPerDay, type PricingModel } from './option-greeks';
import { IST_OFFSET, type OptionChain, type OptionQuote, type StrikeRow } from './types';

export type ValueSource = 'provider' | 'calculated';

export interface GreekValue {
  value: number;
  source: ValueSource;
}

export interface LegGreeks {
  moneyness: Moneyness;
  /** Option price used for calculated IV: mid of a valid bid/ask, else LTP. */
  price?: number;
  priceSource?: 'mid' | 'ltp';
  ivProvider?: number;
  ivCalculated?: number;
  /** IV in percent that the Greeks below use (provider first). */
  iv?: GreekValue;
  delta?: GreekValue;
  gamma?: GreekValue;
  /** Per calendar day (calculated) or as reported (provider). */
  theta?: GreekValue;
  /** Per 1 vol point (calculated) or as reported (provider). */
  vega?: GreekValue;
  /** Per 1 rate point; always calculated (providers here do not report rho). */
  rho?: GreekValue;
}

export interface GreeksRow {
  strike: number;
  call?: LegGreeks;
  put?: LegGreeks;
}

export interface ChainGreeks {
  model: PricingModel;
  /** Spot or futures price the model uses as S. */
  underlying?: number;
  /** Forward used for ATM and smile: futures price, parity forward, or spot carried at r − q. */
  forward?: number;
  forwardSource: 'futures' | 'parity' | 'assumed-yield' | 'none';
  r: number;
  q?: number;
  qSource?: 'parity' | 'assumed';
  T: number;
  atm?: number;
  atmIv?: number;
  rows: GreeksRow[];
  notes: string[];
}

export interface GreeksOptions {
  /** Risk-free rate as a decimal. */
  r: number;
  /** Dividend-yield assumption (decimal) used only when parity cannot be measured. */
  qFallback: number;
  now: number;
}

/** Mid of a valid two-sided quote, else the last traded price. */
export function legPrice(q: OptionQuote | undefined): { price: number; source: 'mid' | 'ltp' } | undefined {
  if (!q) return undefined;
  if (q.bidPrice && q.askPrice && q.bidPrice > 0 && q.askPrice >= q.bidPrice) return { price: (q.bidPrice + q.askPrice) / 2, source: 'mid' };
  if (q.ltp && q.ltp > 0) return { price: q.ltp, source: 'ltp' };
  return undefined;
}

/** Median put-call-parity forward over the (up to) five strikes nearest the reference price that have both prices. */
export function impliedForwardFromParity(rows: StrikeRow[], ref: number | undefined, r: number, T: number): number | undefined {
  const both = rows.filter((x) => legPrice(x.call) && legPrice(x.put));
  if (!both.length) return undefined;
  const center = ref ?? both[Math.floor(both.length / 2)].strike;
  const near = [...both].sort((a, b) => Math.abs(a.strike - center) - Math.abs(b.strike - center)).slice(0, 5);
  const fwds = near.map((x) => parityForward(x.strike, legPrice(x.call)!.price, legPrice(x.put)!.price, r, T)).sort((a, b) => a - b);
  return fwds[Math.floor(fwds.length / 2)];
}

const sane = (v: number | undefined, lo: number, hi: number) => v !== undefined && Number.isFinite(v) && v >= lo && v <= hi;

export function analyzeGreeks(chain: OptionChain, o: GreeksOptions): ChainGreeks {
  const T = yearsToExpiry(chain.expiryTime, o.now);
  const notes: string[] = [];
  const futures = chain.underlyingIsFutures;
  const model: PricingModel = futures ? 'black-76' : 'black-scholes';
  let S = chain.underlyingPrice;
  let forward: number | undefined;
  let forwardSource: ChainGreeks['forwardSource'] = 'none';
  let q: number | undefined;
  let qSource: ChainGreeks['qSource'];

  if (futures) {
    forward = S;
    forwardSource = S ? 'futures' : 'none';
  } else {
    const parity = impliedForwardFromParity(chain.rows, S, o.r, T);
    if (S === undefined && parity !== undefined) {
      // No spot reported (e.g. CSV import): price on the parity forward with Black-76-equivalent q = r.
      S = parity * Math.exp(-o.r * T);
      notes.push('No underlying price reported; the spot is derived from the put-call-parity forward.');
    }
    if (S && parity && T > 0) {
      q = o.r - Math.log(parity / S) / T;
      if (!sane(q, -0.5, 0.5)) {
        q = o.qFallback;
        qSource = 'assumed';
        notes.push('The parity forward looked implausible, so the dividend-yield assumption is used.');
      } else qSource = 'parity';
      forward = qSource === 'parity' ? parity : S * Math.exp((o.r - q) * T);
      forwardSource = qSource === 'parity' ? 'parity' : 'assumed-yield';
    } else if (S) {
      q = o.qFallback;
      qSource = 'assumed';
      forward = S * Math.exp((o.r - q) * T);
      forwardSource = 'assumed-yield';
      notes.push('Put-call parity could not be measured (no two-sided prices); the dividend-yield assumption is used.');
    }
  }

  const atm = atmStrike(chain.rows, forward ?? S);
  const leg = (side: Side, strike: number, quote: OptionQuote | undefined): LegGreeks | undefined => {
    if (!quote) return undefined;
    const out: LegGreeks = { moneyness: moneyness(side, strike, forward ?? S ?? strike, atm) };
    const p = legPrice(quote);
    if (p) {
      out.price = p.price;
      out.priceSource = p.source;
    }
    if (sane(quote.iv, 0.01, 500)) out.ivProvider = quote.iv;
    if (S && p) {
      const iv = impliedVolatility(p.price, { type: side, S, K: strike, T, r: o.r, q, model });
      if (iv !== undefined) out.ivCalculated = iv * 100;
    }
    const ivPct = out.ivProvider ?? out.ivCalculated;
    if (ivPct === undefined) return out;
    out.iv = { value: ivPct, source: out.ivProvider !== undefined ? 'provider' : 'calculated' };
    if (!S) return out;
    const g = priceGreeks({ type: side, S, K: strike, T, r: o.r, q, sigma: ivPct / 100, model });
    const pg = quote.greeks;
    // Provider Greeks count as reliable only when their delta is strictly inside the valid range and
    // agrees with the model within 0.10 (zeros sent for unquoted strikes are rejected this way).
    const pd = pg?.delta;
    const deltaOk =
      pd !== undefined && Number.isFinite(pd) && (side === 'call' ? pd > 0 && pd < 1 : pd < 0 && pd > -1) && Math.abs(pd - g.delta) <= 0.1;
    const positive = (v: number | undefined) => v !== undefined && Number.isFinite(v) && v > 0;
    out.delta = deltaOk ? { value: pd!, source: 'provider' } : { value: g.delta, source: 'calculated' };
    out.gamma = deltaOk && positive(pg?.gamma) ? { value: pg!.gamma!, source: 'provider' } : { value: g.gamma, source: 'calculated' };
    out.theta = deltaOk && pg?.theta !== undefined && Number.isFinite(pg.theta) && pg.theta !== 0 ? { value: pg.theta, source: 'provider' } : { value: thetaPerDay(g.theta), source: 'calculated' };
    out.vega = deltaOk && positive(pg?.vega) ? { value: pg!.vega!, source: 'provider' } : { value: perPoint(g.vega), source: 'calculated' };
    out.rho = { value: perPoint(g.rho), source: 'calculated' };
    return out;
  };

  const rows: GreeksRow[] = chain.rows.map((r) => ({ strike: r.strike, call: leg('call', r.strike, r.call), put: leg('put', r.strike, r.put) }));
  const atmRow = rows.find((r) => r.strike === atm);
  const atmIvs = [atmRow?.call?.iv?.value, atmRow?.put?.iv?.value].filter((v): v is number => v !== undefined);
  return {
    model,
    underlying: S,
    forward,
    forwardSource,
    r: o.r,
    q,
    qSource,
    T,
    atm,
    atmIv: atmIvs.length ? atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length : undefined,
    rows,
    notes,
  };
}

export interface SmilePoint {
  strike: number;
  callIv?: number;
  putIv?: number;
  /** OTM-side IV: put IV below the forward, call IV above it. */
  otmIv?: number;
}

export function ivSmile(g: ChainGreeks): SmilePoint[] {
  const f = g.forward ?? g.underlying;
  return g.rows
    .map((r) => {
      const callIv = r.call?.iv?.value;
      const putIv = r.put?.iv?.value;
      const otmIv = f === undefined ? undefined : r.strike < f ? putIv : callIv;
      return { strike: r.strike, callIv, putIv, otmIv };
    })
    .filter((p) => p.callIv !== undefined || p.putIv !== undefined);
}

export interface Skew {
  /** Percent moneyness used for the wings, e.g. 5 = strikes nearest 95% and 105% of the forward. */
  wingPct: number;
  putWingStrike: number;
  callWingStrike: number;
  putWingIv: number;
  callWingIv: number;
  /** Put wing IV − call wing IV, in vol points (positive = puts richer, the usual equity skew). */
  skew: number;
  /** Put wing IV − ATM IV and call wing IV − ATM IV, in vol points. */
  putVsAtm?: number;
  callVsAtm?: number;
}

export function ivSkew(g: ChainGreeks, wingPct = 5): Skew | undefined {
  const f = g.forward ?? g.underlying;
  if (!f) return undefined;
  const nearest = (target: number, side: Side) => {
    let best: { strike: number; iv: number } | undefined;
    for (const r of g.rows) {
      const iv = r[side]?.iv?.value;
      if (iv === undefined) continue;
      if (!best || Math.abs(r.strike - target) < Math.abs(best.strike - target)) best = { strike: r.strike, iv };
    }
    return best;
  };
  const p = nearest(f * (1 - wingPct / 100), 'put');
  const c = nearest(f * (1 + wingPct / 100), 'call');
  // Require the wings to be reasonably close to the target moneyness (within half the wing).
  if (!p || !c || Math.abs(p.strike / f - (1 - wingPct / 100)) > wingPct / 200 || Math.abs(c.strike / f - (1 + wingPct / 100)) > wingPct / 200) return undefined;
  return {
    wingPct,
    putWingStrike: p.strike,
    callWingStrike: c.strike,
    putWingIv: p.iv,
    callWingIv: c.iv,
    skew: p.iv - c.iv,
    putVsAtm: g.atmIv !== undefined ? p.iv - g.atmIv : undefined,
    callVsAtm: g.atmIv !== undefined ? c.iv - g.atmIv : undefined,
  };
}

export interface IvStats {
  /** Distinct trading days of captured ATM IV. */
  days: number;
  /** Minimum days required before rank/percentile are shown. */
  required: number;
  rank?: number;
  percentile?: number;
  min?: number;
  max?: number;
}

/**
 * IV rank = (current − min) / (max − min) × 100 and IV percentile = share of days with a lower
 * ATM IV, over the last value captured on each IST day. Needs `required` days of real snapshots.
 */
export function ivRankPercentile(history: { t: number; atmIv?: number }[], current: number | undefined, required = 20): IvStats {
  const byDay = new Map<string, number>();
  for (const h of [...history].sort((a, b) => a.t - b.t)) {
    if (h.atmIv === undefined || !Number.isFinite(h.atmIv)) continue;
    byDay.set(new Date((h.t + IST_OFFSET) * 1000).toISOString().slice(0, 10), h.atmIv);
  }
  const vals = [...byDay.values()];
  const out: IvStats = { days: vals.length, required };
  if (current === undefined || vals.length < required) return out;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  out.min = min;
  out.max = max;
  out.rank = max > min ? ((current - min) / (max - min)) * 100 : 50;
  out.percentile = (vals.filter((v) => v < current).length / vals.length) * 100;
  return out;
}
