/** IPC contract between the renderer and the Electron main process. */
import type { AiProviderId } from '@core/ai/providers';
import type { AnalysisReport } from '@core/analysis/types';
import type { SeriesRequest } from '@core/data';
import type { ProviderId, Quote, Series, SymbolInfo, Timeframe } from '@core/types';

export interface WatchItem {
  symbol: string;
  provider: 'mt4' | 'yahoo' | 'binance';
  label?: string;
}

export interface Mt4Status {
  available: boolean;
  terminals: { dataDir: string; installDir?: string; servers: string[]; feedInstalled?: boolean }[];
  symbols: number;
  newestUpdate: number;
  /** True while a live EA heartbeat (TrendLensFeed or MarketDataExporter) is current. */
  liveFeed: boolean;
  liveFeeds: string[];
  liveSymbols: string[];
}

export interface Settings {
  theme: 'dark' | 'light';
  defaultSymbol: SymbolInfo;
  defaultTimeframe: Timeframe;
  /** Seconds between quote refreshes; 0 disables auto refresh. */
  refreshSeconds: number;
  tickerTape: WatchItem[];
  usWatchlist: WatchItem[];
  indiaWatchlist: WatchItem[];
  favorites: SymbolInfo[];
  indicators: { ema20: boolean; ema50: boolean; ema200: boolean; vwap: boolean; bollinger: boolean; supertrend: boolean; levels: boolean; zones: boolean; markers: boolean; volume: boolean };
  lowerPane: 'rsi' | 'macd' | 'stochastic' | 'adx' | 'none';
  /** AI service used for chart-image review. */
  aiProvider: AiProviderId;
  /** Model per provider; empty or missing means the provider's default. */
  aiModels: Partial<Record<AiProviderId, string>>;
  /** Base URL for the 'custom' OpenAI-compatible provider. */
  aiBaseUrl?: string;
  /** 'mt4': MetaTrader 4 history is the primary chart source; online providers fill gaps. */
  dataSource: 'mt4' | 'online';
  /** Optional extra MT4 data folder (the one containing "history"). */
  mt4Folder?: string;
  /** True when the active AI provider is ready (its key is stored; keys never reach the renderer). */
  hasApiKey: boolean;
  /** Providers that have an encrypted key stored. */
  savedKeys: AiProviderId[];
}

export interface HistoryEntry {
  id: string;
  savedAt: number;
  report: AnalysisReport;
  /** Data source the report came from, so the chart can be reopened. */
  provider?: ProviderId;
  note?: string;
}

export interface ChartReviewRequest {
  imageBase64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Optional user question / instrument description. */
  prompt?: string;
  /** Optional summary of the app's own analysis for the same instrument. */
  context?: string;
}

export interface ChartReviewResult {
  text: string;
  model: string;
  /** Provider label, e.g. "Google Gemini". */
  provider: string;
  refused: boolean;
}

export interface AiTestRequest {
  provider: AiProviderId;
  /** A key typed but not saved yet; falls back to the stored key. */
  key?: string;
  baseUrl?: string;
}

export interface AiTestResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export interface TrendLensApi {
  getSeries(req: SeriesRequest): Promise<Series>;
  search(query: string): Promise<SymbolInfo[]>;
  getQuotes(items: WatchItem[]): Promise<Quote[]>;
  mt4Status(): Promise<Mt4Status>;
  mt4Instruments(): Promise<SymbolInfo[]>;
  pickMt4Folder(): Promise<Settings>;
  installMt4Feed(): Promise<{ dataDir: string; experts: string; ok: boolean; error?: string }[]>;
  openMt4Experts(dataDir: string): Promise<void>;
  importCsv(): Promise<Series | null>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  setApiKey(provider: AiProviderId, key: string | null): Promise<Settings>;
  testAi(req: AiTestRequest): Promise<AiTestResult>;
  listHistory(): Promise<HistoryEntry[]>;
  saveHistory(entry: HistoryEntry): Promise<HistoryEntry[]>;
  deleteHistory(id: string): Promise<HistoryEntry[]>;
  reviewChart(req: ChartReviewRequest): Promise<ChartReviewResult>;
  saveText(defaultName: string, content: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  onMenu(handler: (action: string) => void): () => void;
}

declare global {
  interface Window {
    trendlens: TrendLensApi;
  }
}
