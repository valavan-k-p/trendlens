/**
 * Dhan adapter (pure parsing). Documented APIs (DhanHQ v2, needs a Data API subscription):
 * - Instrument list (public): https://images.dhan.co/api-data/api-scrip-master-detailed.csv
 * - POST https://api.dhan.co/v2/optionchain  {UnderlyingScrip, UnderlyingSeg, Expiry}
 * - Headers: "access-token", "client-id". Rate limit: one unique request every 3 seconds.
 * Underlyings: indices use their IDX_I security id (NIFTY = 13); stocks their NSE_EQ/BSE_EQ id;
 * MCX options are on futures, so the underlying is the futures contract expiring on or after the
 * option expiry (segment MCX_COMM). The docs do not state OI units. NSE/BSE quantities are treated as
 * units (bid/ask quantities come in multiples of the lot size); MCX quantities are in lots (the
 * instrument list gives MCX lot size 1), and the MCX contract multiplier is not in the list.
 */
import { activeExpiries, expiryMoment, normalizeRows, withDerived } from '../option-contracts';
import type { OptionChain, OptionExchange, OptionQuote, OptionUnderlying } from '../types';

export const DHAN_SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
export const DHAN_CHAIN_URL = 'https://api.dhan.co/v2/optionchain';

interface Group {
  exchange: OptionExchange;
  symbol: string;
  kind: OptionUnderlying['kind'];
  lot?: number;
  exp: Set<string>;
  underlyingSecId?: number;
}

/** Parses the Dhan scrip master into option underlyings for NSE, BSE and MCX. */
export function parseDhanScripMaster(csv: string, now = Date.now() / 1000): OptionUnderlying[] {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(',');
  const c = (n: string) => {
    const i = head.indexOf(n);
    if (i < 0) throw new Error(`Dhan instrument list is missing the ${n} column.`);
    return i;
  };
  const EX = c('EXCH_ID');
  const SEG = c('SEGMENT');
  const ID = c('SECURITY_ID');
  const INST = c('INSTRUMENT');
  const UID = c('UNDERLYING_SECURITY_ID');
  const USYM = c('UNDERLYING_SYMBOL');
  const DISP = c('DISPLAY_NAME');
  const LOT = c('LOT_SIZE');
  const EXP = c('SM_EXPIRY_DATE');

  const groups = new Map<string, Group>();
  const indexIds = new Map<string, { id: number; name: string }>();
  const futures = new Map<string, { id: number; expiry: string }[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(',');
    const ex = f[EX] as OptionExchange;
    if (ex !== 'NSE' && ex !== 'BSE' && ex !== 'MCX') continue;
    const inst = f[INST];
    const sym = f[USYM];
    if (inst === 'INDEX' && f[SEG] === 'I') indexIds.set(`${ex}:${sym}`, { id: Number(f[ID]), name: f[DISP] });
    else if (ex === 'MCX' && inst === 'FUTCOM') {
      const list = futures.get(sym) ?? [];
      list.push({ id: Number(f[ID]), expiry: f[EXP] });
      futures.set(sym, list);
    } else if ((ex !== 'MCX' && f[SEG] === 'D' && (inst === 'OPTIDX' || inst === 'OPTSTK')) || (ex === 'MCX' && inst === 'OPTFUT')) {
      const key = `${ex}:${sym}`;
      let g = groups.get(key);
      if (!g) {
        groups.set(key, (g = { exchange: ex, symbol: sym, kind: inst === 'OPTIDX' ? 'index' : inst === 'OPTSTK' ? 'stock' : 'commodity', lot: ex === 'MCX' ? undefined : Number(f[LOT]) || undefined, exp: new Set() }));
        if (inst === 'OPTSTK') g.underlyingSecId = Number(f[UID]);
      }
      g.exp.add(f[EXP]);
    }
  }
  const out: OptionUnderlying[] = [];
  for (const [key, g] of groups) {
    const expiries = activeExpiries([...g.exp].filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)), g.exchange, now);
    if (!expiries.length) continue;
    const u: OptionUnderlying = { id: key, symbol: g.symbol, name: g.symbol, exchange: g.exchange, kind: g.kind, lotSize: g.lot, expiries };
    if (g.kind === 'index') {
      const idx = indexIds.get(key);
      if (idx) {
        u.dhan = { scrip: idx.id, seg: 'IDX_I' };
        u.name = idx.name || g.symbol;
      }
    } else if (g.kind === 'stock' && g.underlyingSecId) u.dhan = { scrip: g.underlyingSecId, seg: g.exchange === 'NSE' ? 'NSE_EQ' : 'BSE_EQ' };
    else if (g.kind === 'commodity') {
      const futs = (futures.get(g.symbol) ?? []).sort((a, b) => a.expiry.localeCompare(b.expiry));
      const byExpiry: Record<string, number> = {};
      for (const e of expiries) {
        const fut = futs.find((x) => x.expiry >= e);
        if (fut) byExpiry[e] = fut.id;
      }
      if (Object.keys(byExpiry).length) u.dhan = { scrip: futs[0].id, seg: 'MCX_COMM', futuresByExpiry: byExpiry };
    }
    out.push(u);
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === 'index' ? -1 : 1));
}

/** Request body for one chain; MCX uses the futures contract matched to the expiry. */
export function dhanChainRequest(u: OptionUnderlying, expiry: string): { UnderlyingScrip: number; UnderlyingSeg: string; Expiry: string } {
  if (!u.dhan) throw new Error(`Dhan has no underlying id for ${u.symbol}.`);
  const scrip = u.dhan.futuresByExpiry ? u.dhan.futuresByExpiry[expiry] : u.dhan.scrip;
  if (!scrip) throw new Error(`No ${u.symbol} futures contract found for the ${expiry} options.`);
  return { UnderlyingScrip: scrip, UnderlyingSeg: u.dhan.seg, Expiry: expiry };
}

interface DhanLeg {
  last_price?: number;
  oi?: number;
  previous_close_price?: number;
  previous_oi?: number;
  volume?: number;
  top_bid_price?: number;
  top_bid_quantity?: number;
  top_ask_price?: number;
  top_ask_quantity?: number;
  implied_volatility?: number;
  security_id?: number;
  greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pos = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};

function leg(l: DhanLeg | undefined): OptionQuote | undefined {
  if (!l) return undefined;
  return withDerived({
    instrumentKey: l.security_id !== undefined ? String(l.security_id) : undefined,
    ltp: pos(l.last_price),
    prevClose: pos(l.previous_close_price),
    oi: num(l.oi),
    prevOi: num(l.previous_oi),
    volume: num(l.volume),
    bidPrice: pos(l.top_bid_price),
    bidQty: num(l.top_bid_quantity),
    askPrice: pos(l.top_ask_price),
    askQty: num(l.top_ask_quantity),
    iv: pos(l.implied_volatility),
    greeks: l.greeks ? { delta: num(l.greeks.delta), gamma: num(l.greeks.gamma), theta: num(l.greeks.theta), vega: num(l.greeks.vega) } : undefined,
  });
}

export function dhanError(body: unknown): string | undefined {
  const b = body as { status?: string; errorType?: string; errorCode?: string; errorMessage?: string; remarks?: unknown } | null;
  if (b?.errorMessage || b?.errorCode) return `${b.errorMessage ?? 'Dhan error'}${b.errorCode ? ` (${b.errorCode})` : ''}`;
  if (b?.status && b.status !== 'success') return `Dhan returned status "${b.status}".`;
  return undefined;
}

export function parseDhanChain(body: unknown, u: OptionUnderlying, expiry: string, fetchedAt: number): OptionChain {
  const err = dhanError(body);
  if (err) throw new Error(err);
  const data = (body as { data?: { last_price?: number; oc?: Record<string, { ce?: DhanLeg; pe?: DhanLeg }> } })?.data;
  if (!data?.oc || typeof data.oc !== 'object') throw new Error('Dhan option chain response has no "oc" data.');
  const rows = Object.entries(data.oc).map(([k, v]) => ({ strike: Number(k), call: leg(v?.ce), put: leg(v?.pe) }));
  return {
    provider: 'dhan',
    exchange: u.exchange,
    symbol: u.symbol,
    underlyingId: u.id,
    expiry,
    expiryTime: expiryMoment(expiry, u.exchange),
    underlyingPrice: pos(data.last_price),
    underlyingIsFutures: u.kind === 'commodity',
    lotSize: u.lotSize,
    oiUnit: u.exchange === 'MCX' ? 'lots' : 'units',
    fetchedAt,
    rows: normalizeRows(rows),
    notes: [
      u.exchange === 'MCX'
        ? 'MCX OI is in lots; the contract multiplier is not in Dhan’s instrument list, so Max Pain payouts are in price × lots.'
        : 'Dhan does not document the OI unit; OI is treated as quantity (units).',
    ],
  };
}
