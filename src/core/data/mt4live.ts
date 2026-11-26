/**
 * Live MT4 data written by the MarketDataExporter EA into
 * %APPDATA%\MetaQuotes\Terminal\Common\Files\MT4AI\ (read-only here):
 *
 *   candles_<SYMBOL>_<TF>.csv  append-only rows of CLOSED bars:
 *     bar_time,symbol,tf,open,high,low,close,tick_volume,observed_server_time,source,session
 *     Each EA start re-appends a backfill, so a bar_time can repeat; the last row wins.
 *   heartbeat.json             rewritten every ~2 s with bid/ask per symbol and clocks.
 *
 * Times are broker server time, the same clock as MT4's .hst history.
 */
import type { Candle } from '../types';

/** Parses complete CSV lines into `into` (bar_time -> candle); later rows replace earlier ones. */
export function parseExporterCandles(text: string, into: Map<number, Candle>): void {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const f = line.split(',');
    if (f.length < 8) continue;
    const time = Number(f[0]);
    if (!Number.isInteger(time) || time <= 0) continue; // header or junk
    const c: Candle = { time, open: Number(f[3]), high: Number(f[4]), low: Number(f[5]), close: Number(f[6]), volume: Number(f[7]) || 0 };
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high < c.low) continue;
    into.set(time, c);
  }
}

/** Splits "candles_SENSEX-FUT_15.csv" into symbol and period. */
export function splitExporterName(name: string): { symbol: string; period: number } | null {
  const m = /^candles_(.+)_(\d+)\.csv$/i.exec(name);
  return m ? { symbol: m[1], period: Number(m[2]) } : null;
}

export interface HeartbeatQuote {
  symbol: string;
  bid: number;
  ask: number;
  lastTickTime: number;
  /** Exact forming bars from MT4, keyed by period in minutes (TrendLensFeed only). */
  bars?: Record<number, Candle>;
}

export interface Heartbeat {
  /** 'TrendLensFeed' or 'MarketDataExporter'. */
  feed: string;
  serverTime: number;
  gmtTime: number;
  connected: boolean;
  quotes: HeartbeatQuote[];
}

interface RawBar {
  tf: number;
  time: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function parseHeartbeat(text: string): Heartbeat | null {
  try {
    const j = JSON.parse(text) as {
      feed?: string;
      server_time?: number;
      gmt_time?: number;
      connected?: boolean;
      quotes?: { symbol: string; bid: number; ask: number; last_tick_time: number; bars?: RawBar[] }[];
    };
    if (typeof j.server_time !== 'number' || typeof j.gmt_time !== 'number') return null;
    return {
      feed: j.feed ?? 'MarketDataExporter',
      serverTime: j.server_time,
      gmtTime: j.gmt_time,
      connected: !!j.connected,
      quotes: (j.quotes ?? [])
        .filter((q) => Number.isFinite(q.bid) && q.bid > 0)
        .map((q) => {
          const out: HeartbeatQuote = { symbol: q.symbol, bid: q.bid, ask: q.ask, lastTickTime: q.last_tick_time };
          if (Array.isArray(q.bars)) {
            out.bars = {};
            for (const b of q.bars)
              if (b.time > 0 && [b.o, b.h, b.l, b.c].every(Number.isFinite)) out.bars[b.tf] = { time: b.time, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 };
          }
          return out;
        }),
    };
  } catch {
    return null;
  }
}

/** A heartbeat is live when its GMT clock is within `maxAgeSec` of now. */
export function heartbeatIsLive(hb: Heartbeat | null, nowMs = Date.now(), maxAgeSec = 20): boolean {
  return !!hb && Math.abs(nowMs / 1000 - hb.gmtTime) <= maxAgeSec;
}

/**
 * Tracks the bar that is still forming, from live prices, for one symbol and period.
 * The exporter only writes bars once they close, so the newest bar comes from here
 * (open = first price seen in the bucket while TrendLens was running).
 */
export function updateFormingBar(prev: Candle | undefined, price: number, tickTime: number, periodMin: number): Candle {
  const size = periodMin * 60;
  const bucket = Math.floor(tickTime / size) * size;
  if (prev && prev.time === bucket) {
    return { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: price };
  }
  return { time: bucket, open: price, high: price, low: price, close: price, volume: 0 };
}

/**
 * Builds the forming bar for any period from 1-minute live bars, aligned to the
 * broker's own bar grid: buckets are anchored on the last closed bar's time (brokers
 * often start hourly bars at :45 or session open), not on the clock hour.
 */
export function formingFromMinutes(minutes: Candle[], periodMin: number, lastClosedTime: number | undefined): Candle | undefined {
  if (!minutes.length) return undefined;
  const size = periodMin * 60;
  const latest = minutes[minutes.length - 1].time;
  let start: number;
  if (lastClosedTime !== undefined && lastClosedTime > 0 && latest >= lastClosedTime) {
    start = lastClosedTime + Math.floor((latest - lastClosedTime) / size) * size;
    if (start === lastClosedTime) return undefined; // still inside the last closed bar
  } else {
    start = Math.floor(latest / size) * size;
  }
  const inBar = minutes.filter((m) => m.time >= start && m.time < start + size);
  if (!inBar.length) return undefined;
  return {
    time: start,
    open: inBar[0].open,
    high: Math.max(...inBar.map((m) => m.high)),
    low: Math.min(...inBar.map((m) => m.low)),
    close: inBar[inBar.length - 1].close,
    volume: 0,
  };
}

/**
 * Combines bars by time. Later sources override earlier ones on equal times; the
 * result is ascending. Used to lay exporter bars and the forming bar over .hst history.
 */
export function mergeBars(...sources: Candle[][]): Candle[] {
  const m = new Map<number, Candle>();
  for (const src of sources) for (const c of src) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}
