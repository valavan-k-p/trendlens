/**
 * Upstox adapter (pure parsing). Documented APIs:
 * - Instrument master (public, no key): https://assets.upstox.com/market-quote/instruments/exchange/{NSE|BSE}.json.gz
 * - Put/Call option chain: GET https://api.upstox.com/v2/option/chain?instrument_key=…&expiry_date=YYYY-MM-DD
 *   with "Authorization: Bearer <token>" (an Analytics Token works: read-only, 1-year validity).
 * Upstox does not offer the option chain for MCX.
 * OI, volume and bid/ask quantities are in units (the documented example's OI 750 = 10 lots of 75).
 */
import { activeExpiries, expiryMoment, istDate, normalizeRows, withDerived } from '../option-contracts';
import type { OptionChain, OptionExchange, OptionQuote, OptionUnderlying, UnderlyingKind } from '../types';

export const UPSTOX_INSTRUMENTS_URL = (exchange: 'NSE' | 'BSE' | 'MCX') => `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
export const UPSTOX_CHAIN_URL = 'https://api.upstox.com/v2/option/chain';

/** `base` exists only so tests can point at a local mock; the app uses the documented URL. */
export function upstoxChainUrl(instrumentKey: string, expiry: string, base = UPSTOX_CHAIN_URL): string {
  return `${base}?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${encodeURIComponent(expiry)}`;
}

interface UpstoxInstrument {
  segment?: string;
  name?: string;
  exchange?: string;
  expiry?: number;
  instrument_type?: string;
  instrument_key?: string;
  underlying_key?: string;
  underlying_symbol?: string;
  underlying_type?: string;
  lot_size?: number;
  strike_price?: number;
  trading_symbol?: string;
  weekly?: boolean;
}

const KIND: Record<string, UnderlyingKind> = { INDEX: 'index', EQUITY: 'stock', COM: 'commodity' };

/** Builds the list of underlyings that have listed options on an exchange, from the public instrument master. */
export function parseUpstoxInstruments(records: unknown, exchange: OptionExchange, now = Date.now() / 1000): OptionUnderlying[] {
  if (!Array.isArray(records)) throw new Error('Upstox instrument file is not a list.');
  const names = new Map<string, string>();
  const groups = new Map<string, { sym: string; kind: UnderlyingKind; lot?: number; exp: Set<string>; monthly: Set<string>; name?: string }>();
  const optSegment = `${exchange}_FO`;
  for (const r of records as UpstoxInstrument[]) {
    if (r.instrument_key && r.name && (r.segment === `${exchange}_INDEX` || r.segment === `${exchange}_EQ`)) names.set(r.instrument_key, r.name);
    if (r.segment !== optSegment || (r.instrument_type !== 'CE' && r.instrument_type !== 'PE')) continue;
    // MCX options sit on a different futures contract per expiry, so they are grouped by commodity.
    const key = exchange === 'MCX' ? (r.underlying_symbol ? `MCX:${r.underlying_symbol}` : undefined) : r.underlying_key;
    const kind = KIND[r.underlying_type ?? ''];
    if (!key || !kind || !r.underlying_symbol || typeof r.expiry !== 'number') continue;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { sym: r.underlying_symbol, kind, lot: r.lot_size, exp: new Set(), monthly: new Set(), name: r.name }));
    g.exp.add(istDate(r.expiry));
    if (r.weekly === false) g.monthly.add(istDate(r.expiry));
  }
  const out: OptionUnderlying[] = [];
  for (const [key, g] of groups) {
    const expiries = activeExpiries([...g.exp], exchange, now);
    if (!expiries.length) continue;
    const monthly = expiries.filter((e) => g.monthly.has(e));
    const upstoxKey = exchange === 'MCX' ? undefined : key;
    out.push({ id: `${exchange}:${g.sym}`, symbol: g.sym, name: names.get(key) ?? (exchange === 'MCX' && g.name ? g.name : g.sym), exchange, kind: g.kind, lotSize: g.lot, expiries, monthlyExpiries: monthly.length ? monthly : undefined, upstoxKey });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === 'index' ? -1 : 1));
}

interface UpstoxSide {
  instrument_key?: string;
  market_data?: { ltp?: number; volume?: number; oi?: number; close_price?: number; bid_price?: number; bid_qty?: number; ask_price?: number; ask_qty?: number; prev_oi?: number };
  option_greeks?: { vega?: number; theta?: number; gamma?: number; delta?: number; iv?: number; pop?: number };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pos = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};

function side(s: UpstoxSide | undefined): OptionQuote | undefined {
  if (!s || !s.market_data) return undefined;
  const m = s.market_data;
  const g = s.option_greeks ?? {};
  return withDerived({
    instrumentKey: s.instrument_key,
    ltp: pos(m.ltp),
    prevClose: pos(m.close_price),
    oi: num(m.oi),
    prevOi: num(m.prev_oi),
    volume: num(m.volume),
    bidPrice: pos(m.bid_price),
    bidQty: num(m.bid_qty),
    askPrice: pos(m.ask_price),
    askQty: num(m.ask_qty),
    iv: pos(g.iv),
    greeks: { delta: num(g.delta), gamma: num(g.gamma), theta: num(g.theta), vega: num(g.vega) },
  });
}

/** Turns an Upstox error body into a message. */
export function upstoxError(body: unknown): string | undefined {
  const b = body as { status?: string; errors?: { message?: string; errorCode?: string }[] } | null;
  if (b?.status === 'error' || Array.isArray(b?.errors)) {
    const e = b?.errors?.[0];
    return e ? `${e.message ?? 'Upstox error'}${e.errorCode ? ` (${e.errorCode})` : ''}` : 'Upstox returned an error.';
  }
  return undefined;
}

export function parseUpstoxChain(body: unknown, u: OptionUnderlying, expiry: string, fetchedAt: number): OptionChain {
  const err = upstoxError(body);
  if (err) throw new Error(err);
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Upstox option chain response has no data list.');
  let spot: number | undefined;
  const rows = data.map((d: { strike_price?: number; underlying_spot_price?: number; call_options?: UpstoxSide; put_options?: UpstoxSide }) => {
    spot ??= pos(d.underlying_spot_price);
    return { strike: Number(d.strike_price), call: side(d.call_options), put: side(d.put_options) };
  });
  return {
    provider: 'upstox',
    exchange: u.exchange,
    symbol: u.symbol,
    underlyingId: u.id,
    expiry,
    expiryTime: expiryMoment(expiry, u.exchange),
    underlyingPrice: spot,
    underlyingIsFutures: false,
    lotSize: u.lotSize,
    oiUnit: 'units',
    fetchedAt,
    rows: normalizeRows(rows),
  };
}
