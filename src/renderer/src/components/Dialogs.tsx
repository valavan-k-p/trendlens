import { useEffect, useState } from 'react';
import { TIMEFRAMES, type Timeframe } from '@core/types';
import { AI_PROVIDER_IDS, AI_PROVIDERS, detectProvider, type AiProviderId, type AiProviderSetting } from '@core/ai/providers';
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
  const [key, setKey] = useState('');
  const [aiChoice, setAiChoice] = useState<AiProviderSetting>(settings.hasApiKey || settings.savedKeys.length ? settings.aiProvider : 'auto');
  const [aiModels, setAiModels] = useState(settings.aiModels);
  const [fallback, setFallback] = useState<AiProviderId[]>(settings.aiFallback ?? []);
  const [fbKeys, setFbKeys] = useState<Partial<Record<AiProviderId, string>>>({});
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl ?? '');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const detected = key.trim() ? detectProvider(key) : undefined;
  const aiProvider: AiProviderId = aiChoice === 'auto' ? (detected ?? settings.aiProvider) : aiChoice;
  const aiInfo = AI_PROVIDERS[aiProvider];
  const keySaved = settings.savedKeys.includes(aiProvider);
  useEffect(() => {
    setModelOptions([]);
    setTestMsg(null);
  }, [aiProvider]);

  const testKey = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await window.trendlens.testAi({ provider: aiProvider, key: key.trim() || undefined, baseUrl: baseUrl.trim() || undefined });
      setModelOptions(r.models);
      setTestMsg(r.ok ? { ok: true, text: `Key works with ${aiInfo.name}${r.models.length ? ` · ${r.models.length} models available (pick one in the Model box)` : ''}.` } : { ok: false, text: r.error ?? 'Test failed.' });
    } finally {
      setTesting(false);
    }
  };
  const [tape, setTape] = useState(toText(settings.tickerTape));
  const [us, setUs] = useState(toText(settings.usWatchlist));
  const [india, setIndia] = useState(toText(settings.indiaWatchlist));
  const [err, setErr] = useState<string | null>(null);
  const [optProvider, setOptProvider] = useState(settings.optionProvider);
  const [upstoxToken, setUpstoxToken] = useState('');
  const [dhanClient, setDhanClient] = useState('');
  const [dhanToken, setDhanToken] = useState('');
  const [rate, setRate] = useState(String(settings.optionRiskFreeRate));
  const [divYield, setDivYield] = useState(String(settings.optionDividendYield));
  const [snapSec, setSnapSec] = useState(settings.optionSnapshotSeconds);
  const [optTest, setOptTest] = useState<{ provider: string; ok: boolean; text: string } | null>(null);
  const [optTesting, setOptTesting] = useState(false);
  const saveOptionCreds = async () => {
    let s: Settings | undefined;
    if (upstoxToken.trim()) s = await window.trendlens.setOptionCredentials({ provider: 'upstox', token: upstoxToken.trim() });
    if (dhanClient.trim() || dhanToken.trim())
      s = await window.trendlens.setOptionCredentials({ provider: 'dhan', clientId: dhanClient.trim() || undefined, token: dhanToken.trim() || undefined });
    return s;
  };
  const testOptions = async (provider: 'upstox' | 'dhan') => {
    setOptTesting(true);
    setOptTest(null);
    try {
      const s = await saveOptionCreds();
      if (s) onSaved(s);
      setUpstoxToken('');
      setDhanClient('');
      setDhanToken('');
      const r = await window.trendlens.testOptionProvider(provider);
      setOptTest({ provider, ok: r.ok, text: r.message });
    } catch (e) {
      setOptTest({ provider, ok: false, text: (e as Error).message });
    } finally {
      setOptTesting(false);
    }
  };
  const removeOption = async (provider: 'upstox' | 'dhan') =>
    onSaved(await window.trendlens.setOptionCredentials(provider === 'upstox' ? { provider, token: null } : { provider, token: null, clientId: null }));
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
      if (aiChoice === 'auto' && key.trim() && !detected) throw new Error('TrendLens could not tell which service this API key is for. Choose the provider from the list.');
      let s = await window.trendlens.saveSettings({
        dataSource: source,
        theme,
        defaultTimeframe: tf,
        refreshSeconds: Math.max(0, Math.min(600, Number(refresh) || 0)),
        aiProvider,
        aiModels: Object.fromEntries(Object.entries(aiModels).map(([p, m]) => [p, (m ?? '').trim()]).filter(([, m]) => m)),
        aiBaseUrl: baseUrl.trim() || undefined,
        aiFallback: fallback.filter((p) => p !== aiProvider),
        optionProvider: optProvider,
        optionRiskFreeRate: Number.isFinite(Number(rate)) ? Math.max(0, Math.min(25, Number(rate))) : settings.optionRiskFreeRate,
        optionDividendYield: Number.isFinite(Number(divYield)) ? Math.max(0, Math.min(15, Number(divYield))) : settings.optionDividendYield,
        optionSnapshotSeconds: snapSec,
        tickerTape: fromText(tape),
        usWatchlist: fromText(us),
        indiaWatchlist: fromText(india),
      });
      if (key.trim()) s = await window.trendlens.setApiKey(aiProvider, key.trim());
      for (const [p, k] of Object.entries(fbKeys)) if (k?.trim() && p !== aiProvider) s = await window.trendlens.setApiKey(p as AiProviderId, k.trim());
      s = (await saveOptionCreds()) ?? s;
      onSaved(s);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const clearKey = async () => onSaved(await window.trendlens.setApiKey(aiProvider, null));

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

      <h3>Option chain data</h3>
      <div className="field">
        <label>NSE / BSE provider</label>
        <select className="input" value={optProvider} onChange={(e) => setOptProvider(e.target.value as 'upstox' | 'dhan')}>
          <option value="upstox">Upstox (free Analytics Token)</option>
          <option value="dhan">Dhan (Data API subscription)</option>
        </select>
      </div>
      <div className="field">
        <label>Upstox Analytics Token</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" type="password" placeholder={settings.optionKeys.upstox ? '•••••• saved (paste a new token to replace)' : 'paste the token'} value={upstoxToken} onChange={(e) => setUpstoxToken(e.target.value)} />
          <button className="btn btn-sm" disabled={optTesting || (!upstoxToken.trim() && !settings.optionKeys.upstox)} onClick={() => void testOptions('upstox')}>
            Test
          </button>
          {settings.optionKeys.upstox && (
            <button className="btn btn-sm btn-danger" onClick={() => void removeOption('upstox')}>
              Remove
            </button>
          )}
        </div>
      </div>
      <div className="field">
        <label>Dhan client id</label>
        <input className="input" type="password" placeholder={settings.optionKeys.dhan ? '•••••• saved' : 'e.g. 1000000001'} value={dhanClient} onChange={(e) => setDhanClient(e.target.value)} />
      </div>
      <div className="field">
        <label>Dhan access token</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" type="password" placeholder={settings.optionKeys.dhan ? '•••••• saved (expires every 24 h)' : 'paste the access token'} value={dhanToken} onChange={(e) => setDhanToken(e.target.value)} />
          <button className="btn btn-sm" disabled={optTesting || ((!dhanToken.trim() || !dhanClient.trim()) && !settings.optionKeys.dhan)} onClick={() => void testOptions('dhan')}>
            Test
          </button>
          {settings.optionKeys.dhan && (
            <button className="btn btn-sm btn-danger" onClick={() => void removeOption('dhan')}>
              Remove
            </button>
          )}
        </div>
      </div>
      {optTest && <div className={optTest.ok ? 'tone-bull' : 'tone-bear'} style={{ fontSize: 12, marginBottom: 6 }}>{optTest.text}</div>}
      <div className="field">
        <label>Risk-free rate (%)</label>
        <input className="input" value={rate} onChange={(e) => setRate(e.target.value)} />
      </div>
      <div className="field">
        <label>Dividend yield (%)</label>
        <input className="input" value={divYield} onChange={(e) => setDivYield(e.target.value)} />
      </div>
      <div className="field">
        <label>Save snapshots</label>
        <select className="input" value={snapSec} onChange={(e) => setSnapSec(Number(e.target.value))}>
          <option value={0}>Off</option>
          <option value={60}>Every minute</option>
          <option value={300}>Every 5 minutes</option>
          <option value={900}>Every 15 minutes</option>
        </select>
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 12 }}>
        Upstox: Developer Apps → Analytics → Generate Token (free, read-only, valid one year; NSE and BSE). Dhan: needs the Data API plan; tokens last 24 hours; also serves MCX option chains, which
        Upstox does not offer. Credentials are encrypted with Windows DPAPI and used only by the app's background process. The rate is used for calculated Greeks; the dividend yield only when put-call parity
        cannot be measured.{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), void window.trendlens.openExternal('https://upstox.com/developer/api-documentation/analytics-token/'))}>
          Upstox Analytics Token
        </a>{' '}
        ·{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), void window.trendlens.openExternal('https://dhanhq.co/docs/v2/'))}>
          Dhan API docs
        </a>
      </div>

      <h3>AI: signal and assistant (optional)</h3>
      <div className="field">
        <label>AI provider</label>
        <select className="input" value={aiChoice} onChange={(e) => setAiChoice(e.target.value as AiProviderSetting)}>
          <option value="auto">Auto-detect from the key{aiChoice === 'auto' && key.trim() ? (detected ? ` → ${AI_PROVIDERS[detected].label}` : ' (not recognised)') : ''}</option>
          {AI_PROVIDER_IDS.map((p) => (
            <option key={p} value={p}>
              {AI_PROVIDERS[p].label}
              {settings.savedKeys.includes(p) ? ' · key saved' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{aiChoice === 'auto' && !key.trim() ? 'API key' : `${aiInfo.name} API key`}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input"
            type="password"
            placeholder={keySaved ? '•••••• saved (enter a new key to replace)' : aiChoice === 'auto' ? 'Paste any supported API key' : aiInfo.keyHint}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn btn-sm" disabled={testing || (!key.trim() && !keySaved && !aiInfo.keyOptional)} onClick={() => void testKey()}>
            {testing ? <span className="spinner" /> : 'Test'}
          </button>
          {keySaved && (
            <button className="btn btn-sm btn-danger" onClick={() => void clearKey()}>
              Remove
            </button>
          )}
        </div>
        {aiChoice === 'auto' && key.trim() && !detected && <div className="tone-warn" style={{ marginTop: 4, fontSize: 12 }}>Key format not recognised — choose the provider from the list above.</div>}
      </div>
      {aiProvider === 'custom' && (
        <div className="field">
          <label>Server base URL</label>
          <input className="input" placeholder="http://localhost:11434/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label>Model</label>
        <input
          className="input"
          list="ai-models"
          placeholder={aiInfo.defaultModel ? `${aiInfo.defaultModel} (default)` : 'model name, e.g. llava or qwen2.5vl'}
          value={aiModels[aiProvider] ?? ''}
          onChange={(e) => setAiModels({ ...aiModels, [aiProvider]: e.target.value })}
        />
        <datalist id="ai-models">
          {modelOptions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      {testMsg && <div className={testMsg.ok ? 'tone-bull' : 'tone-bear'} style={{ fontSize: 12, marginBottom: 6 }}>{testMsg.text}</div>}
      <div style={{ color: 'var(--faint)', fontSize: 12 }}>
        Keys are encrypted with Windows DPAPI and only used by the app's background process. The chart image is sent only to the provider you choose, and any
        usage is billed to that account. {aiInfo.note ?? ''} The model must accept images.{' '}
        {aiInfo.keysUrl && (
          <a href="#" onClick={(e) => (e.preventDefault(), void window.trendlens.openExternal(aiInfo.keysUrl!))}>
            Get a {aiInfo.name} key
          </a>
        )}
      </div>
      <div className="field" style={{ alignItems: 'start' }}>
        <label>
          Fallback AIs
          <div style={{ color: 'var(--faint)', fontSize: 11, marginTop: 4 }}>tried in order when the main AI fails</div>
        </label>
        <div className="fb-list">
          {[...fallback.filter((p) => p !== aiProvider), ...AI_PROVIDER_IDS.filter((p) => p !== aiProvider && !fallback.includes(p))].map((p) => {
            const on = fallback.includes(p) && p !== aiProvider;
            const info = AI_PROVIDERS[p];
            const saved = settings.savedKeys.includes(p);
            const idx = fallback.indexOf(p);
            const move = (d: number) => {
              const f = fallback.filter((x) => x !== aiProvider);
              const i = f.indexOf(p);
              const j = i + d;
              if (i < 0 || j < 0 || j >= f.length) return;
              [f[i], f[j]] = [f[j], f[i]];
              setFallback(f);
            };
            return (
              <div key={p} className={`fb-row ${on ? 'on' : ''}`}>
                <label className="fb-name">
                  <input type="checkbox" checked={on} onChange={(e) => setFallback(e.target.checked ? [...fallback.filter((x) => x !== p), p] : fallback.filter((x) => x !== p))} />
                  {on ? `${idx + 1}. ` : ''}
                  {info.name}
                </label>
                {p === 'custom' ? (
                  <span className="fb-hint">uses the base URL above</span>
                ) : (
                  <input
                    className="input"
                    type="password"
                    placeholder={saved ? 'key saved ✓' : info.keyHint}
                    value={fbKeys[p] ?? ''}
                    onChange={(e) => setFbKeys({ ...fbKeys, [p]: e.target.value })}
                  />
                )}
                <input className="input" placeholder={info.defaultModel || 'model'} value={aiModels[p] ?? ''} onChange={(e) => setAiModels({ ...aiModels, [p]: e.target.value })} />
                {on && (
                  <span className="fb-move">
                    <button className="btn btn-sm" onClick={() => move(-1)} title="Try earlier">
                      ↑
                    </button>
                    <button className="btn btn-sm" onClick={() => move(1)} title="Try later">
                      ↓
                    </button>
                  </span>
                )}
                {on && !saved && !fbKeys[p]?.trim() && p !== 'custom' && <span className="fb-warn">needs a key</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 12 }}>
        If the main AI runs out of quota, is busy, rejects its key or cannot be reached, TrendLens asks the next ticked AI and notes which one answered. Free keys:{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), void window.trendlens.openExternal('https://console.groq.com/keys'))}>
          Groq
        </a>{' '}
        (about 1,000 requests a day) ·{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), void window.trendlens.openExternal('https://openrouter.ai/settings/keys'))}>
          OpenRouter
        </a>{' '}
        (":free" models, about 50 requests a day each) ·{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), void window.trendlens.openExternal('https://aistudio.google.com/apikey'))}>
          Gemini
        </a>
        . Text-only models skip the chart image automatically.
      </div>
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
