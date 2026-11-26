/** IPC contract between the renderer and the Electron main process. */
import type { AiProviderId } from '@core/ai/providers';
import type { OptionSnapshot } from '@core/options/option-snapshots';
import type { ParsedOptionCsv } from '@core/options/providers/csv';
import type { OptionChain, OptionExchange, OptionUnderlying } from '@core/options/types';
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
  /** Option-chain provider for NSE and BSE (MCX always uses Dhan). */
  optionProvider: OptionDataProvider;
  /** Risk-free rate assumption for calculated Greeks, percent per year. */
  optionRiskFreeRate: number;
  /** Dividend-yield assumption (percent) used only when put-call parity cannot be measured. */
  optionDividendYield: number;
  /** Seconds between saved option-chain snapshots per underlying/expiry; 0 = do not save. */
  optionSnapshotSeconds: number;
  /** Which option providers have credentials stored (values never reach the renderer). */
  optionKeys: Record<OptionDataProvider, boolean>;
}

export type OptionDataProvider = 'upstox' | 'dhan';

export interface OptionCatalog {
  exchange: OptionExchange;
  /** Whose instrument list this is. */
  source: OptionDataProvider;
  underlyings: OptionUnderlying[];
  updatedAt?: number;
  /** Provider that will serve chains for this exchange, and whether it is set up. */
  chainProvider: OptionDataProvider;
  configured: boolean;
  /** What is missing when chains cannot be fetched (shown to the user). */
  missing?: string;
  error?: string;
}

export interface OptionChainRequest {
  exchange: OptionExchange;
  underlyingId: string;
  expiry: string;
}

export interface OptionChainResult {
  chain: OptionChain;
  /** True when this fetch was also saved as a local snapshot. */
  saved: boolean;
  /** True when a cached chain was returned because the provider's rate limit would be exceeded. */
  cached: boolean;
}

export interface OptionSnapshotMeta {
  t: number;
  expiry: string;
  provider: string;
  summary: OptionSnapshot['summary'];
}

export interface OptionCredentials {
  provider: OptionDataProvider;
  /** Upstox Analytics/access token or Dhan access token; null removes it, undefined keeps it. */
  token?: string | null;
  /** Dhan client id. */
  clientId?: string | null;
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
  /** Set when the chosen model was busy and another model answered, or retries were needed. */
  note?: string;
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
  optionCatalog(exchange: OptionExchange, refresh?: boolean): Promise<OptionCatalog>;
  optionChain(req: OptionChainRequest): Promise<OptionChainResult>;
  setOptionCredentials(c: OptionCredentials): Promise<Settings>;
  testOptionProvider(provider: OptionDataProvider): Promise<{ ok: boolean; message: string }>;
  importOptionCsv(): Promise<{ fileName: string; parsed: ParsedOptionCsv } | null>;
  optionSnapshots(exchange: OptionExchange, symbol: string, expiry?: string): Promise<OptionSnapshotMeta[]>;
  loadOptionSnapshot(exchange: OptionExchange, symbol: string, expiry: string, t: number): Promise<OptionSnapshot | null>;
  saveOptionSnapshot(s: OptionSnapshot): Promise<void>;
  saveText(defaultName: string, content: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  onMenu(handler: (action: string) => void): () => void;
}

declare global {
  interface Window {
    trendlens: TrendLensApi;
  }
}
