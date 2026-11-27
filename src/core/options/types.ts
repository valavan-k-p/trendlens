/** Option-chain data model shared by every provider adapter, the analytics and the UI. */

export type OptionExchange = 'NSE' | 'BSE' | 'MCX';
/** Where a chain came from. 'snapshot' = a locally saved chain being viewed again. */
export type OptionProviderId = 'upstox' | 'dhan' | 'mt4' | 'csv' | 'snapshot';
export type UnderlyingKind = 'index' | 'stock' | 'commodity';

export const OPTION_EXCHANGES: OptionExchange[] = ['NSE', 'BSE', 'MCX'];

/** An instrument that has listed options, with the handles each provider needs to fetch its chain. */
export interface OptionUnderlying {
  /** Provider-neutral id, e.g. "NSE:NIFTY". */
  id: string;
  symbol: string;
  name: string;
  exchange: OptionExchange;
  kind: UnderlyingKind;
  /** Contract lot size from the exchange instrument master (units per lot). */
  lotSize?: number;
  /** Listed expiries, YYYY-MM-DD ascending. */
  expiries: string[];
  /** The monthly expiries among them, when the contract list marks weekly series. */
  monthlyExpiries?: string[];
  /** Upstox instrument key of the underlying, e.g. "NSE_INDEX|Nifty 50". */
  upstoxKey?: string;
  /** Dhan underlying: security id + segment; MCX options use a futures contract per expiry. */
  dhan?: { scrip: number; seg: string; futuresByExpiry?: Record<string, number> };
}

/** One side (call or put) at one strike. Undefined = the provider did not report it. */
export interface OptionQuote {
  ltp?: number;
  prevClose?: number;
  /** LTP − previous close. */
  change?: number;
  oi?: number;
  prevOi?: number;
  /** OI − previous OI. */
  oiChange?: number;
  volume?: number;
  bidPrice?: number;
  bidQty?: number;
  askPrice?: number;
  askQty?: number;
  /** Provider-supplied implied volatility, in percent. */
  iv?: number;
  /** Provider-supplied Greeks (as the provider reports them). */
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number };
  instrumentKey?: string;
}

export interface StrikeRow {
  strike: number;
  call?: OptionQuote;
  put?: OptionQuote;
}

export interface OptionChain {
  provider: OptionProviderId;
  exchange: OptionExchange;
  symbol: string;
  underlyingId: string;
  /** YYYY-MM-DD. */
  expiry: string;
  /** Expiry moment, unix seconds (exchange close on the expiry date). */
  expiryTime: number;
  /** Spot price for index/stock options, futures price for options on futures; undefined if not reported. */
  underlyingPrice?: number;
  underlyingIsFutures: boolean;
  lotSize?: number;
  /** What the provider's OI and volume figures count. */
  oiUnit: 'units' | 'lots';
  /** When TrendLens received the data, unix seconds. */
  fetchedAt: number;
  /** Ascending by strike, one row per strike. */
  rows: StrikeRow[];
  notes?: string[];
}

export const IST_OFFSET = 19800; // +05:30, seconds east of UTC
