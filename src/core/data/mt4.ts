/**
 * MetaTrader 4 history files (.hst), read-only.
 *
 * Layout (little-endian):
 *   header, 148 bytes: int32 version (400 | 401), char[64] copyright, char[12] symbol,
 *                      int32 period (minutes), int32 digits, int32 timesign, int32 last_sync, int32[13] unused
 *   v401 record, 60 bytes: int64 time, double open, high, low, close, int64 tick_volume, int32 spread, int64 real_volume
 *   v400 record, 44 bytes: int32 time, double open, low, high, close, volume
 *
 * Bar times are the broker's server time written as if it were UTC, so they are
 * already "exchange-local" and need no display shift.
 */
import type { Candle, Timeframe } from '../types';

export const HST_HEADER = 148;

export const MT4_PERIODS: Record<number, Timeframe> = {
  1: '1m',
  5: '5m',
  15: '15m',
  30: '30m',
  60: '1h',
  240: '4h',
  1440: '1d',
  10080: '1wk',
  43200: '1mo',
};

export const TF_TO_MT4: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1wk': 10080,
  '1mo': 43200,
};

export interface HstFile {
  version: number;
  symbol: string;
  period: number;
  digits: number;
  candles: Candle[];
}

/** Accepts a Node Buffer or any Uint8Array. */
export function parseHst(bytes: Uint8Array): HstFile {
  if (bytes.byteLength < HST_HEADER) throw new Error('MT4 history file is too short.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getInt32(0, true);
  if (version !== 400 && version !== 401) throw new Error(`Unsupported MT4 history version ${version}.`);
  let symbol = '';
  for (let i = 68; i < 80 && bytes[i] !== 0; i++) symbol += String.fromCharCode(bytes[i]);
  const period = dv.getInt32(80, true);
  const digits = dv.getInt32(84, true);
  const size = version === 401 ? 60 : 44;
  const n = Math.floor((bytes.byteLength - HST_HEADER) / size);
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = HST_HEADER + i * size;
    let c: Candle;
    if (version === 401) {
      c = {
        time: Number(dv.getBigInt64(o, true)),
        open: dv.getFloat64(o + 8, true),
        high: dv.getFloat64(o + 16, true),
        low: dv.getFloat64(o + 24, true),
        close: dv.getFloat64(o + 32, true),
        volume: Number(dv.getBigInt64(o + 40, true)),
      };
    } else {
      c = {
        time: dv.getInt32(o, true),
        open: dv.getFloat64(o + 4, true),
        low: dv.getFloat64(o + 12, true),
        high: dv.getFloat64(o + 20, true),
        close: dv.getFloat64(o + 28, true),
        volume: dv.getFloat64(o + 36, true),
      };
    }
    if (!(c.time > 0) || ![c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
    // Keep bars strictly ascending; a repeated time replaces the earlier bar.
    const prev = candles[candles.length - 1];
    if (prev && c.time === prev.time) candles[candles.length - 1] = c;
    else if (!prev || c.time > prev.time) candles.push(c);
  }
  return { version, symbol, period, digits, candles };
}

/** Builds a v401 .hst buffer (used by tests and fixtures). */
export function encodeHst401(symbol: string, period: number, digits: number, candles: Candle[]): Uint8Array {
  const out = new Uint8Array(HST_HEADER + candles.length * 60);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, 401, true);
  const cr = 'TrendLens test';
  for (let i = 0; i < cr.length; i++) out[4 + i] = cr.charCodeAt(i);
  for (let i = 0; i < Math.min(11, symbol.length); i++) out[68 + i] = symbol.charCodeAt(i);
  dv.setInt32(80, period, true);
  dv.setInt32(84, digits, true);
  candles.forEach((c, i) => {
    const o = HST_HEADER + i * 60;
    dv.setBigInt64(o, BigInt(c.time), true);
    dv.setFloat64(o + 8, c.open, true);
    dv.setFloat64(o + 16, c.high, true);
    dv.setFloat64(o + 24, c.low, true);
    dv.setFloat64(o + 32, c.close, true);
    dv.setBigInt64(o + 40, BigInt(Math.round(c.volume)), true);
  });
  return out;
}

/** Splits "NIFTY15.hst" into symbol "NIFTY" and period 15 (longest known period suffix wins). */
export function splitHstName(fileName: string): { symbol: string; period: number } | null {
  const base = fileName.replace(/\.hst$/i, '');
  if (base === fileName) return null;
  const periods = Object.keys(MT4_PERIODS).sort((a, b) => b.length - a.length || Number(b) - Number(a));
  for (const p of periods) {
    if (base.endsWith(p) && base.length > p.length) return { symbol: base.slice(0, -p.length), period: Number(p) };
  }
  return null;
}

export interface Mt4FileInfo {
  server: string;
  symbol: string;
  period: number;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface Mt4Symbol {
  symbol: string;
  server: string;
  /** Available MT4 periods in minutes, ascending. */
  periods: number[];
  /** Newest file modification time for this symbol. */
  updatedMs: number;
  kind: 'instrument' | 'option';
}

/** Groups history files into symbols. When a symbol exists on several servers, the freshest server wins. */
export function buildCatalog(files: Mt4FileInfo[]): Mt4Symbol[] {
  const by = new Map<string, Mt4Symbol>();
  for (const f of files) {
    const key = `${f.server}\u0000${f.symbol}`;
    const s = by.get(key) ?? { symbol: f.symbol, server: f.server, periods: [], updatedMs: 0, kind: /_\d+$/.test(f.symbol) ? 'option' : 'instrument' };
    if (!s.periods.includes(f.period)) s.periods.push(f.period);
    s.updatedMs = Math.max(s.updatedMs, f.mtimeMs);
    by.set(key, s);
  }
  const best = new Map<string, Mt4Symbol>();
  for (const s of by.values()) {
    s.periods.sort((a, b) => a - b);
    const cur = best.get(s.symbol);
    if (!cur || s.periods.length > cur.periods.length || (s.periods.length === cur.periods.length && s.updatedMs > cur.updatedMs)) best.set(s.symbol, s);
  }
  return [...best.values()].sort((a, b) => (a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === 'instrument' ? -1 : 1));
}

/**
 * Chooses which file to read for a timeframe: the exact period if present, else the
 * largest smaller period that divides it (to resample up), else null.
 */
export function choosePeriod(available: number[], tf: Timeframe): { period: number; resample: boolean } | null {
  const want = TF_TO_MT4[tf];
  if (available.includes(want)) return { period: want, resample: false };
  const lower = available.filter((p) => p < want && (want % p === 0 || want >= 10080)).sort((a, b) => b - a);
  return lower.length ? { period: lower[0], resample: true } : null;
}

/** Periods that can be resampled into `tf` (the exact period and finer divisors), finest last. */
export function candidatePeriods(available: number[], tf: Timeframe): number[] {
  const want = TF_TO_MT4[tf];
  return available.filter((p) => p === want || (p < want && (want % p === 0 || want >= 10080))).sort((a, b) => b - a);
}

/**
 * MT4 often keeps much longer history in a finer timeframe's file than in the chart's
 * own file (e.g. 5m from October, 15m only from last week). Uses the exact file unless
 * a finer, resampled file gives at least 1.5x the bars and is just as recent.
 * Sources are never mixed, because brokers align intraday bars differently per period.
 */
export function pickBestSource<T extends { period: number; candles: Candle[] }>(sources: T[], tf: Timeframe): T | undefined {
  const want = TF_TO_MT4[tf];
  const usable = sources.filter((s) => s.candles.length > 0);
  if (!usable.length) return undefined;
  const lastTime = (s: T) => s.candles[s.candles.length - 1].time;
  const newest = Math.max(...usable.map(lastTime));
  const fresh = usable.filter((s) => lastTime(s) >= newest - want * 60);
  const exact = fresh.find((s) => s.period === want);
  const richest = fresh.reduce((a, b) => (b.candles.length > a.candles.length ? b : a));
  if (exact && richest.candles.length < exact.candles.length * 1.5) return exact;
  return richest;
}

/** Human description of an MT4 symbol, e.g. option strikes. */
export function describeMt4Symbol(symbol: string): string {
  const opt = /^(.*?)_?(C|P)?_(\d+)$/.exec(symbol);
  const known: Record<string, string> = {
    NIFTY: 'NIFTY 50 index',
    'NIFTY#': 'NIFTY futures',
    BANKNIFTY: 'NIFTY BANK index',
    SENSEX: 'S&P BSE SENSEX',
    'SENSEX-FUT': 'SENSEX futures',
    MCRUDEOIL: 'MCX Crude Oil',
    MCRO: 'MCX Crude Oil (contract)',
    MNAG: 'MCX Natural Gas',
    XAUUSD: 'Gold spot',
    XAGUSD: 'Silver spot',
    USOIL: 'WTI crude oil',
    EURUSD: 'Euro / US dollar',
  };
  if (known[symbol.toUpperCase()]) return known[symbol.toUpperCase()];
  if (opt) {
    const families: Record<string, string> = { BNC: 'BANKNIFTY call', BNP: 'BANKNIFTY put', NF_C: 'NIFTY call', NF_P: 'NIFTY put', NFW_C: 'NIFTY weekly call', NFW_P: 'NIFTY weekly put', SC: 'SENSEX call', SP: 'SENSEX put', MCRO_C: 'MCX crude call', MCRO_P: 'MCX crude put' };
    const fam = symbol.replace(/_\d+$/, '');
    if (families[fam]) return `${families[fam]} ${symbol.match(/_(\d+)$/)![1]}`;
  }
  return symbol;
}
