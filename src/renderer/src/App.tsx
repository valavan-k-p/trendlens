import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisReport } from '@core/analysis/types';
import { MIN_BARS } from '@core/analysis/engine';
import { looksLikeBinancePair } from '@core/data';
import { formatPct, formatPrice } from '@core/format';
import { TIMEFRAMES, type Quote, type Series, type SymbolInfo, type Timeframe } from '@core/types';
import type { HistoryEntry, Settings, WatchItem } from '../../shared/api';
import { ChartPanel } from './components/ChartPanel';
import { HelpDialog, SettingsDialog } from './components/Dialogs';
import { ReportView } from './components/ReportView';
import { SymbolSearch, type SymbolSearchHandle } from './components/SymbolSearch';
import { TickerTape } from './components/TickerTape';
import { reportToMarkdown } from './lib/report';
import { runAnalysis } from './lib/runAnalysis';
import { HistoryView } from './views/HistoryView';
import { MarketsView } from './views/MarketsView';
import { UploadView } from './views/UploadView';

type View = 'analyzer' | 'markets' | 'upload' | 'history';
const STAGES = ['Symbol', 'Timeframe', 'Context', 'Structure', 'Momentum', 'Risk view'];
const INTRADAY: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h'];

const PROVIDER_LABEL: Record<SymbolInfo['provider'], string> = { mt4: 'MetaTrader 4', yahoo: 'Yahoo Finance', binance: 'Binance', csv: 'CSV file' };

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const cleanError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [view, setView] = useState<View>('analyzer');
  const [symbol, setSymbol] = useState<SymbolInfo | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [series, setSeries] = useState<Series | null>(null);
  const [csvSeries, setCsvSeries] = useState<Series | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [stage, setStage] = useState(-1);
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map());
  const [quotesAt, setQuotesAt] = useState(0);
  const [dialog, setDialog] = useState<'settings' | 'help' | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [mt4Symbols, setMt4Symbols] = useState<SymbolInfo[]>([]);
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<SymbolSearchHandle>(null);
  const loadSeq = useRef(0);

  const notify = useCallback((msg: string, isError = false) => {
    setToast({ msg, error: isError });
    setTimeout(() => setToast(null), 4500);
  }, []);

  // ---- boot
  useEffect(() => {
    void window.trendlens.getSettings().then((s) => {
      setSettings(s);
      setSymbol(s.defaultSymbol);
      setTimeframe(s.defaultTimeframe);
    });
  }, []);

  useEffect(() => {
    if (settings) document.documentElement.dataset.theme = settings.theme;
  }, [settings?.theme]);

  // MT4 instrument list (re-scanned periodically so newly opened MT4 charts appear).
  useEffect(() => {
    const load = () => void window.trendlens.mt4Instruments().then(setMt4Symbols).catch(() => setMt4Symbols([]));
    load();
    const t = setInterval(() => {
      load();
      setNow(Date.now());
    }, 30_000);
    return () => clearInterval(t);
  }, [settings?.mt4Folder, settings?.dataSource]);

  // ---- data loading
  const loadSeries = useCallback(
    async (quiet = false) => {
      if (!symbol) return;
      if (symbol.provider === 'csv') {
        if (csvSeries) setSeries(csvSeries);
        return;
      }
      const id = ++loadSeq.current;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const s = await window.trendlens.getSeries({ provider: symbol.provider, symbol: symbol.symbol, timeframe });
        if (id !== loadSeq.current) return;
        setSeries(s);
        setError(null);
      } catch (e) {
        if (id !== loadSeq.current) return;
        if (!quiet) {
          setSeries(null);
          setError(cleanError(e));
        }
      } finally {
        if (id === loadSeq.current) setLoading(false);
      }
    },
    [symbol, timeframe, csvSeries],
  );

  useEffect(() => {
    setReport(null);
    setStage(-1);
    void loadSeries();
  }, [loadSeries]);

  // ---- analysis
  const analyse = useCallback(
    async (quiet = false) => {
      if (!series || !symbol) return;
      if (series.candles.length < MIN_BARS) {
        notify(
          `Only ${series.candles.length} bars available — at least ${MIN_BARS} are needed. ` +
            (symbol.provider === 'mt4'
              ? 'In MetaTrader 4, open this chart and press Home (or scroll left) to download more history, or pick a shorter timeframe.'
              : 'Try a shorter timeframe.'),
          true,
        );
        return;
      }
      try {
        if (!quiet) {
          setReport(null);
          for (let i = 0; i < 3; i++) {
            setStage(i);
            await new Promise((r) => setTimeout(r, 120));
          }
        }
        const p = runAnalysis(series, symbol);
        if (!quiet) {
          for (let i = 3; i < STAGES.length; i++) {
            setStage(i);
            await new Promise((r) => setTimeout(r, 160));
          }
        }
        const r = await p;
        setReport(r);
        setStage(STAGES.length);
      } catch (e) {
        setStage(-1);
        notify(cleanError(e), true);
      }
    },
    [series, symbol, notify],
  );

  // Re-run a visible report when new bars arrive from auto-refresh.
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    const r = reportRef.current;
    if (r && series && r.symbol === series.meta.symbol && r.timeframe === series.timeframe && series.candles[series.candles.length - 1].time !== r.lastTime) void analyse(true);
  }, [series, analyse]);

  // ---- auto refresh of chart and quotes
  useEffect(() => {
    // MT4 files are local and cheap to re-read, so every MT4 timeframe follows the live bar.
    if (!settings || settings.refreshSeconds <= 0 || symbol?.provider === 'csv' || (!INTRADAY.includes(timeframe) && symbol?.provider !== 'mt4')) return;
    // MT4's live feed is local, so poll it every few seconds.
    const secs = symbol?.provider === 'mt4' ? Math.min(5, settings.refreshSeconds) : settings.refreshSeconds;
    const t = setInterval(() => void loadSeries(true), secs * 1000);
    return () => clearInterval(t);
  }, [settings, timeframe, symbol, loadSeries]);

  const allWatch = useMemo<WatchItem[]>(() => {
    if (!settings) return [];
    const m = new Map<string, WatchItem>();
    for (const w of [...settings.tickerTape, ...settings.usWatchlist, ...settings.indiaWatchlist]) m.set(`${w.provider}:${w.symbol}`, w);
    return [...m.values()];
  }, [settings]);

  const refreshQuotes = useCallback(async () => {
    if (!allWatch.length) return;
    try {
      const q = await window.trendlens.getQuotes(allWatch);
      setQuotes((prev) => {
        const next = new Map(prev);
        for (const x of q) next.set(x.symbol.toUpperCase(), x);
        return next;
      });
      setQuotesAt(Date.now());
    } catch {
      /* quotes are best effort */
    }
  }, [allWatch]);

  useEffect(() => {
    void refreshQuotes();
    const secs = Math.max(15, settings?.refreshSeconds || 60);
    const t = setInterval(() => void refreshQuotes(), secs * 1000);
    return () => clearInterval(t);
  }, [refreshQuotes, settings?.refreshSeconds]);

  // ---- actions
  const openSymbol = useCallback((s: SymbolInfo) => {
    setSymbol(s);
    setView('analyzer');
  }, []);

  const importCsv = useCallback(async () => {
    try {
      const s = await window.trendlens.importCsv();
      if (!s) return;
      setCsvSeries(s);
      setTimeframe(s.timeframe);
      setSymbol({ symbol: s.meta.symbol, name: s.meta.name ?? s.meta.symbol, exchange: 'CSV', assetClass: 'other', provider: 'csv' });
      setView('analyzer');
      notify(`Imported ${s.candles.length} bars (${s.timeframe}).`);
    } catch (e) {
      notify(cleanError(e), true);
    }
  }, [notify]);

  const exportReport = useCallback(async () => {
    if (!report) return notify('Run an analysis first, then export it.', true);
    const p = await window.trendlens.saveText(`${report.symbol.replace(/[^A-Za-z0-9.-]/g, '')}-${report.timeframe}.md`, reportToMarkdown(report));
    if (p) notify(`Saved to ${p}`);
  }, [report, notify]);

  const saveReport = useCallback(async () => {
    if (!report) return;
    await window.trendlens.saveHistory({ id: `${report.symbol}-${report.timeframe}-${report.generatedAt}`, savedAt: Date.now(), report, provider: symbol?.provider });
    notify('Report saved to History.');
  }, [report, symbol, notify]);

  const toggleFavorite = useCallback(async () => {
    if (!settings || !symbol || symbol.provider === 'csv') return;
    const exists = settings.favorites.some((f) => f.symbol === symbol.symbol && f.provider === symbol.provider);
    const favorites = exists ? settings.favorites.filter((f) => !(f.symbol === symbol.symbol && f.provider === symbol.provider)) : [symbol, ...settings.favorites].slice(0, 30);
    setSettings(await window.trendlens.saveSettings({ favorites }));
  }, [settings, symbol]);

  const updateDisplay = useCallback(
    async (patch: Partial<Settings>) => {
      if (!settings) return;
      setSettings({ ...settings, ...patch });
      await window.trendlens.saveSettings(patch);
    },
    [settings],
  );

  // ---- menu + keyboard
  const handlers = useRef<Record<string, () => void>>({});
  handlers.current = {
    'import-csv': () => void importCsv(),
    'export-report': () => void exportReport(),
    settings: () => setDialog('settings'),
    help: () => setDialog('help'),
    'view:analyzer': () => setView('analyzer'),
    'view:markets': () => setView('markets'),
    'view:upload': () => setView('upload'),
    'view:history': () => setView('history'),
    search: () => {
      setView('analyzer');
      setTimeout(() => searchRef.current?.focus(), 0);
    },
    analyse: () => {
      setView('analyzer');
      void analyse();
    },
  };
  useEffect(() => window.trendlens.onMenu((a) => handlers.current[a]?.()), []);

  if (!settings) return <div className="empty">Starting TrendLens…</div>;

  const last = series?.candles[series.candles.length - 1];
  const prev = series?.candles[series.candles.length - 2];
  const chg = last && prev ? ((last.close - prev.close) / prev.close) * 100 : undefined;
  const dayQuote = symbol ? quotes.get(symbol.symbol.toUpperCase()) : undefined;
  // MT4 charts refresh every few seconds, faster than quotes, so their last bar is the freshest price.
  const headPrice = symbol?.provider === 'mt4' && last ? last.close : (dayQuote?.price ?? last?.close);
  const headPct =
    dayQuote && Number.isFinite(dayQuote.previousClose) && dayQuote.previousClose !== 0 && headPrice !== undefined
      ? ((headPrice - dayQuote.previousClose) / dayQuote.previousClose) * 100
      : chg;
  const isFav = !!symbol && settings.favorites.some((f) => f.symbol === symbol.symbol && f.provider === symbol.provider);
  const ind = settings.indicators;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">T</div>
          TrendLens <small>market structure workstation</small>
        </div>
        <nav className="nav">
          {(
            [
              ['analyzer', 'Analyzer'],
              ['markets', 'Markets'],
              ['upload', 'AI Chart Review'],
              ['history', 'History'],
            ] as [View, string][]
          ).map(([id, label]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <SymbolSearch ref={searchRef} onSelect={openSymbol} favorites={settings.favorites} mt4Symbols={mt4Symbols} />
        <button className="icon-btn" title="Import CSV (Ctrl+O)" onClick={() => void importCsv()}>
          CSV
        </button>
        <button className="icon-btn" title="Help" onClick={() => setDialog('help')}>
          ?
        </button>
        <button className="icon-btn" title="Settings (Ctrl+,)" onClick={() => setDialog('settings')}>
          ⚙
        </button>
      </header>

      <TickerTape
        items={settings.tickerTape}
        quotes={quotes}
        onPick={(w) => openSymbol({ symbol: w.symbol, name: w.label ?? w.symbol, exchange: w.provider === 'mt4' ? 'MT4' : '', assetClass: w.provider === 'binance' ? 'crypto' : 'other', provider: w.provider })}
      />

      <main className="main">
        {view === 'analyzer' && (
          <div className="analyzer">
            <section className="chart-col">
              <div className="workflow">
                <span className="step">
                  <span className="step-num">01</span>
                  <span className="symbol-chip">
                    <b>
                      {symbol?.symbol ?? '—'}{' '}
                      {symbol && symbol.provider !== 'csv' && (
                        <span style={{ cursor: 'pointer', color: isFav ? 'var(--warn)' : 'var(--faint)' }} title={isFav ? 'Remove favourite' : 'Add to favourites'} onClick={() => void toggleFavorite()}>
                          {isFav ? '★' : '☆'}
                        </span>
                      )}
                    </b>
                    <span>{series?.meta.name ?? symbol?.name}{series?.meta.exchange ? ` · ${series.meta.exchange}` : ''}{series?.meta.currency ? ` · ${series.meta.currency}` : ''}</span>
                  </span>
                </span>
                {last && (
                  <span className="step" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
                    <span className="price">{formatPrice(headPrice)}</span>
                    <span className={`chg ${(headPct ?? 0) >= 0 ? 'up' : 'down'}`}>{dayQuote && Number.isFinite(dayQuote.previousClose) ? `${formatPct(headPct)} today` : `${formatPct(headPct)} last bar`}</span>
                  </span>
                )}
                <span className="step-arrow">→</span>
                <span className="step">
                  <span className="step-num">02</span>
                  <div className="tf-group">
                    {TIMEFRAMES.map((t) => (
                      <button key={t.id} className={timeframe === t.id ? 'active' : ''} onClick={() => setTimeframe(t.id)} disabled={symbol?.provider === 'csv'} title={t.label}>
                        {t.id}
                      </button>
                    ))}
                  </div>
                </span>
                <span className="step-arrow">→</span>
                <span className="step">
                  <span className="step-num">03</span>
                  <button className="btn btn-primary" disabled={!series || loading || (stage >= 0 && stage < STAGES.length)} onClick={() => void analyse()} title="Analyse (F5)">
                    {stage >= 0 && stage < STAGES.length ? (
                      <>
                        <span className="spinner" /> Scanning…
                      </>
                    ) : (
                      'Analyse'
                    )}
                  </button>
                </span>
              </div>
              <div className="toolbar">
                {(
                  [
                    ['ema20', 'EMA 20'],
                    ['ema50', 'EMA 50'],
                    ['ema200', 'EMA 200'],
                    ['vwap', 'VWAP'],
                    ['bollinger', 'Bollinger'],
                    ['supertrend', 'Supertrend'],
                    ['volume', 'Volume'],
                    ['levels', 'Key levels'],
                    ['zones', 'OB / FVG zones'],
                    ['markers', 'Structure marks'],
                  ] as [keyof Settings['indicators'], string][]
                ).map(([k, label]) => (
                  <button key={k} className={`toggle ${ind[k] ? 'on' : ''}`} onClick={() => void updateDisplay({ indicators: { ...ind, [k]: !ind[k] } })}>
                    {label}
                  </button>
                ))}
                <span style={{ marginLeft: 8 }}>Lower pane</span>
                <select value={settings.lowerPane} onChange={(e) => void updateDisplay({ lowerPane: e.target.value as Settings['lowerPane'] })}>
                  <option value="rsi">RSI</option>
                  <option value="macd">MACD</option>
                  <option value="stochastic">Stochastic</option>
                  <option value="adx">ADX / DMI</option>
                  <option value="none">None</option>
                </select>
              </div>
              <ChartPanel series={series} report={report} indicators={ind} lowerPane={settings.lowerPane} theme={settings.theme} loading={loading} error={error} />
            </section>

            <aside className="side-col">
              {stage >= 0 && stage < STAGES.length && (
                <div className="report">
                  <div className="card">
                    <h4>Structured scan in progress</h4>
                    <div className="pipeline">
                      {STAGES.map((s, i) => (
                        <div key={s} className={`pipe ${i < stage ? 'done' : i === stage ? 'active' : ''}`}>
                          <b>0{i + 1}</b>
                          {s}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {report && stage === STAGES.length && (
                <>
                  <div style={{ display: 'flex', gap: 6, padding: '12px 14px 0' }}>
                    <button className="btn btn-sm" onClick={() => void saveReport()}>
                      Save
                    </button>
                    <button className="btn btn-sm" onClick={() => void exportReport()}>
                      Export
                    </button>
                    <button className="btn btn-sm" onClick={() => setView('upload')}>
                      AI review…
                    </button>
                  </div>
                  <ReportView report={report} />
                </>
              )}
              {stage === -1 && (
                <div className="empty">
                  <div style={{ fontSize: 28 }}>◎</div>
                  <h3>Upload. Review. Decide.</h3>
                  <p>
                    Search a symbol, pick a timeframe, then press <b>Analyse</b> (F5) for a structured review of market structure, momentum, liquidity and risk.
                  </p>
                  <div className="pipeline" style={{ marginTop: 16 }}>
                    {STAGES.map((s, i) => (
                      <div key={s} className="pipe">
                        <b>0{i + 1}</b>
                        {s}
                      </div>
                    ))}
                  </div>
                  <p className="disclaimer" style={{ marginTop: 18 }}>
                    Educational and informational output — not investment advice or buy/sell recommendations.
                  </p>
                </div>
              )}
            </aside>
          </div>
        )}
        {view === 'markets' && (
          <MarketsView us={settings.usWatchlist} india={settings.indiaWatchlist} global={settings.tickerTape} quotes={quotes} onOpen={openSymbol} lastUpdate={quotesAt} mt4Symbols={mt4Symbols} />
        )}
        {view === 'upload' && <UploadView hasApiKey={settings.hasApiKey} currentReport={report} onOpenSettings={() => setDialog('settings')} notify={notify} />}
        {view === 'history' && (
          <HistoryView
            notify={notify}
            onOpenSymbol={(e: HistoryEntry) => {
              const sym = e.report.symbol;
              if (e.provider === 'csv') return notify('CSV imports cannot be reopened automatically — import the file again.', true);
              setTimeframe(e.report.timeframe);
              openSymbol({ symbol: sym, name: e.report.name ?? sym, exchange: '', assetClass: 'other', provider: e.provider ?? (looksLikeBinancePair(sym) ? 'binance' : 'yahoo') });
            }}
          />
        )}
      </main>

      <footer className="statusbar">
        <span>
          {series
            ? `${series.candles.length} bars · ${PROVIDER_LABEL[series.meta.provider]}${series.meta.provider === 'mt4' && series.meta.exchange ? ` (${series.meta.exchange.replace(/^MT4 · /, '')})` : ''}${series.meta.timezone ? ` · ${series.meta.timezone}` : ''}${series.meta.sourcePeriod ? ` · built from ${series.meta.sourcePeriod} bars` : ''}`
            : 'No data'}
        </span>
        {series?.meta.provider === 'mt4' &&
          (series.meta.timezone?.includes('live') ? (
            <span className="live-ok" title="Live bars from MetaTrader 4 via the MarketDataExporter EA">
              <span className="live-dot" />
              MT4 live
            </span>
          ) : (
            series.meta.updatedAt && (
              <span className={now - series.meta.updatedAt > 15 * 60_000 ? 'warn' : ''} title="When MetaTrader 4 data for this chart was last written">
                MT4 data updated {ago(now - series.meta.updatedAt)}
                {now - series.meta.updatedAt > 15 * 60_000 ? ' — run MT4 with the TrendLensFeed EA attached for live bars (Settings → Install MT4 live feed)' : ''}
              </span>
            )
          ))}
        {error && <span className="err">{error}</span>}
        <span className="spacer" />
        <span>
          {settings.refreshSeconds <= 0 ? 'Auto refresh off' : `Auto refresh ${symbol?.provider === 'mt4' ? Math.min(5, settings.refreshSeconds) : settings.refreshSeconds}s`}
        </span>
        <span>Educational use only · not investment advice</span>
      </footer>

      {dialog === 'settings' && <SettingsDialog settings={settings} onClose={() => setDialog(null)} onSaved={setSettings} />}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      {toast && <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}
