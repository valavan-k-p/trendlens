/** Settings and analysis history, persisted as JSON under the user's app-data folder. */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry, Settings } from '../shared/api';

const dir = () => app.getPath('userData');
const file = (name: string) => join(dir(), name);

function readJson<T>(name: string, fallback: T): T {
  try {
    const p = file(name);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
function writeJson(name: string, value: unknown): void {
  mkdirSync(dir(), { recursive: true });
  const p = file(name);
  writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2), 'utf8');
  renameSync(`${p}.tmp`, p);
}

export const DEFAULT_SETTINGS: Omit<Settings, 'hasApiKey'> = {
  theme: 'dark',
  defaultSymbol: { symbol: '^NSEI', name: 'NIFTY 50', exchange: 'NSE', assetClass: 'index', provider: 'yahoo' },
  defaultTimeframe: '15m',
  refreshSeconds: 30,
  tickerTape: [
    { symbol: 'EURUSD=X', provider: 'yahoo', label: 'EURUSD' },
    { symbol: 'GBPUSD=X', provider: 'yahoo', label: 'GBPUSD' },
    { symbol: 'JPY=X', provider: 'yahoo', label: 'USDJPY' },
    { symbol: 'AUDUSD=X', provider: 'yahoo', label: 'AUDUSD' },
    { symbol: 'CAD=X', provider: 'yahoo', label: 'USDCAD' },
    { symbol: 'GBPJPY=X', provider: 'yahoo', label: 'GBPJPY' },
    { symbol: 'GC=F', provider: 'yahoo', label: 'GOLD' },
    { symbol: 'SI=F', provider: 'yahoo', label: 'SILVER' },
    { symbol: 'CL=F', provider: 'yahoo', label: 'USOIL' },
    { symbol: '^NDX', provider: 'yahoo', label: 'NAS100' },
    { symbol: '^DJI', provider: 'yahoo', label: 'US30' },
    { symbol: '^GSPC', provider: 'yahoo', label: 'SPX500' },
    { symbol: '^GDAXI', provider: 'yahoo', label: 'GER40' },
    { symbol: '^NSEI', provider: 'yahoo', label: 'NIFTY' },
    { symbol: '^NSEBANK', provider: 'yahoo', label: 'BANKNIFTY' },
    { symbol: 'BTCUSDT', provider: 'binance', label: 'BTCUSD' },
    { symbol: 'ETHUSDT', provider: 'binance', label: 'ETHUSD' },
    { symbol: 'SOLUSDT', provider: 'binance', label: 'SOLUSD' },
    { symbol: 'XRPUSDT', provider: 'binance', label: 'XRPUSD' },
    { symbol: 'AAPL', provider: 'yahoo' },
    { symbol: 'TSLA', provider: 'yahoo' },
    { symbol: 'NVDA', provider: 'yahoo' },
    { symbol: 'MSFT', provider: 'yahoo' },
    { symbol: 'AMZN', provider: 'yahoo' },
  ],
  usWatchlist: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'NFLX', 'AMD', '^IXIC', '^NDX'].map((s) => ({ symbol: s, provider: 'yahoo' as const })),
  indiaWatchlist: ['^NSEI', '^NSEBANK', '^BSESN', 'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS', 'SBIN.NS', 'BHARTIARTL.NS', 'ITC.NS', 'LT.NS'].map((s) => ({
    symbol: s,
    provider: 'yahoo' as const,
  })),
  favorites: [],
  indicators: { ema20: true, ema50: true, ema200: false, vwap: false, bollinger: false, supertrend: false, levels: true, zones: true, markers: true, volume: true },
  lowerPane: 'rsi',
  aiModel: 'claude-opus-5-5',
};

interface StoredSettings extends Partial<Omit<Settings, 'hasApiKey'>> {
  encryptedApiKey?: string;
}

function readStored(): StoredSettings {
  return readJson<StoredSettings>('settings.json', {});
}

export function getSettings(): Settings {
  const s = readStored();
  const { encryptedApiKey, ...rest } = s;
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    indicators: { ...DEFAULT_SETTINGS.indicators, ...(rest.indicators ?? {}) },
    hasApiKey: !!encryptedApiKey,
  };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const stored = readStored();
  const { hasApiKey: _ignored, ...clean } = patch;
  writeJson('settings.json', { ...stored, ...clean });
  return getSettings();
}

/** Stores the Anthropic key encrypted with the OS keychain (DPAPI on Windows). */
export function setApiKey(key: string | null): Settings {
  const stored = readStored();
  if (key && key.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; the key was not saved.');
    stored.encryptedApiKey = safeStorage.encryptString(key.trim()).toString('base64');
  } else {
    delete stored.encryptedApiKey;
  }
  writeJson('settings.json', stored);
  return getSettings();
}

export function getApiKey(): string | undefined {
  const enc = readStored().encryptedApiKey;
  if (!enc) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return undefined;
  }
}

const HISTORY_LIMIT = 200;

export function listHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>('history.json', []);
}

export function saveHistory(entry: HistoryEntry): HistoryEntry[] {
  const list = [entry, ...listHistory().filter((e) => e.id !== entry.id)].slice(0, HISTORY_LIMIT);
  writeJson('history.json', list);
  return list;
}

export function deleteHistory(id: string): HistoryEntry[] {
  const list = listHistory().filter((e) => e.id !== id);
  writeJson('history.json', list);
  return list;
}
