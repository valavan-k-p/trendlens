/** Settings and analysis history, persisted as JSON under the user's app-data folder. */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_PROVIDER_IDS, type AiProviderId } from '@core/ai/providers';
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

export const DEFAULT_SETTINGS: Omit<Settings, 'hasApiKey' | 'savedKeys'> = {
  theme: 'dark',
  defaultSymbol: { symbol: 'NIFTY', name: 'NIFTY 50 index', exchange: 'MT4', assetClass: 'index', provider: 'mt4' },
  defaultTimeframe: '15m',
  refreshSeconds: 30,
  dataSource: 'mt4',
  tickerTape: [
    // MetaTrader 4 instruments first (dropped automatically if MT4 has no history for them).
    { symbol: 'NIFTY', provider: 'mt4' },
    { symbol: 'BANKNIFTY', provider: 'mt4' },
    { symbol: 'SENSEX', provider: 'mt4' },
    { symbol: 'SENSEX-FUT', provider: 'mt4' },
    { symbol: 'MCRUDEOIL', provider: 'mt4', label: 'MCX CRUDE' },
    { symbol: 'MNAG', provider: 'mt4', label: 'MCX NATGAS' },
    { symbol: 'XAUUSD', provider: 'mt4', label: 'GOLD' },
    { symbol: 'XAGUSD', provider: 'mt4', label: 'SILVER' },
    { symbol: 'USOil', provider: 'mt4', label: 'USOIL' },
    { symbol: 'EURUSD', provider: 'mt4' },
    { symbol: 'GBPUSD=X', provider: 'yahoo', label: 'GBPUSD' },
    { symbol: 'JPY=X', provider: 'yahoo', label: 'USDJPY' },
    { symbol: 'AUDUSD=X', provider: 'yahoo', label: 'AUDUSD' },
    { symbol: 'CAD=X', provider: 'yahoo', label: 'USDCAD' },
    { symbol: 'GBPJPY=X', provider: 'yahoo', label: 'GBPJPY' },
    { symbol: '^NDX', provider: 'yahoo', label: 'NAS100' },
    { symbol: '^DJI', provider: 'yahoo', label: 'US30' },
    { symbol: '^GSPC', provider: 'yahoo', label: 'SPX500' },
    { symbol: '^GDAXI', provider: 'yahoo', label: 'GER40' },
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
  indiaWatchlist: [
    ...['NIFTY', 'NIFTY#', 'BANKNIFTY', 'SENSEX', 'SENSEX-FUT', 'MCRUDEOIL', 'MNAG'].map((s) => ({ symbol: s, provider: 'mt4' as const })),
    ...['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS', 'SBIN.NS', 'BHARTIARTL.NS', 'ITC.NS', 'LT.NS'].map((s) => ({ symbol: s, provider: 'yahoo' as const })),
  ],
  favorites: [],
  indicators: { ema20: true, ema50: true, ema200: false, vwap: false, bollinger: false, supertrend: false, levels: true, zones: true, markers: true, volume: true },
  lowerPane: 'rsi',
  aiProvider: 'anthropic',
  aiModels: {},
};

interface StoredSettings extends Partial<Omit<Settings, 'hasApiKey' | 'savedKeys'>> {
  /** Encrypted keys per AI provider. */
  encryptedApiKeys?: Partial<Record<AiProviderId, string>>;
  /** Legacy (v1.0): a single Anthropic key and model. */
  encryptedApiKey?: string;
  aiModel?: string;
}

/** Reads settings.json, moving the v1.0 single Anthropic key/model into the per-provider fields. */
function readStored(): StoredSettings {
  const s = readJson<StoredSettings>('settings.json', {});
  if (s.encryptedApiKey) {
    s.encryptedApiKeys = { anthropic: s.encryptedApiKey, ...(s.encryptedApiKeys ?? {}) };
    delete s.encryptedApiKey;
  }
  if (s.aiModel !== undefined) {
    if (s.aiModel && s.aiModel !== 'claude-opus-5-5') s.aiModels = { anthropic: s.aiModel, ...(s.aiModels ?? {}) };
    delete s.aiModel;
  }
  return s;
}

export function getSettings(): Settings {
  const { encryptedApiKeys = {}, ...rest } = readStored();
  const s = {
    ...DEFAULT_SETTINGS,
    ...rest,
    indicators: { ...DEFAULT_SETTINGS.indicators, ...(rest.indicators ?? {}) },
    aiModels: { ...(rest.aiModels ?? {}) },
  };
  if (!AI_PROVIDER_IDS.includes(s.aiProvider)) s.aiProvider = 'anthropic';
  const savedKeys = AI_PROVIDER_IDS.filter((p) => !!encryptedApiKeys[p]);
  const ready = s.aiProvider === 'custom' ? !!s.aiBaseUrl : savedKeys.includes(s.aiProvider);
  return { ...s, hasApiKey: ready, savedKeys };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const stored = readStored();
  const { hasApiKey: _a, savedKeys: _b, ...clean } = patch;
  writeJson('settings.json', { ...stored, ...clean });
  return getSettings();
}

/** Stores a provider's API key encrypted with the OS keychain (DPAPI on Windows); null removes it. */
export function setApiKey(provider: AiProviderId, key: string | null): Settings {
  if (!AI_PROVIDER_IDS.includes(provider)) throw new Error('Unknown AI provider.');
  const stored = readStored();
  const keys = { ...(stored.encryptedApiKeys ?? {}) };
  if (key && key.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; the key was not saved.');
    keys[provider] = safeStorage.encryptString(key.trim()).toString('base64');
  } else {
    delete keys[provider];
  }
  stored.encryptedApiKeys = keys;
  writeJson('settings.json', stored);
  return getSettings();
}

export function getApiKey(provider: AiProviderId): string | undefined {
  const enc = readStored().encryptedApiKeys?.[provider];
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
