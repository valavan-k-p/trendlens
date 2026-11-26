import type { Quote } from '@core/types';
import { formatPct, formatPrice } from '@core/format';
import type { WatchItem } from '../../../shared/api';

export function TickerTape({ items, quotes, onPick }: { items: WatchItem[]; quotes: Map<string, Quote>; onPick: (item: WatchItem) => void }) {
  const rows = items.map((it) => ({ it, q: quotes.get(it.symbol.toUpperCase()) ?? quotes.get(it.symbol) }));
  const content = rows.map(({ it, q }, i) => (
    <span className="tick" key={`${it.symbol}-${i}`} onClick={() => onPick(it)} title={it.symbol}>
      <b>{it.label ?? it.symbol}</b>
      <span>{q ? formatPrice(q.price) : '…'}</span>
      {q && <span className={q.change >= 0 ? 'up' : 'down'}>{formatPct(q.changePct)}</span>}
    </span>
  ));
  return (
    <div className="ticker">
      {/* Content is duplicated so the CSS animation loops seamlessly. */}
      <div className="ticker-track">
        {content}
        {content}
      </div>
    </div>
  );
}
