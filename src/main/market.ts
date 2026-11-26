/** Network side of the data providers. Runs in the main process (no browser CORS limits). */
import * as yahoo from '@core/data/yahoo';
import * as binance from '@core/data/binance';
import { looksLikeBinancePair, type SeriesRequest } from '@core/data';
import type { Quote, Series, SymbolInfo } from '@core/types';
import type { WatchItem } from '../shared/api';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TrendLens/1.0';
const TIMEOUT_MS = 15000;

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Data source returned ${res.status} ${res.statusText || 'non-JSON response'}.`);
    }
    if (!res.ok && res.status !== 404 && res.status !== 400) throw new Error(`Data source returned HTTP ${res.status}.`);
    return body;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('The data request timed out. Check your internet connection.');
    if ((e as Error).message?.startsWith('fetch failed')) throw new Error('Network unavailable — could not reach the data source.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Short-lived cache so switching panels or timeframes does not refetch constantly.
const cache = new Map<string, { at: number; value: Series }>();
const CACHE_MS: Record<string, number> = { '1m': 15_000, '5m': 30_000, '15m': 45_000, '30m': 60_000, '1h': 120_000 };

export async function getSeries(req: SeriesRequest): Promise<Series> {
  const key = `${req.provider}:${req.symbol}:${req.timeframe}`;
  const ttl = CACHE_MS[req.timeframe] ?? 300_000;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  let s: Series;
  if (req.provider === 'binance') s = binance.parseKlines(await getJson(binance.klinesUrl(req.symbol, req.timeframe, 600)), req.symbol, req.timeframe);
  else if (req.provider === 'yahoo') s = yahoo.parseChart(await getJson(yahoo.chartUrl(req.symbol, req.timeframe)), req.timeframe);
  else throw new Error('CSV series are loaded through File → Import CSV.');
  if (!s.candles.length) throw new Error(`No ${req.timeframe} bars are available for ${req.symbol}.`);
  cache.set(key, { at: Date.now(), value: s });
  return s;
}

let binanceList: { at: number; data: unknown } | undefined;

export async function search(query: string): Promise<SymbolInfo[]> {
  const q = query.trim();
  if (!q) return [];
  const yahooP = getJson(yahoo.searchUrl(q)).then(yahoo.parseSearch).catch(() => [] as SymbolInfo[]);
  const binanceP = (async () => {
    if (!binanceList || Date.now() - binanceList.at > 3_600_000) binanceList = { at: Date.now(), data: await getJson(binance.allPricesUrl) };
    return binance.searchSymbols(binanceList.data, q, looksLikeBinancePair(q.toUpperCase()) ? 6 : 4);
  })().catch(() => [] as SymbolInfo[]);
  const [y, b] = await Promise.all([yahooP, binanceP]);
  return [...y, ...b];
}

export async function getQuotes(items: WatchItem[]): Promise<Quote[]> {
  const ySyms = items.filter((i) => i.provider === 'yahoo').map((i) => i.symbol);
  const bSyms = items.filter((i) => i.provider === 'binance').map((i) => i.symbol.toUpperCase());
  const jobs: Promise<Quote[]>[] = [];
  for (let i = 0; i < ySyms.length; i += 20)
    jobs.push(getJson(yahoo.sparkUrl(ySyms.slice(i, i + 20))).then(yahoo.parseSpark).catch(() => []));
  if (bSyms.length) jobs.push(getJson(binance.tickerUrl(bSyms)).then(binance.parseTickers).catch(() => []));
  return (await Promise.all(jobs)).flat();
}
