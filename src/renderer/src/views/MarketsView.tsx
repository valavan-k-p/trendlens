import { useCallback, useEffect, useState } from 'react';
import type { AnalysisReport } from '@core/analysis/types';
import { formatPct, formatPrice, priceDecimals } from '@core/format';
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
            return (
              <tr key={it.symbol} onClick={() => onOpen(it, q?.name)}>
                <td>
                  <b>{it.label ?? it.symbol}</b>
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

const INDEXES: SymbolInfo[] = [
  { symbol: '^NSEI', name: 'NIFTY 50', exchange: 'NSE', assetClass: 'index', provider: 'yahoo' },
  { symbol: '^NSEBANK', name: 'NIFTY BANK', exchange: 'NSE', assetClass: 'index', provider: 'yahoo' },
];

function IndexBias({ onOpen }: { onOpen: (s: SymbolInfo) => void }) {
  const [rows, setRows] = useState<{ s: SymbolInfo; intraday?: AnalysisReport; daily?: AnalysisReport; error?: string }[]>(INDEXES.map((s) => ({ s })));
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    const out = await Promise.all(
      INDEXES.map(async (s) => {
        try {
          const [i, d] = await Promise.all([
            window.trendlens.getSeries({ provider: 'yahoo', symbol: s.symbol, timeframe: '15m' }),
            window.trendlens.getSeries({ provider: 'yahoo', symbol: s.symbol, timeframe: '1d' }),
          ]);
          return { s, intraday: await runAnalysis(i, s), daily: await runAnalysis(d, s) };
        } catch (e) {
          return { s, error: (e as Error).message };
        }
      }),
    );
    setRows(out);
    setBusy(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card">
      <h4>
        <span>Index bias module · NIFTY / BANK NIFTY</span>
        <button className="btn btn-sm" onClick={() => void load()} disabled={busy}>
          {busy ? <span className="spinner" /> : 'Refresh'}
        </button>
      </h4>
      <div className="grid-2">
        {rows.map((r) => (
          <div key={r.s.symbol} className="bias-card" style={{ cursor: 'pointer' }} onClick={() => onOpen(r.s)}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <b>{r.s.name}</b>
              <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{r.intraday ? formatPrice(r.intraday.lastPrice) : ''}</span>
            </div>
            {r.error && <span className="tone-bear">{r.error}</span>}
            {!r.error && !r.intraday && (
              <span style={{ color: 'var(--muted)' }}>
                <span className="spinner" /> Analysing…
              </span>
            )}
            {r.intraday && r.daily && (
              <>
                {[
                  ['15 min', r.intraday],
                  ['Daily', r.daily],
                ].map(([label, rep]) => {
                  const report = rep as AnalysisReport;
                  return (
                    <div key={label as string} style={{ display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: 'var(--muted)' }}>{label as string}</span>
                      <span className={`${toneClass(conditionTone(report.condition))}`} style={{ fontWeight: 700 }}>
                        {report.condition}
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>conf {report.confidence}%</span>
                    </div>
                  );
                })}
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{r.intraday.verdict}</div>
              </>
            )}
          </div>
        ))}
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
}: {
  us: WatchItem[];
  india: WatchItem[];
  global: WatchItem[];
  quotes: Map<string, Quote>;
  onOpen: (s: SymbolInfo) => void;
  lastUpdate: number;
}) {
  const open = (w: WatchItem, name?: string) =>
    onOpen({
      symbol: w.symbol,
      name: name ?? w.label ?? w.symbol,
      exchange: w.provider === 'binance' ? 'Binance' : '',
      assetClass: w.provider === 'binance' ? 'crypto' : w.symbol.startsWith('^') ? 'index' : w.symbol.endsWith('=X') ? 'forex' : 'equity',
      provider: w.provider,
    });
  return (
    <div className="page">
      <h2>Global market ticker</h2>
      <p className="sub">
        NASDAQ and Indian market prices, refreshed automatically{lastUpdate ? ` · updated ${new Date(lastUpdate).toLocaleTimeString()}` : ''}. Click any row to analyse it. Prices from
        public Yahoo Finance / Binance data; Yahoo quotes for some exchanges may be delayed.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <IndexBias onOpen={onOpen} />
        <div className="grid-2">
          <QuoteTable title="NASDAQ & US live prices" items={us} quotes={quotes} onOpen={open} />
          <QuoteTable title="Indian market live prices" items={india} quotes={quotes} onOpen={open} />
        </div>
        <QuoteTable title="Forex, commodities, indices & crypto" items={global} quotes={quotes} onOpen={open} />
      </div>
    </div>
  );
}
