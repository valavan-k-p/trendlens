/** Strike-level helpers: ATM, moneyness, windows, sorting, filtering and per-column maxima. */
import type { OptionChain, OptionQuote, StrikeRow } from './types';

export type Side = 'call' | 'put';
export type Moneyness = 'ITM' | 'ATM' | 'OTM';
export type QuoteField = 'oi' | 'oiChange' | 'volume' | 'iv' | 'ltp' | 'change' | 'bidQty' | 'bidPrice' | 'askPrice' | 'askQty';
export const QUOTE_FIELDS: QuoteField[] = ['oi', 'oiChange', 'volume', 'iv', 'ltp', 'change', 'bidQty', 'bidPrice', 'askPrice', 'askQty'];

/** Strike closest to the reference price; on an exact tie the lower strike. */
export function atmStrike(rows: StrikeRow[], price: number | undefined): number | undefined {
  if (price === undefined || !Number.isFinite(price) || !rows.length) return undefined;
  let best: number | undefined;
  let dist = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.strike - price);
    if (d < dist - 1e-9 || (Math.abs(d - dist) <= 1e-9 && best !== undefined && r.strike < best)) {
      best = r.strike;
      dist = d;
    }
  }
  return best;
}

/** ITM/OTM relative to the underlying; the ATM strike is labelled ATM on both sides. */
export function moneyness(side: Side, strike: number, price: number, atm?: number): Moneyness {
  if (atm !== undefined && strike === atm) return 'ATM';
  if (side === 'call') return strike < price ? 'ITM' : 'OTM';
  return strike > price ? 'ITM' : 'OTM';
}

/** Rows within `n` strikes either side of the ATM strike (all rows when n is 'all' or there is no ATM). */
export function strikeWindow(rows: StrikeRow[], atm: number | undefined, n: number | 'all'): StrikeRow[] {
  if (n === 'all' || atm === undefined) return rows;
  const i = rows.findIndex((r) => r.strike === atm);
  if (i < 0) return rows;
  return rows.slice(Math.max(0, i - n), i + n + 1);
}

export function quoteValue(q: OptionQuote | undefined, f: QuoteField): number | undefined {
  return q?.[f];
}

export type SortKey = 'strike' | `${Side}.${QuoteField}`;

/** Sorts rows by strike or by one side's column; missing values always sort last. */
export function sortRows(rows: StrikeRow[], key: SortKey, dir: 'asc' | 'desc' = 'asc'): StrikeRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const get = (r: StrikeRow): number | undefined => {
    if (key === 'strike') return r.strike;
    const [side, f] = key.split('.') as [Side, QuoteField];
    return r[side]?.[f];
  };
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va === undefined && vb === undefined) return a.strike - b.strike;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    return (va - vb) * sign || a.strike - b.strike;
  });
}

export interface RowFilter {
  /** "25000", "250" (substring) or a range "25000-26000". */
  search?: string;
  /** Keep only rows where that side is in the money. */
  moneyness?: 'all' | 'call-itm' | 'put-itm';
  /** Drop strikes with no open interest on either side. */
  hideEmpty?: boolean;
}

export function filterRows(rows: StrikeRow[], f: RowFilter, price?: number): StrikeRow[] {
  const s = f.search?.trim().replace(/,/g, '') ?? '';
  const range = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(s);
  return rows.filter((r) => {
    if (range) {
      const lo = Math.min(+range[1], +range[2]);
      const hi = Math.max(+range[1], +range[2]);
      if (r.strike < lo || r.strike > hi) return false;
    } else if (s && !String(r.strike).includes(s)) return false;
    if (f.hideEmpty && !(r.call?.oi || r.put?.oi)) return false;
    if (price !== undefined && f.moneyness === 'call-itm' && !(r.strike < price)) return false;
    if (price !== undefined && f.moneyness === 'put-itm' && !(r.strike > price)) return false;
    return true;
  });
}

export interface Extreme {
  strike: number;
  value: number;
}

/** Strike with the largest value of a field on one side (positive values only for changes). */
export function maxBy(rows: StrikeRow[], side: Side, f: QuoteField): Extreme | undefined {
  let best: Extreme | undefined;
  for (const r of rows) {
    const v = r[side]?.[f];
    if (v === undefined || !Number.isFinite(v) || v <= 0) continue;
    if (!best || v > best.value) best = { strike: r.strike, value: v };
  }
  return best;
}

/** OI or volume expressed in lots when the provider counts units and the lot size is known. */
export function inLots(value: number | undefined, chain: Pick<OptionChain, 'oiUnit' | 'lotSize'>): number | undefined {
  if (value === undefined) return undefined;
  if (chain.oiUnit === 'units' && chain.lotSize && chain.lotSize > 0) return value / chain.lotSize;
  return value;
}
