/**
 * Option-chain service (main process only): instrument catalogs, provider calls, rate limiting,
 * status and local snapshots. The renderer never sees credentials, URLs or file paths.
 *
 * Routing: NSE and BSE chains use the provider chosen in Settings (Upstox by default);
 * MCX chains always use Dhan, because Upstox does not offer MCX option chains.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyzeGreeks } from '@core/options/iv-analysis';
import { summarizeChain } from '@core/options/option-analytics';
import { shouldSnapshot, snapshotKey, toSnapshot, type OptionSnapshot } from '@core/options/option-snapshots';
import { DHAN_CHAIN_URL, DHAN_SCRIP_MASTER_URL, dhanChainRequest, dhanError, parseDhanChain, parseDhanScripMaster } from '@core/options/providers/dhan';
import { parseUpstoxChain, parseUpstoxInstruments, upstoxChainUrl, upstoxError, UPSTOX_INSTRUMENTS_URL } from '@core/options/providers/upstox';
import type { OptionChain, OptionExchange, OptionUnderlying } from '@core/options/types';
import type { OptionCatalog, OptionChainRequest, OptionChainResult, OptionDataProvider } from '../../shared/api';
import { getSecret, getSettings } from '../store';
import { SnapshotStore } from './snapshot-store';

const TIMEOUT_MS = 20_000;
/** Instrument lists change daily (new strikes, expiries); refresh them after this age. */
const CATALOG_MAX_AGE_MS = 12 * 3600 * 1000;
/** Minimum gap between identical chain requests: Dhan allows one per 3 s, Upstox is given 1 s. */
const MIN_GAP_MS: Record<OptionDataProvider, number> = { dhan: 3100, upstox: 1000 };

const LABEL: Record<OptionDataProvider, string> = { upstox: 'Upstox', dhan: 'Dhan' };

const base = () => join(app.getPath('userData'), 'options');
const cacheDir = () => {
  const d = join(base(), 'cache');
  mkdirSync(d, { recursive: true });
  return d;
};
let snapshots: SnapshotStore | undefined;
const snapStore = () => (snapshots ??= new SnapshotStore(base()));

export function chainProviderFor(exchange: OptionExchange): OptionDataProvider {
  return exchange === 'MCX' ? 'dhan' : getSettings().optionProvider;
}

/** What the user still has to set up before chains can be fetched from a provider, or undefined when ready. */
export function missingSetup(provider: OptionDataProvider, exchange?: OptionExchange): string | undefined {
  if (provider === 'upstox')
    return getSecret('upstox.token')
      ? undefined
      : 'Add an Upstox Analytics Token in Settings → Option chain data. It is free, read-only and valid for one year (Upstox Developer Apps → Analytics → Generate Token).';
  const parts: string[] = [];
  if (!getSecret('dhan.clientId')) parts.push('Dhan client id');
  if (!getSecret('dhan.token')) parts.push('Dhan access token');
  if (!parts.length) return undefined;
  const why = exchange === 'MCX' ? 'MCX option chains come from Dhan (Upstox does not provide them). ' : '';
  return `${why}Add your ${parts.join(' and ')} in Settings → Option chain data. Dhan's option-chain API needs an active Data API subscription; access tokens last 24 hours.`;
}

async function download(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new Error('Could not download the instrument list. Check your internet connection.');
  }
  if (!res.ok) throw new Error(`Instrument list download failed (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/** Returns a cached file, downloading it when missing or older than the max age (stale copy kept on failure). */
async function cachedFile(name: string, url: string, refresh: boolean): Promise<{ data: Buffer; updatedAt: number }> {
  const p = join(cacheDir(), name);
  const fresh = existsSync(p) && Date.now() - statSync(p).mtimeMs < CATALOG_MAX_AGE_MS;
  if (fresh && !refresh) return { data: readFileSync(p), updatedAt: statSync(p).mtimeMs / 1000 };
  try {
    const data = await download(url);
    writeFileSync(p, data);
    return { data, updatedAt: Date.now() / 1000 };
  } catch (e) {
    if (existsSync(p)) return { data: readFileSync(p), updatedAt: statSync(p).mtimeMs / 1000 };
    throw e;
  }
}

const catalogs = new Map<string, { list: OptionUnderlying[]; updatedAt: number }>();
let dhanAll: { list: OptionUnderlying[]; updatedAt: number } | undefined;

async function loadCatalog(source: OptionDataProvider, exchange: OptionExchange, refresh: boolean): Promise<{ list: OptionUnderlying[]; updatedAt: number }> {
  const key = `${source}:${exchange}`;
  const mem = catalogs.get(key);
  if (mem && !refresh && Date.now() / 1000 - mem.updatedAt < CATALOG_MAX_AGE_MS / 1000) return mem;
  if (source === 'upstox') {
    if (exchange === 'MCX') throw new Error('Upstox does not provide MCX option chains.');
    const f = await cachedFile(`upstox-${exchange}.json.gz`, UPSTOX_INSTRUMENTS_URL(exchange), refresh);
    const list = parseUpstoxInstruments(JSON.parse(gunzipSync(f.data).toString('utf8')), exchange);
    const out = { list, updatedAt: f.updatedAt };
    catalogs.set(key, out);
    return out;
  }
  if (!dhanAll || refresh || Date.now() / 1000 - dhanAll.updatedAt > CATALOG_MAX_AGE_MS / 1000) {
    const f = await cachedFile('dhan-scrip-master.csv', DHAN_SCRIP_MASTER_URL, refresh);
    dhanAll = { list: parseDhanScripMaster(f.data.toString('utf8')), updatedAt: f.updatedAt };
  }
  const out = { list: dhanAll.list.filter((u) => u.exchange === exchange && u.dhan), updatedAt: dhanAll.updatedAt };
  catalogs.set(key, out);
  return out;
}

export async function catalog(exchange: OptionExchange, refresh = false): Promise<OptionCatalog> {
  const chainProvider = chainProviderFor(exchange);
  const missing = missingSetup(chainProvider, exchange);
  try {
    const c = await loadCatalog(chainProvider, exchange, refresh);
    return { exchange, source: chainProvider, underlyings: c.list, updatedAt: c.updatedAt, chainProvider, configured: !missing, missing };
  } catch (e) {
    return { exchange, source: chainProvider, underlyings: [], chainProvider, configured: !missing, missing, error: (e as Error).message };
  }
}

function httpMessage(provider: OptionDataProvider, status: number, detail: string | undefined): string {
  const d = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403)
    return provider === 'upstox'
      ? `Upstox rejected the token${d}. Generate a new Analytics Token and save it in Settings.`
      : `Dhan rejected the credentials${d}. Dhan access tokens expire after 24 hours, and the option chain needs a Data API subscription.`;
  if (status === 429) return `${LABEL[provider]} rate limit reached${d}. Slow the auto-refresh down.`;
  if (status >= 500) return `${LABEL[provider]} is having problems (HTTP ${status})${d}.`;
  return `${LABEL[provider]} rejected the request (HTTP ${status})${d}.`;
}

async function call(provider: OptionDataProvider, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error(`${LABEL[provider]} did not answer within ${TIMEOUT_MS / 1000} s.`);
    throw new Error(`Could not reach ${LABEL[provider]}. Check your internet connection.`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const detail = body !== undefined ? (provider === 'upstox' ? upstoxError(body) : dhanError(body)) : text.slice(0, 160).trim() || undefined;
    throw new Error(httpMessage(provider, res.status, detail));
  }
  if (body === undefined) throw new Error(`${LABEL[provider]} returned an unreadable response.`);
  return body;
}

async function fetchChain(provider: OptionDataProvider, u: OptionUnderlying, expiry: string): Promise<OptionChain> {
  const now = Date.now() / 1000;
  if (provider === 'upstox') {
    if (!u.upstoxKey) throw new Error(`Upstox has no instrument key for ${u.symbol}.`);
    const body = await call('upstox', upstoxChainUrl(u.upstoxKey, expiry, process.env.TRENDLENS_UPSTOX_CHAIN_URL || undefined), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${getSecret('upstox.token')}` },
    });
    return parseUpstoxChain(body, u, expiry, now);
  }
  const body = await call('dhan', DHAN_CHAIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'access-token': getSecret('dhan.token') ?? '', 'client-id': getSecret('dhan.clientId') ?? '' },
    body: JSON.stringify(dhanChainRequest(u, expiry)),
  });
  return parseDhanChain(body, u, expiry, now);
}

const lastFetch = new Map<string, { at: number; chain: OptionChain }>();
const lastSaved = new Map<string, number>();

/** ATM IV and summary figures stored with each snapshot (for history, PCR trend and IV rank). */
export function snapshotOf(chain: OptionChain): OptionSnapshot {
  const s = getSettings();
  const sum = summarizeChain(chain);
  const g = analyzeGreeks(chain, { r: s.optionRiskFreeRate / 100, qFallback: s.optionDividendYield / 100, now: chain.fetchedAt });
  return toSnapshot(chain, {
    spot: chain.underlyingPrice,
    pcrOi: sum.pcr.oi,
    pcrVolume: sum.pcr.volume,
    maxPain: sum.maxPain?.strike,
    atm: sum.atm,
    atmIv: g.atmIv,
    callOi: sum.totalCallOi,
    putOi: sum.totalPutOi,
  });
}

export async function chain(req: OptionChainRequest): Promise<OptionChainResult> {
  const provider = chainProviderFor(req.exchange);
  const missing = missingSetup(provider, req.exchange);
  if (missing) throw new Error(missing);
  const cat = await loadCatalog(provider, req.exchange, false);
  const u = cat.list.find((x) => x.id === req.underlyingId);
  if (!u) throw new Error(`${req.underlyingId} is not in the ${LABEL[provider]} ${req.exchange} instrument list.`);
  if (!u.expiries.includes(req.expiry)) throw new Error(`${req.expiry} is not an open expiry for ${u.symbol}.`);

  const key = `${provider}:${req.underlyingId}:${req.expiry}`;
  const prev = lastFetch.get(key);
  if (prev && Date.now() - prev.at < MIN_GAP_MS[provider]) return { chain: prev.chain, saved: false, cached: true };
  const c = await fetchChain(provider, u, req.expiry);
  if (!c.rows.length) throw new Error(`${LABEL[provider]} returned no strikes for ${u.symbol} ${req.expiry}.`);
  lastFetch.set(key, { at: Date.now(), chain: c });

  let saved = false;
  const snapKey = snapshotKey(c.exchange, c.symbol, c.expiry);
  if (shouldSnapshot(lastSaved.get(snapKey), c.fetchedAt, getSettings().optionSnapshotSeconds)) {
    try {
      snapStore().save(snapshotOf(c));
      lastSaved.set(snapKey, c.fetchedAt);
      saved = true;
    } catch {
      // Snapshot saving is best-effort; the live chain is still returned.
    }
  }
  return { chain: c, saved, cached: false };
}

/** Checks stored credentials with one small real request (NIFTY on NSE, or the first MCX underlying for Dhan). */
export async function testProvider(provider: OptionDataProvider): Promise<{ ok: boolean; message: string }> {
  const missing = missingSetup(provider);
  if (missing) return { ok: false, message: missing };
  try {
    const exchange: OptionExchange = 'NSE';
    const cat = await loadCatalog(provider, exchange, false);
    const u = cat.list.find((x) => x.symbol === 'NIFTY') ?? cat.list[0];
    if (!u) return { ok: false, message: 'The instrument list has no NSE option underlyings.' };
    const c = await fetchChain(provider, u, u.expiries[0]);
    return { ok: true, message: `${LABEL[provider]} works: ${u.symbol} ${u.expiries[0]} returned ${c.rows.length} strikes${c.underlyingPrice ? `, underlying ${c.underlyingPrice}` : ''}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export const listSnapshots = (exchange: OptionExchange, symbol: string, expiry?: string) => snapStore().list(exchange, symbol, expiry);
export const loadSnapshot = (exchange: OptionExchange, symbol: string, expiry: string, t: number) => snapStore().load(exchange, symbol, expiry, t) ?? null;

/** Saves a snapshot the renderer built from an imported CSV (validated shape only). */
export function saveImportedSnapshot(s: OptionSnapshot): void {
  if (!s || s.v !== 1 || !Array.isArray(s.rows) || !/^\d{4}-\d{2}-\d{2}$/.test(s.expiry) || !['NSE', 'BSE', 'MCX'].includes(s.exchange) || !s.symbol) throw new Error('Invalid snapshot.');
  snapStore().save({ ...s, provider: 'csv' });
}
