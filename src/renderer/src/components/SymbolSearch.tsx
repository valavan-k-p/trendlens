import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { SymbolInfo } from '@core/types';
import { looksLikeBinancePair } from '@core/data';

export interface SymbolSearchHandle {
  focus(): void;
}

const ASSET_LABEL: Record<SymbolInfo['assetClass'], string> = {
  equity: 'Stock',
  index: 'Index',
  forex: 'Forex',
  crypto: 'Crypto',
  commodity: 'Futures',
  etf: 'ETF',
  other: 'Other',
};

export const SymbolSearch = forwardRef<SymbolSearchHandle, { onSelect: (s: SymbolInfo) => void; favorites: SymbolInfo[] }>(function SymbolSearch({ onSelect, favorites }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await window.trendlens.search(query);
        if (id === seq.current) {
          setResults(r);
          setSel(0);
        }
      } catch {
        if (id === seq.current) setResults([]);
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const list = q.trim() ? results : favorites;

  const choose = (s: SymbolInfo) => {
    onSelect(s);
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  const submitRaw = () => {
    const raw = q.trim().toUpperCase();
    if (!raw) return;
    const binance = looksLikeBinancePair(raw);
    choose({ symbol: raw, name: raw, exchange: binance ? 'Binance' : '', assetClass: binance ? 'crypto' : 'other', provider: binance ? 'binance' : 'yahoo' });
  };

  return (
    <div className="search">
      <span className="glass">⌕</span>
      <input
        ref={input}
        value={q}
        placeholder="Search stock, index, forex, crypto…  (Ctrl+K)"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSel((s) => Math.min(list.length - 1, s + 1));
          else if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
          else if (e.key === 'Enter') {
            if (list[sel]) choose(list[sel]);
            else submitRaw();
          } else if (e.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      {open && (q.trim() || favorites.length > 0) && (
        <div className="search-results">
          {!q.trim() && <div className="search-note">Favourites</div>}
          {list.map((s, i) => (
            <div key={`${s.provider}:${s.symbol}`} className={`search-item ${i === sel ? 'sel' : ''}`} onMouseDown={() => choose(s)} onMouseEnter={() => setSel(i)}>
              <b>{s.symbol}</b>
              <small>
                {s.name} {s.exchange ? `· ${s.exchange}` : ''}
              </small>
              <span className="tag">{s.provider === 'binance' ? 'Binance' : ASSET_LABEL[s.assetClass]}</span>
            </div>
          ))}
          {q.trim() && busy && (
            <div className="search-note">
              <span className="spinner" /> Searching…
            </div>
          )}
          {q.trim() && !busy && results.length === 0 && <div className="search-note">No matches. Press Enter to load “{q.trim().toUpperCase()}” directly.</div>}
          {q.trim() && (
            <div className="search-note" style={{ borderTop: '1px solid var(--border)' }}>
              Tips: NSE stocks end in <b>.NS</b> (RELIANCE.NS), BSE in <b>.BO</b>, indices start with <b>^</b> (^NSEI), forex ends in <b>=X</b> (EURUSD=X).
            </div>
          )}
        </div>
      )}
    </div>
  );
});
