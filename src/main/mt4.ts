/**
 * MetaTrader 4 chart data, read-only, from two places:
 *  1. The terminal's .hst history files — deep history, but MT4 only saves them when it
 *     closes, so they lag while MT4 runs.
 *  2. The MarketDataExporter EA's live output (see ./mt4live) — closed bars as they
 *     complete plus a 2-second heartbeat used to build the forming bar.
 * Each series lays (2) over (1) by bar time.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCatalog,
  candidatePeriods,
  describeMt4Symbol,
  HST_HEADER,
  MT4_PERIODS,
  parseHst,
  pickBestSource,
  splitHstName,
  TF_TO_MT4,
  type Mt4FileInfo,
  type Mt4Symbol,
} from '@core/data/mt4';
import { mergeBars } from '@core/data/mt4live';
import { resample } from '@core/data/resample';
import type { Candle, Quote, Series, SymbolInfo, Timeframe } from '@core/types';
import { timeframeLabel } from '@core/types';
import * as live from './mt4live';
import { isFeedInstalled } from './mt4install';

export interface Mt4Terminal {
  dataDir: string;
  installDir?: string;
  servers: string[];
  /** TrendLensFeed EA present in this terminal's MQL4\Experts. */
  feedInstalled?: boolean;
}

export interface Mt4Status {
  available: boolean;
  terminals: Mt4Terminal[];
  symbols: number;
  newestUpdate: number;
  liveFeed: boolean;
  liveFeeds: string[];
  liveSymbols: string[];
}

const LIVE_SERVER = 'MarketDataExporter';

let extraRoot: string | undefined;
export function setMt4Folder(folder: string | undefined): void {
  extraRoot = folder || undefined;
  catalogAt = 0;
}

function readOrigin(dir: string): string | undefined {
  try {
    const raw = readFileSync(join(dir, 'origin.txt'));
    // MT4 writes origin.txt as UTF-16LE with a BOM.
    const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString('utf16le') : raw.toString('utf8');
    return text.replace(/\0/g, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

function historyDirs(): { dataDir: string; installDir?: string; history: string }[] {
  const out: { dataDir: string; installDir?: string; history: string }[] = [];
  const seen = new Set<string>();
  const add = (dataDir: string, installDir?: string) => {
    const history = join(dataDir, 'history');
    const key = history.toLowerCase();
    if (seen.has(key) || !existsSync(history)) return;
    seen.add(key);
    out.push({ dataDir, installDir, history });
  };
  const appdata = process.env.APPDATA;
  if (appdata) {
    const root = join(appdata, 'MetaQuotes', 'Terminal');
    if (existsSync(root))
      for (const d of readdirSync(root)) {
        const dir = join(root, d);
        if (/^[0-9A-F]{32}$/i.test(d)) add(dir, readOrigin(dir));
      }
  }
  if (extraRoot) add(extraRoot);
  // Portable-mode installs keep history beside terminal.exe. Skip installs that already
  // have an AppData data folder (origin.txt points at them): that folder is the live one,
  // and history beside the program is only a stale leftover.
  const owned = new Set(out.map((o) => o.installDir?.toLowerCase()).filter(Boolean));
  for (const pf of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean) as string[]) {
    try {
      for (const d of readdirSync(pf)) {
        const dir = join(pf, d);
        if (owned.has(dir.toLowerCase())) continue;
        if (existsSync(join(dir, 'terminal.exe')) && existsSync(join(dir, 'history'))) add(dir, dir);
      }
    } catch {
      /* not readable */
    }
  }
  return out;
}

/** Reads just the 148-byte header to confirm symbol and period. */
function readHeader(path: string): { symbol: string; period: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(HST_HEADER);
    if (readSync(fd, b, 0, HST_HEADER, 0) < HST_HEADER) return null;
    const version = b.readInt32LE(0);
    if (version !== 400 && version !== 401) return null;
    const symbol = b.toString('latin1', 68, 80).replace(/\0[\s\S]*$/, '');
    const period = b.readInt32LE(80);
    return symbol && MT4_PERIODS[period] ? { symbol, period } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let catalog: Mt4Symbol[] = [];
let files: Mt4FileInfo[] = [];
let liveFiles: live.LiveFile[] = [];
let terminals: Mt4Terminal[] = [];
let catalogAt = 0;

function refreshCatalog(force = false): void {
  if (!force && Date.now() - catalogAt < 15_000) return;
  live.startPolling();
  const found: Mt4FileInfo[] = [];
  const terms: Mt4Terminal[] = [];
  for (const h of historyDirs()) {
    const servers: string[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(h.history);
    } catch {
      continue;
    }
    for (const server of entries) {
      const sdir = join(h.history, server);
      if (server === 'deleted' || server === 'default') continue;
      let names: string[];
      try {
        if (!statSync(sdir).isDirectory()) continue;
        names = readdirSync(sdir);
      } catch {
        continue;
      }
      let any = false;
      for (const name of names) {
        if (!/\.hst$/i.test(name)) continue;
        const path = join(sdir, name);
        const hdr = readHeader(path) ?? splitHstName(name);
        if (!hdr) continue;
        const st = statSync(path);
        if (st.size <= HST_HEADER) continue;
        found.push({ server, symbol: hdr.symbol, period: hdr.period, path, size: st.size, mtimeMs: st.mtimeMs });
        any = true;
      }
      if (any) servers.push(server);
    }
    if (servers.length) terms.push({ dataDir: h.dataDir, installDir: h.installDir, servers });
  }
  files = found;
  terminals = terms;
  liveFiles = live.listFiles().filter((f) => MT4_PERIODS[f.period]);
  catalog = buildCatalog(found);
  // Symbols only the exporter writes (no .hst yet) still become chartable.
  const known = new Set(catalog.map((s) => s.symbol.toUpperCase()));
  const extra = buildCatalog(
    liveFiles
      .filter((f) => !known.has(f.symbol.toUpperCase()))
      .map((f) => ({ server: LIVE_SERVER, symbol: f.symbol, period: f.period, path: f.path, size: 1, mtimeMs: f.mtimeMs })),
  );
  catalog = [...catalog, ...extra];
  catalogAt = Date.now();
}

function livePeriods(symbol: string): number[] {
  return liveFiles.filter((f) => f.symbol.toUpperCase() === symbol.toUpperCase()).map((f) => f.period);
}

export function status(): Mt4Status {
  refreshCatalog();
  const newest = Math.max(0, ...files.map((f) => f.mtimeMs), ...liveFiles.map((f) => f.mtimeMs));
  return {
    available: catalog.length > 0,
    terminals: terminals.map((t) => ({ ...t, feedInstalled: isFeedInstalled(t.dataDir) })),
    symbols: catalog.length,
    newestUpdate: newest,
    liveFeed: live.isLive(),
    liveFeeds: live.liveFeeds(),
    liveSymbols: live.liveSymbols(),
  };
}

/** MT4 data folders that can receive the TrendLensFeed EA (have an MQL4 folder). */
export function feedTargets(): string[] {
  refreshCatalog(true);
  return historyDirs()
    .map((h) => h.dataDir)
    .filter((d) => existsSync(join(d, 'MQL4')));
}

export function symbols(): Mt4Symbol[] {
  refreshCatalog();
  return catalog;
}

export function hasSymbol(symbol: string): boolean {
  refreshCatalog();
  return catalog.some((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
}

function toInfo(s: Mt4Symbol): SymbolInfo {
  return {
    symbol: s.symbol,
    name: describeMt4Symbol(s.symbol),
    exchange: `MT4 · ${s.server}`,
    assetClass: /^M(CRUDEOIL|CRO|NAG)/i.test(s.symbol) || /OIL|XAU|XAG/i.test(s.symbol) ? 'commodity' : /USD|EUR|GBP|JPY/i.test(s.symbol) ? 'forex' : s.kind === 'option' ? 'other' : 'index',
    provider: 'mt4',
  };
}

export function search(query: string, max = 12): SymbolInfo[] {
  refreshCatalog();
  const q = query.trim().toUpperCase().replace(/\s+/g, '');
  const words = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const scored = catalog
    .map((s) => {
      const name = describeMt4Symbol(s.symbol).toUpperCase();
      const sym = s.symbol.toUpperCase();
      let score = -1;
      if (sym === q) score = 0;
      else if (sym.startsWith(q)) score = 1;
      else if (sym.includes(q)) score = 2;
      else if (words.every((w) => name.includes(w) || sym.includes(w))) score = 3;
      if (score >= 0 && s.kind === 'option') score += 2;
      return { s, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.s.symbol.localeCompare(b.s.symbol));
  return scored.slice(0, max).map((x) => toInfo(x.s));
}

/** All instruments (not option strikes), for the symbol browser. */
export function instruments(): SymbolInfo[] {
  return symbols().filter((s) => s.kind === 'instrument').map(toInfo);
}

const fileCache = new Map<string, { mtimeMs: number; size: number; candles: Candle[] }>();

function readHst(info: Mt4FileInfo): { candles: Candle[]; mtimeMs: number } {
  const st = statSync(info.path);
  const hit = fileCache.get(info.path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const entry = { mtimeMs: st.mtimeMs, size: st.size, candles: parseHst(readFileSync(info.path)).candles };
  fileCache.set(info.path, entry);
  return entry;
}

/** .hst history + exporter closed bars + live forming bar for one MT4 period. */
function barsForPeriod(s: Mt4Symbol, period: number): { candles: Candle[]; updatedMs: number; live: boolean } {
  const hstInfo = files.find((f) => f.server === s.server && f.symbol === s.symbol && f.period === period);
  const hst = hstInfo ? readHst(hstInfo) : undefined;
  const closed = live.closedBars(s.symbol, period);
  const lastClosed = Math.max(hst?.candles.at(-1)?.time ?? 0, closed?.bars.at(-1)?.time ?? 0);
  const form = live.formingBar(s.symbol, period, lastClosed || undefined);
  const formList = form && form.time > lastClosed ? [form] : [];
  return {
    candles: mergeBars(hst?.candles ?? [], closed?.bars ?? [], formList),
    updatedMs: Math.max(hst?.mtimeMs ?? 0, closed?.mtimeMs ?? 0, formList.length ? Date.now() : 0),
    live: formList.length > 0,
  };
}

export function getSeries(symbol: string, tf: Timeframe): Series {
  refreshCatalog();
  const s = catalog.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!s) throw new Error(`MT4 has no history for ${symbol}. Open its chart in MetaTrader 4 first.`);
  const all = [...new Set([...s.periods, ...livePeriods(s.symbol)])].sort((a, b) => a - b);
  const periods = candidatePeriods(all, tf);
  if (!periods.length)
    throw new Error(`MT4 has no ${timeframeLabel(tf)} data for ${symbol} (available: ${all.map((p) => timeframeLabel(MT4_PERIODS[p])).join(', ')}). Open that timeframe in MetaTrader 4, or choose another.`);
  const want = TF_TO_MT4[tf];
  // MT4's own bars for this timeframe (possibly short) define the broker's bar grid.
  const exact = periods.includes(want) ? barsForPeriod(s, want) : undefined;
  const anchor = exact?.candles.at(-1)?.time;
  const sources = periods.map((period) => {
    const b = period === want && exact ? exact : barsForPeriod(s, period);
    return { period, ...b, candles: period === want ? b.candles : resample(b.candles, tf, 0, anchor) };
  });
  const best = pickBestSource(sources, tf);
  if (!best) throw new Error(`MT4's history for ${symbol} is empty. Open its chart in MetaTrader 4 first.`);
  // Deeper history built from finer bars, on the broker's grid, with MT4's exact bars laid on top.
  const candles = best.period !== want && exact?.candles.length ? mergeBars(best.candles, exact.candles) : best.candles;
  return {
    timeframe: tf,
    candles,
    meta: {
      symbol: s.symbol,
      name: describeMt4Symbol(s.symbol),
      exchange: `MT4 · ${s.server}`,
      timezone: best.live ? 'Broker server time · live' : 'Broker server time',
      gmtOffset: 0,
      provider: 'mt4',
      volumeAvailable: best.candles.slice(-50).some((c) => c.volume > 0),
      updatedAt: best.updatedMs,
      sourcePeriod: best.period !== want ? MT4_PERIODS[best.period] : undefined,
    },
  };
}

/** Last price (live heartbeat when available) and change versus the previous session close. */
export function getQuotes(syms: string[]): Quote[] {
  refreshCatalog();
  const out: Quote[] = [];
  for (const sym of syms) {
    const s = catalog.find((x) => x.symbol.toUpperCase() === sym.toUpperCase());
    if (!s) continue;
    try {
      const all = [...new Set([...s.periods, ...livePeriods(s.symbol)])].sort((a, b) => a - b);
      // The finest available period gives the most recent closed price.
      const bars = barsForPeriod(s, all[0]).candles;
      const lq = live.liveQuote(s.symbol);
      const lastBar = bars[bars.length - 1];
      if (!lastBar && !lq) continue;
      const price = lq?.price ?? lastBar.close;
      const time = Math.max(lq?.time ?? 0, lastBar?.time ?? 0);
      const day = Math.floor(time / 86400);
      let prevClose = NaN;
      for (let i = bars.length - 1; i >= 0; i--)
        if (Math.floor(bars[i].time / 86400) < day) {
          prevClose = bars[i].close;
          break;
        }
      const change = Number.isFinite(prevClose) ? price - prevClose : 0;
      out.push({
        symbol: s.symbol,
        name: describeMt4Symbol(s.symbol),
        price,
        previousClose: prevClose,
        change,
        changePct: Number.isFinite(prevClose) && prevClose !== 0 ? (100 * change) / prevClose : 0,
        time,
      });
    } catch {
      /* unreadable file: skip */
    }
  }
  return out;
}
