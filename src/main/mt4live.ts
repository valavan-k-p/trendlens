/**
 * Live MT4 feeds (read-only), from either EA:
 *  - TrendLensFeed (bundled with TrendLens): Common\Files\TrendLens\, heartbeat carries MT4's
 *    exact forming bar for every timeframe.
 *  - MarketDataExporter (existing user EA): Common\Files\MT4AI\, heartbeat has prices only,
 *    so the forming bar is built from 1-minute samples of those prices.
 * Closed bars come from each feed's candles_<SYMBOL>_<TF>.csv.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '@core/types';
import {
  formingFromMinutes,
  heartbeatIsLive,
  mergeBars,
  parseExporterCandles,
  parseHeartbeat,
  splitExporterName,
  updateFormingBar,
  type Heartbeat,
} from '@core/data/mt4live';

export const FEED_FOLDERS = ['TrendLens', 'MT4AI'] as const;

export function commonFilesDir(): string | undefined {
  const appdata = process.env.APPDATA;
  return appdata ? join(appdata, 'MetaQuotes', 'Terminal', 'Common', 'Files') : undefined;
}

function feedDirs(): string[] {
  const base = commonFilesDir();
  if (!base) return [];
  return FEED_FOLDERS.map((f) => join(base, f)).filter((d) => existsSync(d));
}

// ------------------------------------------------------------ closed bars

interface FileState {
  offset: number;
  bars: Map<number, Candle>;
  sorted: Candle[] | null;
  mtimeMs: number;
}
const fileStates = new Map<string, FileState>();

/** Reads only bytes appended since the last call; a shrunk or rewritten file is re-read from the start. */
function readCandleFile(path: string): FileState {
  const st = statSync(path);
  let s = fileStates.get(path);
  // TrendLensFeed rewrites its files on start-up: a smaller size or older content means start over.
  if (!s || st.size < s.offset) {
    s = { offset: 0, bars: new Map(), sorted: null, mtimeMs: 0 };
    fileStates.set(path, s);
  }
  if (st.size > s.offset) {
    const fd = openSync(path, 'r');
    try {
      const len = st.size - s.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, s.offset);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        parseExporterCandles(buf.toString('latin1', 0, lastNl + 1), s.bars);
        s.offset += lastNl + 1;
        s.sorted = null;
      }
    } finally {
      closeSync(fd);
    }
  }
  s.mtimeMs = st.mtimeMs;
  if (!s.sorted) s.sorted = [...s.bars.values()].sort((a, b) => a.time - b.time);
  return s;
}

export interface LiveFile {
  symbol: string;
  period: number;
  path: string;
  mtimeMs: number;
}

export function listFiles(): LiveFile[] {
  const out: LiveFile[] = [];
  for (const dir of feedDirs()) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = splitExporterName(name);
      if (!p) continue;
      const path = join(dir, name);
      try {
        out.push({ ...p, path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        /* file vanished */
      }
    }
  }
  return out;
}

/** Closed bars for a symbol/period from every feed, merged by bar time. */
export function closedBars(symbol: string, period: number): { bars: Candle[]; mtimeMs: number } | undefined {
  const matches = listFiles().filter((x) => x.symbol.toUpperCase() === symbol.toUpperCase() && x.period === period);
  if (!matches.length) return undefined;
  const lists: Candle[][] = [];
  let mtimeMs = 0;
  // Older files first so the freshest feed wins on equal bar times.
  for (const f of matches.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    try {
      const s = readCandleFile(f.path);
      lists.push(s.sorted!);
      mtimeMs = Math.max(mtimeMs, s.mtimeMs);
    } catch {
      /* unreadable: skip */
    }
  }
  return lists.length ? { bars: lists.length === 1 ? lists[0] : mergeBars(...lists), mtimeMs } : undefined;
}

// ------------------------------------------------------------ heartbeats + forming bars

const heartbeats = new Map<string, Heartbeat>(); // per feed folder
/** Rolling 1-minute bars per symbol built from live prices (about one trading day). */
const minutes = new Map<string, Candle[]>();
const MAX_MINUTES = 1600;
let timer: NodeJS.Timeout | undefined;

function pollHeartbeats(): void {
  for (const dir of feedDirs()) {
    try {
      const hb = parseHeartbeat(readFileSync(join(dir, 'heartbeat.json'), 'latin1'));
      if (!hb) continue;
      heartbeats.set(dir, hb);
      if (!heartbeatIsLive(hb)) continue;
      for (const q of hb.quotes) {
        const key = q.symbol.toUpperCase();
        const list = minutes.get(key) ?? [];
        const last = list[list.length - 1];
        const bar = updateFormingBar(last, q.bid, q.lastTickTime || hb.serverTime, 1);
        if (last && last.time === bar.time) list[list.length - 1] = bar;
        else if (!last || bar.time > last.time) list.push(bar);
        if (list.length > MAX_MINUTES) list.splice(0, list.length - MAX_MINUTES);
        minutes.set(key, list);
      }
    } catch {
      /* EA mid-write or not running */
    }
  }
}

export function startPolling(): void {
  if (timer) return;
  pollHeartbeats();
  timer = setInterval(pollHeartbeats, 1000);
}

function liveHeartbeats(): Heartbeat[] {
  return [...heartbeats.values()].filter((h) => heartbeatIsLive(h));
}

export function isLive(): boolean {
  return liveHeartbeats().length > 0;
}

export function liveFeeds(): string[] {
  return [...new Set(liveHeartbeats().map((h) => h.feed))];
}

export function liveSymbols(): string[] {
  return [...new Set(liveHeartbeats().flatMap((h) => h.quotes.map((q) => q.symbol)))];
}

/** The forming bar for a symbol/period, aligned after `lastClosedTime`, while a feed is live. */
export function formingBar(symbol: string, period: number, lastClosedTime: number | undefined): Candle | undefined {
  const live = liveHeartbeats();
  if (!live.length) return undefined;
  // Prefer MT4's own bar from TrendLensFeed: exact open/high/low and broker alignment.
  for (const hb of live) {
    const exact = hb.quotes.find((q) => q.symbol.toUpperCase() === symbol.toUpperCase())?.bars?.[period];
    if (exact && (lastClosedTime === undefined || exact.time > lastClosedTime)) return exact;
  }
  return formingFromMinutes(minutes.get(symbol.toUpperCase()) ?? [], period, lastClosedTime);
}

export function liveQuote(symbol: string): { price: number; time: number } | undefined {
  let best: { price: number; time: number } | undefined;
  for (const hb of liveHeartbeats()) {
    const q = hb.quotes.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
    if (!q) continue;
    const t = q.lastTickTime || hb.serverTime;
    if (!best || t > best.time) best = { price: q.bid, time: t };
  }
  return best;
}
