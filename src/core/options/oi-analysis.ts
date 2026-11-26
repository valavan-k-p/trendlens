/**
 * Open-interest analysis. Build-up labels follow the usual price/OI convention for each option
 * leg; they describe what the data is consistent with, not confirmed participant activity.
 */
import type { Side } from './option-chain';
import type { StrikeRow } from './types';

export type Buildup = 'long-buildup' | 'short-buildup' | 'short-covering' | 'long-unwinding' | 'none';

/** Price up + OI up = long build-up; price down + OI up = short build-up; price up + OI down = short covering; price down + OI down = long unwinding. */
export function classifyBuildup(priceChange: number | undefined, oiChange: number | undefined): Buildup {
  if (!priceChange || !oiChange || !Number.isFinite(priceChange) || !Number.isFinite(oiChange)) return 'none';
  if (oiChange > 0) return priceChange > 0 ? 'long-buildup' : 'short-buildup';
  return priceChange > 0 ? 'short-covering' : 'long-unwinding';
}

export const BUILDUP_LABEL: Record<Buildup, string> = {
  'long-buildup': 'Long build-up',
  'short-buildup': 'Short build-up',
  'short-covering': 'Short covering',
  'long-unwinding': 'Long unwinding',
  none: '—',
};

/** Short build-up on a call is commonly read as call writing, on a put as put writing. Interpretation only. */
export function writingLabel(side: Side, b: Buildup): string | undefined {
  if (b !== 'short-buildup') return undefined;
  return side === 'call' ? 'Call writing (interpretation)' : 'Put writing (interpretation)';
}

export interface StrikeBuildup {
  strike: number;
  call: Buildup;
  put: Buildup;
}

export function buildupByStrike(rows: StrikeRow[]): StrikeBuildup[] {
  return rows.map((r) => ({
    strike: r.strike,
    call: classifyBuildup(r.call?.change, r.call?.oiChange),
    put: classifyBuildup(r.put?.change, r.put?.oiChange),
  }));
}

export function buildupCounts(list: StrikeBuildup[], side: Side): Record<Buildup, number> {
  const out: Record<Buildup, number> = { 'long-buildup': 0, 'short-buildup': 0, 'short-covering': 0, 'long-unwinding': 0, none: 0 };
  for (const b of list) out[b[side]]++;
  return out;
}

export interface OiLevel {
  strike: number;
  oi: number;
}

/**
 * Potential support = strikes at or below the underlying with the most put OI; potential
 * resistance = strikes at or above it with the most call OI. Highest first.
 */
export function supportResistance(rows: StrikeRow[], price: number | undefined, n = 3): { supports: OiLevel[]; resistances: OiLevel[] } {
  if (price === undefined) return { supports: [], resistances: [] };
  const top = (side: Side, keep: (k: number) => boolean) =>
    rows
      .filter((r) => keep(r.strike) && (r[side]?.oi ?? 0) > 0)
      .map((r) => ({ strike: r.strike, oi: r[side]!.oi! }))
      .sort((a, b) => b.oi - a.oi)
      .slice(0, n);
  return { supports: top('put', (k) => k <= price), resistances: top('call', (k) => k >= price) };
}

export interface Concentration {
  /** Share (0–1) of the side's total OI held by its top-n strikes. */
  share: number;
  strikes: number[];
}

export function oiConcentration(rows: StrikeRow[], side: Side, n = 3): Concentration | undefined {
  const list = rows.map((r) => ({ strike: r.strike, oi: r[side]?.oi ?? 0 })).filter((x) => x.oi > 0);
  const total = list.reduce((s, x) => s + x.oi, 0);
  if (!total) return undefined;
  const top = [...list].sort((a, b) => b.oi - a.oi).slice(0, n);
  return { share: top.reduce((s, x) => s + x.oi, 0) / total, strikes: top.map((x) => x.strike) };
}
