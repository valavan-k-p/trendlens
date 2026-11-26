/** Chain-level dashboard figures computed from the rows the provider actually reported. */
import { atmStrike, maxBy, type Extreme } from './option-chain';
import { maxPain, type MaxPainResult } from './max-pain';
import { pcrSet, type PcrSet } from './pcr';
import type { OptionChain, StrikeRow } from './types';

export interface ChainSummary {
  totalCallOi: number;
  totalPutOi: number;
  totalCallOiChange: number;
  totalPutOiChange: number;
  totalCallVolume: number;
  totalPutVolume: number;
  pcr: PcrSet;
  maxCallOi?: Extreme;
  maxPutOi?: Extreme;
  /** Largest positive OI change (addition) on each side. */
  maxCallOiAdd?: Extreme;
  maxPutOiAdd?: Extreme;
  atm?: number;
  underlying?: number;
  maxPain?: MaxPainResult;
  /** Strikes with data on each side. */
  callStrikes: number;
  putStrikes: number;
}

const sum = (rows: StrikeRow[], f: (r: StrikeRow) => number | undefined) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);

/** Units each OI figure stands for: the lot size when OI is counted in lots, otherwise 1. */
export function oiMultiplier(chain: Pick<OptionChain, 'oiUnit' | 'lotSize'>): number {
  return chain.oiUnit === 'lots' ? chain.lotSize ?? 1 : 1;
}

/**
 * Totals, PCR, extremes, ATM and Max Pain over the whole chain (all strikes the provider
 * returned), using `price` (underlying, or a parity forward when no underlying is reported) for ATM.
 */
export function summarizeChain(chain: OptionChain, price = chain.underlyingPrice): ChainSummary {
  const rows = chain.rows;
  const t = {
    callOi: sum(rows, (r) => r.call?.oi),
    putOi: sum(rows, (r) => r.put?.oi),
    callOiChange: sum(rows, (r) => r.call?.oiChange),
    putOiChange: sum(rows, (r) => r.put?.oiChange),
    callVolume: sum(rows, (r) => r.call?.volume),
    putVolume: sum(rows, (r) => r.put?.volume),
  };
  return {
    totalCallOi: t.callOi,
    totalPutOi: t.putOi,
    totalCallOiChange: t.callOiChange,
    totalPutOiChange: t.putOiChange,
    totalCallVolume: t.callVolume,
    totalPutVolume: t.putVolume,
    pcr: pcrSet(t),
    maxCallOi: maxBy(rows, 'call', 'oi'),
    maxPutOi: maxBy(rows, 'put', 'oi'),
    maxCallOiAdd: maxBy(rows, 'call', 'oiChange'),
    maxPutOiAdd: maxBy(rows, 'put', 'oiChange'),
    atm: atmStrike(rows, price),
    underlying: price,
    maxPain: maxPain(rows, oiMultiplier(chain)),
    callStrikes: rows.filter((r) => r.call).length,
    putStrikes: rows.filter((r) => r.put).length,
  };
}
