import { useEffect, useState } from 'react';
import { TIMEFRAMES, type Timeframe } from '@core/types';
import { formatWatchlist, parseWatchlist } from '@core/watchlist';
import type { Mt4Status, Settings, WatchItem } from '../../../shared/api';

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        {children}
      </div>
    </div>
  );
}

const toText = (items: WatchItem[]) => formatWatchlist(items);
const fromText = (text: string): WatchItem[] => parseWatchlist(text);

export function SettingsDialog({ settings, onClose, onSaved }: { settings: Settings; onClose: () => void; onSaved: (s: Settings) => void }) {
  const [theme, setTheme] = useState(settings.theme);
  const [tf, setTf] = useState<Timeframe>(settings.defaultTimeframe);
  const [refresh, setRefresh] = useState(settings.refreshSeconds);
  const [model, setModel] = useState(settings.aiModel);
  const [key, setKey] = useState('');
  const [tape, setTape] = useState(toText(settings.tickerTape));
  const [us, setUs] = useState(toText(settings.usWatchlist));
  const [india, setIndia] = useState(toText(settings.indiaWatchlist));
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<Settings['dataSource']>(settings.dataSource);
  const [mt4, setMt4] = useState<Mt4Status | null>(null);
  const [folder, setFolder] = useState(settings.mt4Folder);

  useEffect(() => {
    void window.trendlens.mt4Status().then(setMt4);
  }, [folder]);

  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const installFeed = async () => {
    setInstalling(true);
    try {
      const res = await window.trendlens.installMt4Feed();
      const ok = res.filter((r) => r.ok);
      const bad = res.filter((r) => !r.ok);
      setInstallMsg({
        ok: bad.length === 0 && ok.length > 0,
        text: ok.length
          ? `TrendLensFeed copied into ${ok.length} MT4 folder(s). Now refresh Expert Advisors in MT4 and attach it to a chart.${bad.length ? ` Failed: ${bad.map((b) => b.error).join('; ')}` : ''}`
          : `Nothing installed: ${bad.map((b) => b.error).join('; ') || 'no MT4 data folder found'}`,
      });
      setMt4(await window.trendlens.mt4Status());
    } finally {
      setInstalling(false);
    }
  };

  const pickFolder = async () => {
    const s = await window.trendlens.pickMt4Folder();
    setFolder(s.mt4Folder);
    onSaved(s);
  };

  const save = async () => {
    try {
      let s = await window.trendlens.saveSettings({
        dataSource: source,
        theme,
        defaultTimeframe: tf,
        refreshSeconds: Math.max(0, Math.min(600, Number(refresh) || 0)),
        aiModel: model.trim() || 'claude-opus-5-5',
        tickerTape: fromText(tape),
        usWatchlist: fromText(us),
        indiaWatchlist: fromText(india),
      });
      if (key.trim()) s = await window.trendlens.setApiKey(key.trim());
      onSaved(s);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const clearKey = async () => onSaved(await window.trendlens.setApiKey(null));

  return (
    <Modal onClose={onClose}>
      <h2>Settings</h2>
      <h3>Chart data source</h3>
      <div className="field">
        <label>Primary source</label>
        <select className="input" value={source} onChange={(e) => setSource(e.target.value as Settings['dataSource'])}>
          <option value="mt4">MetaTrader 4 (local history)</option>
          <option value="online">Online (Yahoo Finance / Binance)</option>
        </select>
      </div>
      <div className="field">
        <label>MetaTrader 4</label>
        <div>
          {mt4 === null ? (
            <span className="spinner" />
          ) : mt4.available ? (
            <span className="tone-bull">
              Found {mt4.symbols} symbols · {mt4.terminals.flatMap((t) => t.servers).join(', ')}
            </span>
          ) : (
            <span className="tone-warn">No MT4 history found</span>
          )}
          {mt4 && (
            <div style={{ fontSize: 12, marginTop: 4 }} className={mt4.liveFeed ? 'tone-bull' : 'tone-warn'}>
              {mt4.liveFeed ? `● Live feed (${mt4.liveFeeds.join(', ')}): ${mt4.liveSymbols.join(', ')}` : 'Live feed off — attach TrendLensFeed to a chart in MT4 for live bars'}
            </div>
          )}
          {mt4?.terminals.map((t) => (
            <div key={t.dataDir} style={{ color: 'var(--faint)', fontSize: 11.5, wordBreak: 'break-all' }}>
              {t.installDir ? `${t.installDir} → ` : ''}
              {t.dataDir}
              <span className={t.feedInstalled ? 'tone-bull' : 'tone-warn'} style={{ marginLeft: 6 }}>
                {t.feedInstalled ? '· TrendLensFeed installed' : '· feed not installed'}
              </span>
              {t.feedInstalled && (
                <button className="btn btn-sm" style={{ marginLeft: 6, padding: '0 6px' }} onClick={() => void window.trendlens.openMt4Experts(t.dataDir)}>
                  Open Experts folder
                </button>
              )}
            </div>
          ))}
          <button className="btn btn-sm" style={{ marginTop: 6, marginRight: 6 }} disabled={!mt4?.terminals.length || installing} onClick={() => void installFeed()}>
            {installing ? <span className="spinner" /> : 'Install MT4 live feed'}
          </button>
          <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => void pickFolder()}>
            {folder ? 'Change extra MT4 folder…' : 'Add MT4 data folder…'}
          </button>
          {folder && <div style={{ color: 'var(--faint)', fontSize: 11.5, wordBreak: 'break-all' }}>Extra folder: {folder}</div>}
        </div>
      </div>
      {installMsg && <div className={installMsg.ok ? 'tone-bull' : 'tone-bear'} style={{ fontSize: 12, margin: '6px 0' }}>{installMsg.text}</div>}
      <div className="card" style={{ fontSize: 12, margin: '8px 0', padding: '8px 12px' }}>
        <b>Live feed setup (once per MT4):</b>
        <ol style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Click <b>Install MT4 live feed</b> above (copies the TrendLensFeed EA into MT4's Experts folder).</li>
          <li>In MT4's Navigator, right-click <b>Expert Advisors → Refresh</b>.</li>
          <li>Drag <b>TrendLensFeed</b> onto any chart and turn <b>AutoTrading</b> on. The EA has no trading code; MT4 just needs AutoTrading on to run any EA.</li>
          <li>Optional: in its inputs, list the symbols to stream (empty = that chart plus your Market Watch instruments).</li>
        </ol>
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 12 }}>
        TrendLens reads MT4's history files read-only. Keep MetaTrader 4 running with a chart of each symbol (and timeframe) open so its files stay current; missing timeframes are built
        from finer MT4 bars. Symbols MT4 does not carry use online data.
      </div>
      <h3>General</h3>
      <div className="field">
        <label>Theme</label>
        <select className="input" value={theme} onChange={(e) => setTheme(e.target.value as Settings['theme'])}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <div className="field">
        <label>Default timeframe</label>
        <select className="input" value={tf} onChange={(e) => setTf(e.target.value as Timeframe)}>
          {TIMEFRAMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Auto refresh (seconds)</label>
        <input className="input" type="number" min={0} max={600} value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} />
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 12 }}>0 turns auto refresh off. Intraday charts and quotes refresh at this interval; a loaded report is re-run on new bars.</div>

      <h3>Watchlists</h3>
      <div style={{ color: 'var(--faint)', fontSize: 12, marginBottom: 6 }}>
        Comma-separated symbols. Prefix MetaTrader 4 symbols with <code>MT4:</code> (e.g. <code>MT4:MCRUDEOIL</code>); others are Yahoo or Binance. Add a display label with{' '}
        <code>SYMBOL=Label</code>, e.g. <code>MT4:MNAG=MCX NATGAS</code>, <code>GC=F=GOLD</code>.
      </div>
      <div className="field">
        <label>Ticker tape</label>
        <textarea rows={3} value={tape} onChange={(e) => setTape(e.target.value)} />
      </div>
      <div className="field">
        <label>US / NASDAQ list</label>
        <textarea rows={2} value={us} onChange={(e) => setUs(e.target.value)} />
      </div>
      <div className="field">
        <label>Indian market list</label>
        <textarea rows={2} value={india} onChange={(e) => setIndia(e.target.value)} />
      </div>

      <h3>AI chart review (optional)</h3>
      <div className="field">
        <label>Anthropic API key</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" type="password" placeholder={settings.hasApiKey ? '•••••• saved (enter a new key to replace)' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} />
          {settings.hasApiKey && (
            <button className="btn btn-sm btn-danger" onClick={() => void clearKey()}>
              Remove
            </button>
          )}
        </div>
      </div>
      <div className="field">
        <label>Model</label>
        <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 12 }}>The key is encrypted with Windows DPAPI and only used by the app's background process to call the Anthropic API. Each review is billed to your API account.</div>
      {err && <div className="tone-bear" style={{ marginTop: 10 }}>{err}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h2>How TrendLens analysis works</h2>
      <p>
        TrendLens turns a chart into a repeatable review: <b>search a symbol → choose a timeframe → Analyse</b>. Every output is computed locally by deterministic rules from the OHLCV
        bars, so the same data always gives the same report.
      </p>
      <h3>Core outputs</h3>
      <ul>
        <li><b>Market condition</b> — from a weighted bias score (−100…+100): structure 26%, trend matrix 20%, momentum 16%, multi-timeframe 16%, smart money 10%, price behaviour 6%, liquidity 6%. Range conditions with a weak bias read as <i>Consolidating</i>.</li>
        <li><b>Confidence</b> — bias magnitude plus how many modules agree, minus penalties for extreme volatility, short history or missing volume.</li>
        <li><b>Strength index</b> — ADX, momentum magnitude, momentum expansion and relative volume.</li>
        <li><b>Risk environment</b> — counts caution flags: no-trade zone, late entry, counter-trend, extreme volatility, nearby opposing level, divergence, recent sweep/trap against the bias.</li>
      </ul>
      <h3>Modules</h3>
      <ul>
        <li><b>Market structure</b> — fractal swing points labelled HH/HL/LH/LL; a close beyond the last confirmed swing is a break of structure (BOS), or a change of character (CHoCH) when it reverses the trend.</li>
        <li><b>Market phase</b> — markup / markdown when trending; accumulation / distribution when a range follows a decline / advance.</li>
        <li><b>Trend strength matrix</b> — EMA 20/50/200 stack, price vs EMAs, ADX and DI spread, Supertrend, regression slope.</li>
        <li><b>Momentum</b> — RSI, MACD histogram, ROC, Stochastic, the momentum expansion tracker and RSI divergence.</li>
        <li><b>Volatility</b> — ATR and Bollinger-width percentiles over 100 bars, squeezes and regime.</li>
        <li><b>Liquidity participation</b> — relative volume, OBV, Chaikin money flow, MFI (needs real volume).</li>
        <li><b>Price behaviour</b> — clustered swing support/resistance, round-number levels, break-and-retest.</li>
        <li><b>Smart money</b> — liquidity sweeps, failed breakouts (traps), order blocks, fair-value gaps, equal highs/lows, high-volume bars, accumulation/distribution.</li>
        <li><b>Multi-timeframe alignment</b> — the same compact bias on two higher timeframes.</li>
      </ul>
      <h3>Data</h3>
      <p>
        Stocks, indices, forex and futures come from Yahoo Finance's public chart endpoints (unofficial, for personal use; some exchanges are delayed). Crypto pairs such as BTCUSDT come from
        Binance's public market-data API. You can also import any OHLCV CSV (File → Import CSV).
      </p>
      <p className="disclaimer">
        TrendLens is an independent personal tool inspired by publicly described chart-review workflows. Its outputs are educational and informational only — not investment advice, not
        guaranteed, and not buy/sell recommendations. You remain responsible for your decisions and risk.
      </p>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
