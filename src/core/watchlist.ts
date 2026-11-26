import { looksLikeBinancePair } from './data';

export interface WatchToken {
  symbol: string;
  provider: 'yahoo' | 'binance';
  label?: string;
}

/**
 * Parses "SYMBOL" or "SYMBOL=Label" tokens separated by commas or newlines.
 * Yahoo forex and futures symbols themselves contain "=" (EURUSD=X, GC=F), so a
 * trailing "=X" / "=F" belongs to the symbol when it ends the token or is
 * followed by another "=".
 */
export function parseWatchlist(text: string): WatchToken[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const m = /^(.+?=[XF](?==|$)|[^=]+)(?:=(.*))?$/i.exec(tok);
      const symbol = (m ? m[1] : tok).trim().toUpperCase();
      const label = m?.[2]?.trim() || undefined;
      return { symbol, label, provider: looksLikeBinancePair(symbol) ? 'binance' : 'yahoo' };
    });
}

export function formatWatchlist(items: WatchToken[]): string {
  return items.map((i) => (i.label ? `${i.symbol}=${i.label}` : i.symbol)).join(', ');
}
