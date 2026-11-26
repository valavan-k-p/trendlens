/** IPC contract between the renderer and the Electron main process. */
import type { AnalysisReport } from '@core/analysis/types';
import type { SeriesRequest } from '@core/data';
import type { ProviderId, Quote, Series, SymbolInfo, Timeframe } from '@core/types';

export interface WatchItem {
  symbol: string;
  provider: 'yahoo' | 'binance';
  label?: string;
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
  aiModel: string;
  /** True when an encrypted Anthropic API key is stored (the key itself never reaches the renderer). */
  hasApiKey: boolean;
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
  refused: boolean;
}

export interface TrendLensApi {
  getSeries(req: SeriesRequest): Promise<Series>;
  search(query: string): Promise<SymbolInfo[]>;
  getQuotes(items: WatchItem[]): Promise<Quote[]>;
  importCsv(): Promise<Series | null>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  setApiKey(key: string | null): Promise<Settings>;
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
