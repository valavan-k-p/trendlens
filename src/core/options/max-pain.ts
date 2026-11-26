/**
 * Max Pain: the settlement price at which the intrinsic value paid out on all open options is
 * smallest. For each candidate settlement strike S:
 *   payout(S) = Σ_K callOI_K · max(S − K, 0) + putOI_K · max(K − S, 0)
 * multiplied by the units each OI figure represents (the lot size when OI is counted in lots,
 * 1 when it is already counted in units). The multiplier scales every candidate equally, so it
 * changes the payout amounts but never which strike is the Max Pain strike.
 */
import type { StrikeRow } from './types';

export interface MaxPainPoint {
  strike: number;
  callPayout: number;
  putPayout: number;
  total: number;
}

export interface MaxPainResult {
  strike: number;
  /** Lowest aggregate payout, in price units × multiplier (₹ when OI is in units of the underlying). */
  payout: number;
  multiplier: number;
  curve: MaxPainPoint[];
}

export function maxPain(rows: StrikeRow[], multiplier = 1): MaxPainResult | undefined {
  const legs = rows.filter((r) => (r.call?.oi ?? 0) > 0 || (r.put?.oi ?? 0) > 0);
  if (!legs.length) return undefined;
  const curve: MaxPainPoint[] = rows.map(({ strike: s }) => {
    let callPayout = 0;
    let putPayout = 0;
    for (const r of legs) {
      const c = r.call?.oi ?? 0;
      const p = r.put?.oi ?? 0;
      if (s > r.strike) callPayout += c * (s - r.strike);
      if (s < r.strike) putPayout += p * (r.strike - s);
    }
    callPayout *= multiplier;
    putPayout *= multiplier;
    return { strike: s, callPayout, putPayout, total: callPayout + putPayout };
  });
  let best = curve[0];
  for (const p of curve) if (p.total < best.total) best = p;
  return { strike: best.strike, payout: best.total, multiplier, curve };
}
