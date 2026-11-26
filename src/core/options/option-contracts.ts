/** Expiry timing, market sessions and freshness rules for Indian exchange options. */
import { IST_OFFSET, type OptionExchange, type OptionQuote, type StrikeRow } from './types';

/**
 * Expiry moment used for time-to-expiry. NSE and BSE equity derivatives stop trading at
 * 15:30 IST on expiry day. MCX options on futures trade into the evening session; 23:30 IST
 * is used as the assumed close (some agri contracts close earlier).
 */
export const EXPIRY_CLOSE_IST: Record<OptionExchange, [number, number]> = { NSE: [15, 30], BSE: [15, 30], MCX: [23, 30] };

/** Unix seconds of the expiry close for a YYYY-MM-DD expiry on an exchange. */
export function expiryMoment(expiry: string, exchange: OptionExchange): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!m) throw new Error(`Invalid expiry date "${expiry}" (expected YYYY-MM-DD).`);
  const [h, min] = EXPIRY_CLOSE_IST[exchange];
  return Date.UTC(+m[1], +m[2] - 1, +m[3], h, min) / 1000 - IST_OFFSET;
}

/** IST calendar date (YYYY-MM-DD) of a unix-milliseconds timestamp, e.g. an instrument-master expiry. */
export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET * 1000).toISOString().slice(0, 10);
}

/** Time to expiry in years (ACT/365), never below one minute so models stay defined on expiry day. */
export function yearsToExpiry(expiryTime: number, now: number): number {
  return Math.max(60, expiryTime - now) / (365 * 86400);
}

export function daysToExpiry(expiryTime: number, now: number): number {
  return (expiryTime - now) / 86400;
}

/** Expiries still open at `now` (the expiry day itself stays open until the close). */
export function activeExpiries(expiries: string[], exchange: OptionExchange, now: number): string[] {
  return [...new Set(expiries)].filter((e) => expiryMoment(e, exchange) > now).sort();
}

export type SessionState = 'open' | 'closed';

/**
 * Regular trading hours (weekdays, IST). Exchange holidays are not known to the app, so a
 * holiday shows as "open" with data that simply stops changing.
 */
export function marketSession(exchange: OptionExchange, now: number): SessionState {
  const local = new Date((now + IST_OFFSET) * 1000);
  const dow = local.getUTCDay();
  if (dow === 0 || dow === 6) return 'closed';
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const [open, close] = exchange === 'MCX' ? [9 * 60, 23 * 60 + 55] : [9 * 60 + 15, 15 * 60 + 30];
  return mins >= open && mins <= close ? 'open' : 'closed';
}

export type Freshness = 'fresh' | 'delayed' | 'stale';

/**
 * How current a chain is: during market hours data older than 2 refresh intervals is delayed and
 * older than 5 minutes is stale. Outside market hours the last data of the session is expected.
 */
export function chainFreshness(fetchedAt: number, now: number, exchange: OptionExchange, refreshSec = 30): Freshness {
  const age = now - fetchedAt;
  if (marketSession(exchange, now) === 'closed') return age > 4 * 86400 ? 'stale' : 'fresh';
  if (age > 300) return 'stale';
  if (age > Math.max(60, 2 * refreshSec)) return 'delayed';
  return 'fresh';
}

/** Sorts strike rows ascending and merges duplicate strikes (later sides fill gaps). */
export function normalizeRows(rows: StrikeRow[]): StrikeRow[] {
  const map = new Map<number, StrikeRow>();
  for (const r of rows) {
    if (!Number.isFinite(r.strike)) continue;
    const prev = map.get(r.strike);
    map.set(r.strike, prev ? { strike: r.strike, call: r.call ?? prev.call, put: r.put ?? prev.put } : { ...r });
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

/** Fills derived fields (change, OI change) when the provider gives the inputs but not the difference. */
export function withDerived(q: OptionQuote | undefined): OptionQuote | undefined {
  if (!q) return q;
  const out = { ...q };
  if (out.change === undefined && out.ltp !== undefined && out.prevClose !== undefined && out.prevClose > 0) out.change = out.ltp - out.prevClose;
  if (out.oiChange === undefined && out.oi !== undefined && out.prevOi !== undefined) out.oiChange = out.oi - out.prevOi;
  return out;
}
