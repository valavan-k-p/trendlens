import { useCallback, useEffect, useState } from 'react';
import type { AnalysisReport } from '@core/analysis/types';
import { MIN_BARS } from '@core/analysis/engine';
import { formatPct, formatPrice, formatQuoteDate, isStaleQuote, priceDecimals } from '@core/format';
import type { Quote, SymbolInfo } from '@core/types';
import type { WatchItem } from '../../../shared/api';
import { conditionTone, toneClass } from '../lib/report';
import { runAnalysis } from '../lib/runAnalysis';

function QuoteTable({ title, items, quotes, onOpen }: { title: string; items: WatchItem[]; quotes: Map<string, Quote>; onOpen: (w: WatchItem, name?: string) => void }) {
  return (
    <div className="card">
      <h4>
        <span>
          <span className="live-dot" />
          {title}
        </span>
        <span>{items.length} symbols</span>
      </h4>
      <table className="quotes">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Name</th>
            <th className="num">Last</th>
            <th className="num">Change</th>
            <th className="num">%</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const q = quotes.get(it.symbol.toUpperCase()) ?? quotes.get(it.symbol);
            const dir = q ? (q.change >= 0 ? 'up' : 'down') : '';
            const stale = isStaleQuote(q?.time);
            return (
              <tr key={`${it.provider}:${it.symbol}`} onClick={() => onOpen(it, q?.name)} className={stale ? 'stale' : ''} title={stale && q ? `Last update ${formatQuoteDate(q.time)}` : undefined}>
                <td>
                  <b>{it.label ?? it.symbol}</b>
                  {it.provider === 'mt4' && <span className="badge" style={{ marginLeft: 6, fontSize: 9.5, padding: '0 4px', color: 'var(--accent)' }}>MT4</span>}
                  {stale && q && <span style={{ marginLeft: 6, color: 'var(--faint)', fontSize: 11 }}>{formatQuoteDate(q.time)}</span>}
                </td>
                <td style={{ color: 'var(--muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q?.name ?? '—'}</td>
                <td className="num">{q ? formatPrice(q.price) : '…'}</td>
                <td className={`num ${dir}`}>{q ? `${q.change >= 0 ? '+' : ''}${formatPrice(q.change, priceDecimals(q.price))}` : ''}</td>
                <td className={`num ${dir}`}>{q ? formatPct(q.changePct) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Read {
  label: string;
  report?: AnalysisReport;
  error?: string;
}
interface Row {
  s: SymbolInfo;
  reads: Read[];
}
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const INDEXES: SymbolInfo[] = [
  { symbol: '^NSEI', name: 'NIFTY 50', exchange: 'NSE', assetClass: 'index', provider: 'yahoo' },
  { symbol: '^NSEBANK', name: 'NIFTY BANK', exchange: 'NSE', assetClass: 'index', provider: 'yahoo' },
];

/** NIFTY / BANK NIFTY from MetaTrader 4 when its history has them, otherwise from Yahoo. */
function indexSources(mt4Symbols: SymbolInfo[]): SymbolInfo[] {
  const fromMt4 = (sym: string, name: string, fallback: SymbolInfo): SymbolInfo => {
    const m = mt4Symbols.find((x) => x.symbol.toUpperCase() === sym);
    return m ? { ...m, name } : fallback;
  };
  return [fromMt4('NIFTY', 'NIFTY 50', INDEXES[0]), fromMt4('BANKNIFTY', 'NIFTY BANK', INDEXES[1])];
}

function IndexBias({ onOpen, mt4Symbols }: { onOpen: (s: SymbolInfo) => void; mt4Symbols: SymbolInfo[] }) {
  const sources = indexSources(mt4Symbols);
  const sourceKey = sources.map((s) => `${s.provider}:${s.symbol}`).join(',');
  const [rows, setRows] = useState<Row[]>(sources.map((s) => ({ s, reads: [] })));
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    // Each timeframe stands alone, so a short daily history does not hide the intraday read.
    const read = async (s: SymbolInfo, tf: '15m' | '1d', label: string): Promise<Read> => {
      try {
        const series = await window.trendlens.getSeries({ provider: s.provider, symbol: s.symbol, timeframe: tf });
        if (series.candles.length < MIN_BARS)
          return {
            label,
            error: `needs ${MIN_BARS} bars, ${s.provider === 'mt4' ? 'MT4 has' : 'got'} ${series.candles.length}${s.provider === 'mt4' ? ' — press Home on this chart in MT4 to load more' : ''}`,
          };
        return { label, report: await runAnalysis(series, s) };
      } catch (e) {
        return { label, error: cleanErr(e) };
      }
    };
    const out = await Promise.all(indexSources(mt4Symbols).map(async (s) => ({ s, reads: await Promise.all([read(s, '15m', '15 min'), read(s, '1d', 'Daily')]) })));
    setRows(out);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card">
      <h4>
        <span>Index bias module · NIFTY / BANK NIFTY · {sources.every((s) => s.provider === 'mt4') ? 'MetaTrader 4' : 'Yahoo Finance'}</span>
        <button className="btn btn-sm" onClick={() => void load()} disabled={busy}>
          {busy ? <span className="spinner" /> : 'Refresh'}
        </button>
      </h4>
      <div className="grid-2">
        {rows.map((r) => {
          const first = r.reads.find((x) => x.report)?.report;
          return (
            <div key={r.s.symbol} className="bias-card" style={{ cursor: 'pointer' }} onClick={() => onOpen(r.s)}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <b>{r.s.name}</b>
                <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{first ? formatPrice(first.lastPrice) : ''}</span>
              </div>
              {r.reads.length === 0 && (
                <span style={{ color: 'var(--muted)' }}>
                  <span className="spinner" /> Analysing…
                </span>
              )}
              {r.reads.map((x) => (
                <div key={x.label} style={{ display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 8, alignItems: 'center' }}>
                  <span style={{ color: 'var(--muted)' }}>{x.label}</span>
                  {x.report ? (
                    <>
                      <span className={toneClass(conditionTone(x.report.condition))} style={{ fontWeight: 700 }}>
                        {x.report.condition}
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>conf {x.report.confidence}%</span>
                    </>
                  ) : (
                    <span className="tone-warn" style={{ gridColumn: '2 / span 2', fontSize: 12 }}>
                      {x.error}
                    </span>
                  )}
                </div>
              ))}
              {first && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{first.verdict}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MarketsView({
  us,
  india,
  global,
  quotes,
  onOpen,
  lastUpdate,
  mt4Symbols,
}: {
  us: WatchItem[];
  india: WatchItem[];
  global: WatchItem[];
  quotes: Map<string, Quote>;
  onOpen: (s: SymbolInfo) => void;
  lastUpdate: number;
  mt4Symbols: SymbolInfo[];
}) {
  const open = (w: WatchItem, name?: string) =>
    onOpen({
      symbol: w.symbol,
      name: name ?? w.label ?? w.symbol,
      exchange: w.provider === 'binance' ? 'Binance' : w.provider === 'mt4' ? 'MT4' : '',
      assetClass: w.provider === 'binance' ? 'crypto' : w.symbol.startsWith('^') ? 'index' : w.symbol.endsWith('=X') ? 'forex' : 'equity',
      provider: w.provider,
    });
  return (
    <div className="page">
      <h2>Global market ticker</h2>
      <p className="sub">
        NASDAQ and Indian market prices, refreshed automatically{lastUpdate ? ` · updated ${new Date(lastUpdate).toLocaleTimeString()}` : ''}. Click any row to analyse it. MT4 rows come
        from your MetaTrader 4 history (live while MT4 is running); other rows from public Yahoo Finance / Binance data, which may be delayed.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <IndexBias onOpen={onOpen} mt4Symbols={mt4Symbols} />
        <div className="grid-2">
          <QuoteTable title="NASDAQ & US live prices" items={us} quotes={quotes} onOpen={open} />
          <QuoteTable title="Indian market live prices" items={india} quotes={quotes} onOpen={open} />
        </div>
        <QuoteTable title="Forex, commodities, indices & crypto" items={global} quotes={quotes} onOpen={open} />
      </div>
    </div>
  );
}
