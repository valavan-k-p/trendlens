/**
 * MetaTrader 4 option quotes (pure parsing). The bundled TrendLensFeed EA (1.10+) writes
 * Common\Files\TrendLens\options.json with the MarketInfo quote of every Market Watch symbol whose
 * description names a call or put (e.g. "NIFTY 26000 CE Wkly Opt"), plus underlying prices.
 *
 * MT4 carries prices only: no open interest, traded volume, bid/ask sizes, IV or expiry date.
 * The expiry is matched from the exchange contract list (weekly series → nearest expiry, monthly
 * series → nearest monthly expiry) and shown to the user as an assumption they can change.
 */
import { expiryMoment, normalizeRows } from '../option-contracts';
import type { OptionChain, OptionExchange, OptionQuote, OptionUnderlying, StrikeRow } from '../types';

export interface Mt4Quote {
  symbol: string;
  description: string;
  bid: number;
  ask: number;
  /** Last tick time, broker server time (unix seconds as the server clock reads). */
  time: number;
  prevClose?: number;
  digits: number;
}

export interface Mt4OptionsExport {
  version: string;
  serverTime: number;
  gmtTime: number;
  connected: boolean;
  options: Mt4Quote[];
  underlyings: Mt4Quote[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function parseMt4OptionsExport(text: string): Mt4OptionsExport {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (j.feed !== 'TrendLensFeed' || !Array.isArray(j.options)) throw new Error('options.json is not a TrendLensFeed option export.');
  const quote = (q: Record<string, unknown>): Mt4Quote => ({
    symbol: String(q.s ?? ''),
    description: String(q.d ?? ''),
    bid: num(q.b),
    ask: num(q.a),
    time: num(q.t),
    prevClose: num(q.pc) > 0 ? num(q.pc) : undefined,
    digits: num(q.dg),
  });
  return {
    version: String(j.version ?? ''),
    serverTime: num(j.server_time),
    gmtTime: num(j.gmt_time),
    connected: j.connected === true,
    options: (j.options as Record<string, unknown>[]).map(quote).filter((q) => q.symbol),
    underlyings: Array.isArray(j.underlyings) ? (j.underlyings as Record<string, unknown>[]).map(quote).filter((q) => q.symbol) : [],
  };
}

export interface OptionDescription {
  underlying: string;
  strike: number;
  type: 'CE' | 'PE';
  weekly: boolean;
}

/** "NIFTY 26000 CE Wkly Opt" → NIFTY, 26000, CE, weekly. */
export function parseOptionDescription(desc: string): OptionDescription | undefined {
  const m = /^\s*([A-Z0-9&_-]+)\s+(\d+(?:\.\d+)?)\s+(CE|PE)\b(.*)$/i.exec(desc);
  if (!m) return undefined;
  return { underlying: m[1].toUpperCase(), strike: Number(m[2]), type: m[3].toUpperCase() as 'CE' | 'PE', weekly: /\bw(ee)?kly\b|\bweekly\b/i.test(m[4]) };
}

const MCX = new Set(['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD']);
const BSE = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

export function exchangeOf(underlying: string): OptionExchange {
  return MCX.has(underlying) ? 'MCX' : BSE.has(underlying) ? 'BSE' : 'NSE';
}

export interface Mt4Series {
  /** e.g. "NIFTY:W" (weekly) or "NIFTY:M". */
  key: string;
  underlying: string;
  exchange: OptionExchange;
  weekly: boolean;
  calls: Map<number, Mt4Quote>;
  puts: Map<number, Mt4Quote>;
}

/** Groups option quotes into series by underlying and weekly/monthly. */
export function groupMt4Series(exp: Mt4OptionsExport): Mt4Series[] {
  const map = new Map<string, Mt4Series>();
  for (const q of exp.options) {
    const d = parseOptionDescription(q.description);
    if (!d) continue;
    const key = `${d.underlying}:${d.weekly ? 'W' : 'M'}`;
    let s = map.get(key);
    if (!s) map.set(key, (s = { key, underlying: d.underlying, exchange: exchangeOf(d.underlying), weekly: d.weekly, calls: new Map(), puts: new Map() }));
    (d.type === 'CE' ? s.calls : s.puts).set(d.strike, q);
  }
  return [...map.values()].sort((a, b) => a.underlying.localeCompare(b.underlying) || Number(a.weekly) - Number(b.weekly));
}

export interface UnderlyingPick {
  quote: Mt4Quote;
  price: number;
  /** True for a futures quote. */
  futures: boolean;
}

/**
 * The underlying price for a series: index/stock options use the spot quote ("<U> Spot Index" /
 * "<U> Cash"); commodity options use the nearest futures ("<U> MCX Fut", not "Next"). A monthly
 * index series without a spot quote falls back to the near-month future, which expires with the
 * monthly options and so is their forward (priced with Black-76).
 */
export function pickUnderlying(series: Pick<Mt4Series, 'underlying' | 'exchange'> & { weekly?: boolean }, unds: Mt4Quote[]): UnderlyingPick | undefined {
  const u = series.underlying;
  const priced = unds.filter((q) => quotePrice(q) !== undefined && q.description.toUpperCase().startsWith(`${u} `));
  const find = (re: RegExp) => priced.find((q) => re.test(q.description));
  const nearFuture = /\bFut\b(?!.*\bNext\b)/i;
  if (series.exchange === 'MCX') {
    const q = find(nearFuture);
    return q ? { quote: q, price: quotePrice(q)!, futures: true } : undefined;
  }
  const spot = find(/\bSpot\b|\bIndex\b|\bCash\b/i);
  if (spot) return { quote: spot, price: quotePrice(spot)!, futures: false };
  const fut = series.weekly === false ? find(nearFuture) : undefined;
  return fut ? { quote: fut, price: quotePrice(fut)!, futures: true } : undefined;
}

/** A single price from an MT4 quote: equal bid/ask (Indian feeds put the LTP there) or the mid. */
export function quotePrice(q: Pick<Mt4Quote, 'bid' | 'ask'>): number | undefined {
  if (q.bid > 0 && q.ask > 0) return q.ask >= q.bid ? (q.bid + q.ask) / 2 : undefined;
  if (q.bid > 0) return q.bid;
  if (q.ask > 0) return q.ask;
  return undefined;
}

function leg(q: Mt4Quote | undefined): OptionQuote | undefined {
  if (!q) return undefined;
  const out: OptionQuote = { instrumentKey: q.symbol };
  if (q.bid > 0 && q.ask > 0 && q.ask > q.bid) {
    // A real two-sided quote.
    out.bidPrice = q.bid;
    out.askPrice = q.ask;
  } else {
    const p = quotePrice(q);
    if (p !== undefined) out.ltp = p;
  }
  if (q.prevClose !== undefined) {
    out.prevClose = q.prevClose;
    const p = out.ltp ?? quotePrice(q);
    if (p !== undefined) out.change = p - q.prevClose;
  }
  return out;
}

/** The expiry a series most likely refers to: weekly → nearest listed expiry; monthly → nearest monthly. */
export function defaultExpiry(series: Pick<Mt4Series, 'weekly'>, u: Pick<OptionUnderlying, 'expiries' | 'monthlyExpiries'> | undefined): string | undefined {
  if (!u?.expiries.length) return undefined;
  if (series.weekly) return u.expiries[0];
  return u.monthlyExpiries?.[0] ?? u.expiries[0];
}

/** Broker server clock offset from UTC (seconds), rounded to 15 minutes. */
export function serverOffset(exp: Pick<Mt4OptionsExport, 'serverTime' | 'gmtTime'>): number {
  return Math.round((exp.serverTime - exp.gmtTime) / 900) * 900;
}

export function mt4Chain(
  series: Mt4Series,
  exp: Mt4OptionsExport,
  o: { expiry: string; lotSize?: number; underlying?: UnderlyingPick; expiryAssumed: boolean },
): OptionChain {
  const strikes = [...new Set([...series.calls.keys(), ...series.puts.keys()])];
  const rows: StrikeRow[] = strikes.map((k) => ({ strike: k, call: leg(series.calls.get(k)), put: leg(series.puts.get(k)) }));
  const notes = [
    'MetaTrader 4 provides option prices only: no open interest, traded volume, bid/ask sizes or IV. IV and Greeks are calculated.',
  ];
  if (o.expiryAssumed) notes.push(`MT4 does not state the expiry; ${o.expiry} is assumed (${series.weekly ? 'nearest weekly' : 'nearest monthly'} series). Change it if your broker's series differs.`);
  if (o.underlying)
    notes.push(
      `Underlying: ${o.underlying.quote.symbol} (${o.underlying.quote.description})${o.underlying.futures && series.exchange !== 'MCX' ? ', the near-month future used as the forward because MT4 has no spot quote' : ''}.`,
    );
  else notes.push('No underlying quote in the export; the underlying is derived from put-call parity.');
  return {
    provider: 'mt4',
    exchange: series.exchange,
    symbol: series.underlying,
    underlyingId: `${series.exchange}:${series.underlying}`,
    expiry: o.expiry,
    expiryTime: expiryMoment(o.expiry, series.exchange),
    underlyingPrice: o.underlying?.price,
    underlyingIsFutures: o.underlying?.futures ?? series.exchange === 'MCX',
    lotSize: o.lotSize,
    oiUnit: 'units',
    fetchedAt: exp.gmtTime,
    rows: normalizeRows(rows),
    notes,
  };
}
