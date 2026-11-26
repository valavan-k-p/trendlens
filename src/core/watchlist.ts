import { looksLikeBinancePair } from './data';

export interface WatchToken {
  symbol: string;
  provider: 'mt4' | 'yahoo' | 'binance';
  label?: string;
}

/**
 * Parses "SYMBOL" or "SYMBOL=Label" tokens separated by commas or newlines.
 * "MT4:SYMBOL" marks a MetaTrader 4 symbol (kept in its original case).
 * Yahoo forex and futures symbols themselves contain "=" (EURUSD=X, GC=F), so a
 * trailing "=X" / "=F" belongs to the symbol when it ends the token or is
 * followed by another "=".
 */
export function parseWatchlist(text: string): WatchToken[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok): WatchToken => {
      const isMt4 = /^mt4:/i.test(tok);
      const body = isMt4 ? tok.slice(4).trim() : tok;
      if (isMt4) {
        const eq = body.indexOf('=');
        return { symbol: (eq >= 0 ? body.slice(0, eq) : body).trim(), label: eq >= 0 ? body.slice(eq + 1).trim() || undefined : undefined, provider: 'mt4' };
      }
      const m = /^(.+?=[XF](?==|$)|[^=]+)(?:=(.*))?$/i.exec(body);
      const symbol = (m ? m[1] : body).trim().toUpperCase();
      const label = m?.[2]?.trim() || undefined;
      return { symbol, label, provider: looksLikeBinancePair(symbol) ? 'binance' : 'yahoo' };
    });
}

export function formatWatchlist(items: WatchToken[]): string {
  return items.map((i) => `${i.provider === 'mt4' ? 'MT4:' : ''}${i.symbol}${i.label ? `=${i.label}` : ''}`).join(', ');
}
