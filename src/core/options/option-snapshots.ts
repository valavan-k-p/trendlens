/**
 * Compact, timestamped option-chain snapshots captured by TrendLens, and comparisons between
 * them. Only chains that were actually received are stored; nothing is back-filled.
 */
import { QUOTE_FIELDS, type QuoteField } from './option-chain';
import type { OptionChain, OptionExchange, OptionProviderId, OptionQuote, StrikeRow } from './types';

export interface SnapshotSummary {
  spot?: number;
  pcrOi?: number;
  pcrVolume?: number;
  maxPain?: number;
  atm?: number;
  atmIv?: number;
  callOi: number;
  putOi: number;
}

export interface OptionSnapshot {
  v: 1;
  /** Capture time, unix seconds. */
  t: number;
  provider: Exclude<OptionProviderId, 'snapshot'>;
  exchange: OptionExchange;
  symbol: string;
  underlyingId: string;
  expiry: string;
  expiryTime: number;
  underlyingIsFutures: boolean;
  lotSize?: number;
  oiUnit: 'units' | 'lots';
  summary: SnapshotSummary;
  /** Field order of each side in `rows`. */
  fields: QuoteField[];
  /** [strike, ...call fields, ...put fields]; null = not reported. */
  rows: (number | null)[][];
}

export function toSnapshot(chain: OptionChain, summary: SnapshotSummary): OptionSnapshot {
  const side = (q: OptionQuote | undefined) => (q ? QUOTE_FIELDS.map((f) => q[f] ?? null) : QUOTE_FIELDS.map(() => null));
  return {
    v: 1,
    t: chain.fetchedAt,
    provider: chain.provider === 'snapshot' ? 'csv' : chain.provider,
    exchange: chain.exchange,
    symbol: chain.symbol,
    underlyingId: chain.underlyingId,
    expiry: chain.expiry,
    expiryTime: chain.expiryTime,
    underlyingIsFutures: chain.underlyingIsFutures,
    lotSize: chain.lotSize,
    oiUnit: chain.oiUnit,
    summary,
    fields: QUOTE_FIELDS,
    rows: chain.rows.map((r) => [r.strike, ...side(r.call), ...side(r.put)]),
  };
}

/** Rebuilds a chain from a snapshot, for viewing it with the same table and charts. */
export function fromSnapshot(s: OptionSnapshot): OptionChain {
  const n = s.fields.length;
  const side = (vals: (number | null)[], present: boolean): OptionQuote | undefined => {
    if (!present) return undefined;
    const q: OptionQuote = {};
    s.fields.forEach((f, i) => {
      const v = vals[i];
      if (v !== null && v !== undefined) q[f] = v;
    });
    return q;
  };
  const rows: StrikeRow[] = s.rows.map((r) => {
    const c = r.slice(1, 1 + n);
    const p = r.slice(1 + n, 1 + 2 * n);
    return { strike: r[0] as number, call: side(c, c.some((v) => v !== null)), put: side(p, p.some((v) => v !== null)) };
  });
  return {
    provider: 'snapshot',
    exchange: s.exchange,
    symbol: s.symbol,
    underlyingId: s.underlyingId,
    expiry: s.expiry,
    expiryTime: s.expiryTime,
    underlyingPrice: s.summary.spot,
    underlyingIsFutures: s.underlyingIsFutures,
    lotSize: s.lotSize,
    oiUnit: s.oiUnit,
    fetchedAt: s.t,
    rows,
    notes: [`Saved snapshot of ${s.provider === 'csv' ? 'an imported CSV' : `the ${({ upstox: 'Upstox', dhan: 'Dhan', mt4: 'MetaTrader 4' } as const)[s.provider]} feed`}.`],
  };
}

export interface StrikeComparison {
  strike: number;
  callOi?: number;
  putOi?: number;
  /** Current − earlier; undefined when either side is missing. */
  callOiDiff?: number;
  putOiDiff?: number;
  callIvDiff?: number;
  putIvDiff?: number;
  callLtpDiff?: number;
  putLtpDiff?: number;
}

const diff = (a?: number, b?: number) => (a !== undefined && b !== undefined ? a - b : undefined);

/** Strike-by-strike change from an earlier chain to a later one, over the union of strikes. */
export function compareChains(later: OptionChain, earlier: OptionChain): StrikeComparison[] {
  const prev = new Map(earlier.rows.map((r) => [r.strike, r]));
  const strikes = [...new Set([...later.rows.map((r) => r.strike), ...earlier.rows.map((r) => r.strike)])].sort((a, b) => a - b);
  const cur = new Map(later.rows.map((r) => [r.strike, r]));
  return strikes.map((k) => {
    const a = cur.get(k);
    const b = prev.get(k);
    return {
      strike: k,
      callOi: a?.call?.oi,
      putOi: a?.put?.oi,
      callOiDiff: diff(a?.call?.oi, b?.call?.oi),
      putOiDiff: diff(a?.put?.oi, b?.put?.oi),
      callIvDiff: diff(a?.call?.iv, b?.call?.iv),
      putIvDiff: diff(a?.put?.iv, b?.put?.iv),
      callLtpDiff: diff(a?.call?.ltp, b?.call?.ltp),
      putLtpDiff: diff(a?.put?.ltp, b?.put?.ltp),
    };
  });
}

/** Snapshot file key: one file per exchange, underlying and expiry. */
export function snapshotKey(exchange: OptionExchange, symbol: string, expiry: string): string {
  return `${exchange}_${symbol.replace(/[^A-Za-z0-9&_-]/g, '_')}_${expiry}`;
}

/** True when enough time has passed since the last saved snapshot (interval 0 disables saving). */
export function shouldSnapshot(lastSavedAt: number | undefined, now: number, intervalSec: number): boolean {
  if (!(intervalSec > 0)) return false;
  return lastSavedAt === undefined || now - lastSavedAt >= intervalSec;
}
