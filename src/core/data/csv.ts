/**
 * CSV import for OHLCV exports (TradingView, broker terminals, Yahoo downloads).
 * Detects the delimiter and the date/open/high/low/close/volume columns by name.
 */
import type { Candle, Series, Timeframe } from '../types';
import { TIMEFRAMES } from '../types';

const ALIASES: Record<keyof Candle, string[]> = {
  time: ['time', 'date', 'datetime', 'timestamp', 'date/time', 'open time', 'opentime'],
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c', 'adj close', 'last', 'price'],
  volume: ['volume', 'vol', 'v', 'qty'],
};

export function parseTimeValue(raw: string): number {
  const s = raw.trim().replace(/^"|"$/g, '');
  if (/^\d{9,10}$/.test(s)) return Number(s);
  if (/^\d{12,13}$/.test(s)) return Math.floor(Number(s) / 1000);
  // dd-mm-yyyy or dd/mm/yyyy (common in Indian exports)
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dmy) {
    const [, d, m, y, hh = '0', mm = '0', ss = '0'] = dmy;
    return Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss) / 1000;
  }
  const iso = s.includes('T') || /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + (/\d{2}:\d{2}/.test(s) ? 'Z' : 'T00:00:00Z');
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Unrecognised date/time value "${raw}".`);
  return Math.floor(t / 1000);
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === delim && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export function parseCsv(text: string, name = 'CSV import'): Series {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('The CSV file has no data rows.');
  const header = lines[0];
  const delim = [',', ';', '\t', '|'].sort((a, b) => header.split(b).length - header.split(a).length)[0];
  const cols = splitLine(header, delim).map((h) => h.toLowerCase().replace(/^"|"$/g, ''));
  const idx = {} as Record<keyof Candle, number>;
  for (const key of Object.keys(ALIASES) as (keyof Candle)[]) idx[key] = cols.findIndex((c) => ALIASES[key].includes(c));
  for (const req of ['time', 'open', 'high', 'low', 'close'] as const)
    if (idx[req] < 0) throw new Error(`CSV is missing a "${req}" column (found: ${cols.join(', ')}).`);

  const candles: Candle[] = [];
  for (const line of lines.slice(1)) {
    const f = splitLine(line, delim);
    const num = (k: keyof Candle) => Number((f[idx[k]] ?? '').replace(/,/g, ''));
    const c: Candle = {
      time: parseTimeValue(f[idx.time]),
      open: num('open'),
      high: num('high'),
      low: num('low'),
      close: num('close'),
      volume: idx.volume >= 0 ? num('volume') || 0 : 0,
    };
    if ([c.open, c.high, c.low, c.close].every(Number.isFinite)) candles.push(c);
  }
  candles.sort((a, b) => a.time - b.time);
  return {
    timeframe: inferTimeframe(candles),
    candles,
    meta: { symbol: name, name, provider: 'csv', volumeAvailable: candles.some((c) => c.volume > 0) },
  };
}

/** Picks the timeframe closest to the median spacing between bars. */
export function inferTimeframe(c: Candle[]): Timeframe {
  if (c.length < 2) return '1d';
  const gaps = c.slice(1).map((x, i) => x.time - c[i].time).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return TIMEFRAMES.reduce((best, t) => (Math.abs(Math.log(t.seconds / median)) < Math.abs(Math.log(TIMEFRAMES.find((x) => x.id === best)!.seconds / median)) ? t.id : best), '1d' as Timeframe);
}
