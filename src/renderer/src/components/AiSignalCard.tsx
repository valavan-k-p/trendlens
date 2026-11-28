/**
 * Analyzer → AI review: one compact AI trade decision from the analysis, the chart screenshot and
 * live option prices. Shows only the option, entry, target and stop-loss, a no-entry alert, or
 * HOLD / EXIT for a trade the user took.
 */
import { useEffect, useState } from 'react';
import type { AnalysisReport } from '@core/analysis/types';
import { sessionText, signalContext, type OpenTrade, type OptionsContext, type TradeSignal } from '@core/ai/trading';
import { analyzeGreeks, legPrice } from '@core/options/iv-analysis';
import { summarizeChain } from '@core/options/option-analytics';
import { daysToExpiry } from '@core/options/option-contracts';
import { exchangeOf } from '@core/options/providers/mt4';
import type { OptionChain, OptionExchange } from '@core/options/types';
import type { Candle } from '@core/types';
import type { AiSignalResult, Settings } from '../../../shared/api';
import { callUsageText, UsageSummaryBar, useUsage } from './AiUsage';

const IMG_PREF = 'trendlens.ai.chartImage';
const NEWS_PREF = 'trendlens.ai.news';
const NSE_INDEX = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']);

/** The Indian exchange whose session applies to a symbol, or undefined (forex, crypto, US…). */
export function marketOf(symbol: string): OptionExchange | undefined {
  const u = optionUnderlying(symbol);
  const ex = exchangeOf(u);
  if (ex !== 'NSE') return ex;
  if (NSE_INDEX.has(u) || /\.NS$/i.test(symbol) || /#$/.test(symbol)) return 'NSE';
  if (/\.BO$/i.test(symbol)) return 'BSE';
  return undefined;
}
const tradeKey = (symbol: string) => `trendlens.openTrade.${symbol}`;
const cleanError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** MT4 / exchange symbol → the option underlying name ("NIFTY#" → NIFTY, "MCRO" → CRUDEOIL). */
export function optionUnderlying(symbol: string): string {
  const s = symbol.toUpperCase().replace(/#$/, '').replace(/[-_ ]?FUT$/, '');
  const alias: Record<string, string> = {
    NIFTY50: 'NIFTY',
    '^NSEI': 'NIFTY',
    '^NSEBANK': 'BANKNIFTY',
    BSE_SENSEX: 'SENSEX',
    '^BSESN': 'SENSEX',
    MCRO: 'CRUDEOIL',
    MCRUDEOIL: 'CRUDEOIL',
    CRUDEOILM: 'CRUDEOIL',
    MNAG: 'NATURALGAS',
    BANKNIFTYN: 'BANKNIFTY',
    MGLD: 'GOLD',
    GLMM: 'GOLDM',
    MSLV: 'SILVER',
    MCOP: 'COPPER',
  };
  return alias[s] ?? s;
}

/** Live option prices near ATM for the symbol: MT4 first, then the broker API if it is set up. */
async function optionsContext(symbol: string, settings: Settings): Promise<OptionsContext | undefined> {
  const u = optionUnderlying(symbol);
  let chain: OptionChain | undefined;
  let source = '';
  try {
    const cat = await window.trendlens.mt4OptionCatalog();
    const series = cat.series.filter((s) => s.underlying === u && s.defaultExpiry).sort((a, b) => Number(b.weekly) - Number(a.weekly))[0];
    if (series && !cat.missing) {
      chain = (await window.trendlens.mt4OptionChain({ key: series.key, expiry: series.defaultExpiry! })).chain;
      source = 'MT4';
    }
  } catch {
    // No MT4 options for this symbol.
  }
  if (!chain) {
    try {
      const ex = exchangeOf(u);
      const cat = await window.trendlens.optionCatalog(ex);
      const und = cat.configured ? cat.underlyings.find((x) => x.symbol === u) : undefined;
      if (und) {
        chain = (await window.trendlens.optionChain({ exchange: ex, underlyingId: und.id, expiry: und.expiries[0] })).chain;
        source = cat.chainProvider === 'upstox' ? 'Upstox' : 'Dhan';
      }
    } catch {
      // No broker option data either.
    }
  }
  if (!chain) return undefined;
  const g = analyzeGreeks(chain, { r: settings.optionRiskFreeRate / 100, qFallback: settings.optionDividendYield / 100, now: chain.fetchedAt });
  const s = summarizeChain(chain, chain.underlyingPrice ?? g.underlying);
  const i = chain.rows.findIndex((r) => r.strike === s.atm);
  if (i < 0) return undefined;
  const byStrike = new Map(g.rows.map((r) => [r.strike, r]));
  const rows = chain.rows.slice(Math.max(0, i - 3), i + 4).map((r) => {
    const gr = byStrike.get(r.strike);
    const leg = (side: 'call' | 'put') => {
      const q = r[side];
      const gl = gr?.[side];
      return q ? { ltp: q.ltp ?? legPrice(q)?.price, iv: gl?.iv?.value, delta: gl?.delta?.value } : undefined;
    };
    return { strike: r.strike, ce: leg('call'), pe: leg('put') };
  });
  return { underlying: u, expiry: chain.expiry, daysToExpiry: daysToExpiry(chain.expiryTime, Date.now() / 1000), lotSize: chain.lotSize, spot: chain.underlyingPrice ?? g.underlying, rows, source };
}

/** Chart screenshot scaled to ≤ 1280 px wide, as JPEG base64 (keeps image tokens down). */
function chartImage(capture: (() => HTMLCanvasElement | null) | null): string | undefined {
  const src = capture?.();
  if (!src || !src.width) return undefined;
  const scale = Math.min(1, 1280 / src.width);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
}

const ACTION: Record<TradeSignal['action'], { title: string; tone: string }> = {
  BUY_CE: { title: 'BUY CALL (CE)', tone: 'bull' },
  BUY_PE: { title: 'BUY PUT (PE)', tone: 'bear' },
  NO_TRADE: { title: 'NO ENTRY — wait', tone: 'warn' },
  HOLD: { title: 'HOLD — let the profit run', tone: 'bull' },
  EXIT: { title: 'EXIT NOW', tone: 'bear' },
};

export function AiSignalCard({
  report,
  candles,
  settings,
  capture,
  onOpenSettings,
}: {
  report: AnalysisReport;
  candles: Candle[];
  settings: Settings;
  capture: { current: (() => HTMLCanvasElement | null) | null };
  onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AiSignalResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [withImage, setWithImage] = useState(() => localStorage.getItem(IMG_PREF) !== '0');
  const [withNews, setWithNews] = useState(() => localStorage.getItem(NEWS_PREF) !== '0');
  const [open, setOpen] = useState<OpenTrade | null>(null);
  const [closedInfo, setClosedInfo] = useState<string | null>(null);
  const [calls, setCalls] = useState(0);
  const usage = useUsage(calls);
  const market = marketOf(report.symbol);

  useEffect(() => localStorage.setItem(IMG_PREF, withImage ? '1' : '0'), [withImage]);
  useEffect(() => localStorage.setItem(NEWS_PREF, withNews ? '1' : '0'), [withNews]);
  useEffect(() => {
    try {
      setOpen(JSON.parse(localStorage.getItem(tradeKey(report.symbol)) ?? 'null'));
    } catch {
      setOpen(null);
    }
    setRes(null);
    setErr(null);
    setClosedInfo(null);
  }, [report.symbol]);

  const saveOpen = (t: OpenTrade | null) => {
    setOpen(t);
    if (t) localStorage.setItem(tradeKey(report.symbol), JSON.stringify(t));
    else localStorage.removeItem(tradeKey(report.symbol));
  };

  /** `planForOpen` asks for a conditional plan while the market is closed. */
  const run = async (planForOpen = false) => {
    setErr(null);
    setRes(null);
    setClosedInfo(null);
    const session = market ? sessionText(market, Date.now() / 1000) : undefined;
    // Market closed: no live signal (and no tokens spent) unless a plan for the next open is asked for.
    if (session && !session.open && !planForOpen) {
      setClosedInfo(session.text);
      return;
    }
    setBusy(true);
    try {
      const options = await optionsContext(report.symbol, settings);
      const context = signalContext({ report, candles, options, openTrade: open ?? undefined, session: session?.text });
      const imageBase64 = withImage ? chartImage(capture.current) : undefined;
      const r = await window.trendlens.aiSignal({ context, imageBase64, mediaType: imageBase64 ? 'image/jpeg' : undefined, news: withNews, symbol: report.symbol });
      setRes(r);
      const s = r.signal;
      // HOLD may trail the stop-loss / move the target: keep the open trade up to date.
      if (s?.action === 'HOLD' && open) saveOpen({ ...open, stopLoss: s.stopLoss || open.stopLoss, target: s.target || open.target });
      if (s && document.hidden && 'Notification' in window)
        new Notification(`TrendLens AI · ${report.symbol}`, { body: `${ACTION[s.action].title}${s.option ? ` ${s.option}` : ''}${s.entry ? ` @ ${s.entry}` : ''}${s.note ? ` — ${s.note}` : ''}` });
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
      setCalls((c) => c + 1);
    }
  };

  const s = res?.signal;
  const a = s ? ACTION[s.action] : undefined;
  return (
    <div className="card ai-signal">
      <div className="ai-signal-head">
        <button className="btn btn-primary btn-sm" onClick={() => void run()} disabled={busy || !settings.hasApiKey}>
          {busy ? (
            <>
              <span className="spinner" /> Asking AI…
            </>
          ) : open ? (
            'AI: hold or exit?'
          ) : (
            'AI review…'
          )}
        </button>
        <label title="Send a screenshot of the chart with its indicators (about 560 extra tokens on Gemini)">
          <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} /> chart image
        </label>
        <label title="Add the latest free headlines (Google News RSS, Economic Times, Mint, Business Standard, RBI) for this instrument and its global drivers, so the AI weighs current news. Free with any key; adds about 400-600 input tokens.">
          <input type="checkbox" checked={withNews} onChange={(e) => setWithNews(e.target.checked)} /> news
        </label>
        {!settings.hasApiKey && (
          <button className="btn btn-sm" onClick={onOpenSettings}>
            Add AI key
          </button>
        )}
      </div>

      {open && (
        <div className="ai-open">
          <span>
            Open: <b>{open.option}</b> @ {open.entry}
            {open.stopLoss ? ` · SL ${open.stopLoss}` : ''}
            {open.target ? ` · T ${open.target}` : ''}
          </span>
          <button className="btn btn-sm" onClick={() => saveOpen(null)}>
            Closed
          </button>
        </div>
      )}

      {closedInfo && (
        <div className="ai-result ai-warn">
          <div className="ai-title">MARKET CLOSED</div>
          <div className="ai-note">{closedInfo}. No live signal, and no tokens used.</div>
          <button className="btn btn-sm" onClick={() => void run(true)} disabled={busy}>
            Plan for next open
          </button>
        </div>
      )}

      {err && <div className="tone-bear ai-err">{err}</div>}

      {res && !s && (
        <div className="ai-raw">
          <b className="tone-warn">Could not read a signal.</b> {res.raw}
        </div>
      )}

      {s && a && (
        <div className={`ai-result ai-${a.tone}`}>
          <div className="ai-title">{a.title}</div>
          {s.option && <div className="ai-opt">{s.option}</div>}
          <div className="ai-grid">
            {s.entry && (
              <>
                <span>Entry</span>
                <b>{s.entry}</b>
              </>
            )}
            {s.target && (
              <>
                <span>{s.action === 'HOLD' ? 'Next target' : 'Target / exit'}</span>
                <b className="tone-bull">{s.target}</b>
              </>
            )}
            {s.stopLoss && (
              <>
                <span>{s.action === 'HOLD' ? 'Trail SL' : 'Stop-loss'}</span>
                <b className="tone-bear">{s.stopLoss}</b>
              </>
            )}
          </div>
          {s.note && <div className="ai-note">{s.note}</div>}
          {s.news && <div className="ai-news">News: {s.news}</div>}
          {(s.action === 'BUY_CE' || s.action === 'BUY_PE') && !open && (
            <button className="btn btn-sm" onClick={() => saveOpen({ option: s.option ?? s.action, entry: s.entry ?? '', target: s.target, stopLoss: s.stopLoss, since: Date.now() / 1000 })}>
              I took this trade
            </button>
          )}
          {s.action === 'EXIT' && open && (
            <button className="btn btn-sm" onClick={() => saveOpen(null)}>
              Exited
            </button>
          )}
        </div>
      )}
      {res && (
        <div className="ai-meta">
          {res.provider} · {res.model} · {callUsageText(res.usage, res.tokens)}
          {res.note ? ` · ${res.note}` : ''} · your decision, not financial advice
        </div>
      )}
      <div className="ai-meta">
        <UsageSummaryBar summary={usage} compact />
      </div>
    </div>
  );
}
