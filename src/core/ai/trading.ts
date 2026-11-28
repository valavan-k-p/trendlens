/**
 * Token-lean prompts and parsers for the AI trade signal (Analyzer → AI signal) and the news
 * assistant. Pure functions: no network, no UI.
 */
import type { AnalysisReport } from '../analysis/types';
import { atr, ema, rsi, vwap } from '../indicators';
import type { Candle } from '../types';
import { sessionInfo } from '../options/option-contracts';
import type { OptionExchange } from '../options/types';

export type SignalAction = 'BUY_CE' | 'BUY_PE' | 'NO_TRADE' | 'HOLD' | 'EXIT';
export const SIGNAL_ACTIONS: SignalAction[] = ['BUY_CE', 'BUY_PE', 'NO_TRADE', 'HOLD', 'EXIT'];

export interface TradeSignal {
  action: SignalAction;
  /** e.g. "NIFTY 25700 PE 01-Dec". */
  option?: string;
  entry?: string;
  target?: string;
  stopLoss?: string;
  /** ≤ 12 words: the no-entry alert, or why to hold / exit. */
  note?: string;
  /** ≤ 12 words: the news that matters now and its direction. */
  news?: string;
}

/** A trade the user said they took, sent back so the AI can say HOLD or EXIT. */
export interface OpenTrade {
  option: string;
  entry: string;
  target?: string;
  stopLoss?: string;
  /** Unix seconds when it was taken. */
  since: number;
}

/** Compact option quotes near ATM for the prompt. */
export interface OptionLine {
  strike: number;
  ce?: { ltp?: number; iv?: number; delta?: number };
  pe?: { ltp?: number; iv?: number; delta?: number };
}

export interface OptionsContext {
  underlying: string;
  expiry: string;
  daysToExpiry: number;
  lotSize?: number;
  spot?: number;
  rows: OptionLine[];
  source: string;
}

export const SIGNAL_SYSTEM = `You are a disciplined professional options trader. Capital protection first; take only high-probability setups.
Use only the data and chart given. Trade only when structure, trend and momentum agree, the stop is clear and reward:risk >= 1.5. Otherwise NO_TRADE.
Buy options only (CE for up, PE for down). Prefer ATM or 1 strike ITM of the nearest expiry; avoid entries in the last 30 min of the session and in chop.
If OPEN trade is given: reply HOLD (move is intact, more profit likely: give trailed SL and next target) or EXIT (target hit, SL hit or reversal).
If Session is CLOSED: never signal an immediate entry. Give a plan for the next open (entry starting "If ...", e.g. "If opens below 25680: PE above 150") or NO_TRADE.
Weigh the news (HEADLINES given and/or a search tool): a high-impact event soon, or credible news against the setup, means NO_TRADE. Ignore stale or unverified items.
Use option premium levels when option prices are given, else underlying levels and say "spot".
Reply ONLY this JSON, no other text:
{"a":"BUY_CE|BUY_PE|NO_TRADE|HOLD|EXIT","opt":"","entry":"","target":"","sl":"","note":"","news":""}
note: max 12 words (why no entry / why hold or exit). news: max 12 words, the news that matters with ↑/↓, or "" if none checked. Empty strings for fields that do not apply.`;

const r = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '-' : Number(v.toFixed(d)).toString());
const last = (a: number[]) => {
  for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i];
  return undefined;
};

/** IST clock text for a unix time. */
function ist(t: number): string {
  return new Date((t + 19800) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The market context for one signal request, kept to a few hundred tokens: the engine's verdict,
 * levels, module summaries, key indicator values, the last bars and option prices near ATM.
 */
export function signalContext(o: { report: AnalysisReport; candles: Candle[]; options?: OptionsContext; openTrade?: OpenTrade; bars?: number; session?: string }): string {
  const { report: rep, candles } = o;
  const closes = candles.map((c) => c.close);
  const d = rep.lastPrice >= 1000 ? 1 : 2;
  const lines: string[] = [];
  lines.push(`${rep.symbol} ${rep.timeframe} last ${r(rep.lastPrice, d)} at ${ist(rep.lastTime)} IST`);
  if (o.session) lines.push(`Session: ${o.session}`);
  lines.push(`Engine: ${rep.condition} bias ${rep.biasScore} conf ${rep.confidence}% strength ${rep.strengthIndex} phase ${rep.phase} risk ${rep.risk.level}`);
  if (rep.risk.flags.length) lines.push(`Risk flags: ${rep.risk.flags.slice(0, 4).join('; ')}`);
  const lv = rep.levels
    .slice(0, 8)
    .map((l) => `${l.kind === 'support' ? 'S' : l.kind === 'resistance' ? 'R' : 'L'}${r(l.price, d)}`)
    .join(' ');
  lines.push(`Levels: S ${r(rep.keyLevels.support, d)} R ${r(rep.keyLevels.resistance, d)}${lv ? ` | ${lv}` : ''}`);
  for (const m of rep.modules) lines.push(`${m.title}${m.score !== null ? ` ${m.score}` : ''}: ${m.summary.slice(0, 110)}`);
  if (rep.mtf.length) lines.push(`MTF: ${rep.mtf.map((t) => `${t.timeframe} ${t.bias}`).join(', ')}`);
  if (candles.length >= 30) {
    const at = atr(candles, 14);
    const vw = candles.some((c) => c.volume > 0) ? last(vwap(candles)) : undefined;
    lines.push(`EMA20 ${r(last(ema(closes, 20)), d)} EMA50 ${r(last(ema(closes, 50)), d)} RSI14 ${r(last(rsi(closes, 14)), 1)} ATR14 ${r(last(at), d)}${vw !== undefined ? ` VWAP ${r(vw, d)}` : ''}`);
  }
  const n = o.bars ?? 12;
  const recent = candles.slice(-n).map((c) => `${r(c.open, d)},${r(c.high, d)},${r(c.low, d)},${r(c.close, d)}`);
  if (recent.length) lines.push(`Last ${recent.length} bars o,h,l,c: ${recent.join(' ')}`);
  const op = o.options;
  if (op && op.rows.length) {
    lines.push(`Options ${op.underlying} exp ${op.expiry} (${op.daysToExpiry.toFixed(1)}d)${op.lotSize ? ` lot ${op.lotSize}` : ''}${op.spot ? ` spot ${r(op.spot, d)}` : ''} [${op.source}]:`);
    for (const x of op.rows)
      lines.push(
        `${x.strike} CE ${r(x.ce?.ltp)} iv${r(x.ce?.iv, 1)} d${r(x.ce?.delta, 2)} | PE ${r(x.pe?.ltp)} iv${r(x.pe?.iv, 1)} d${r(x.pe?.delta, 2)}`,
      );
  } else lines.push('Options: no live option prices; give spot levels and the strike to buy.');
  if (o.openTrade) {
    const t = o.openTrade;
    lines.push(`OPEN trade: ${t.option} entry ${t.entry}${t.stopLoss ? ` SL ${t.stopLoss}` : ''}${t.target ? ` target ${t.target}` : ''} since ${ist(t.since)} IST`);
  }
  return lines.join('\n');
}

/** Reads the model's JSON reply (tolerating code fences or stray text around it). */
export function parseSignal(text: string): TradeSignal | undefined {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ''));
  if (!m) return undefined;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const a = String(j.a ?? j.action ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '_') as SignalAction;
  if (!SIGNAL_ACTIONS.includes(a)) return undefined;
  const s = (k: string, ...alt: string[]) => {
    for (const key of [k, ...alt]) {
      const v = j[key];
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim().slice(0, 160);
    }
    return undefined;
  };
  return { action: a, option: s('opt', 'option'), entry: s('entry'), target: s('target', 'exit'), stopLoss: s('sl', 'stoploss', 'stop_loss'), note: s('note'), news: s('news') };
}

export const NEWS_SYSTEM = `You are a markets news analyst for Indian index, stock and commodity futures and options (NSE, BSE, MCX) and their global drivers.
For a question about an instrument, search the latest news (newest first, last 72 hours preferred) including the global drivers that move it, e.g.:
NIFTY/BANKNIFTY/SENSEX: FII/DII flows, RBI, US Fed, US yields, crude, global indices, big earnings, India macro data.
Natural gas: US storage (EIA), weather forecasts, LNG exports, Henry Hub, Europe TTF, production.
Crude oil: OPEC+, US inventories, geopolitics, demand data, USD. Gold/silver: Fed, USD, yields, ETF flows, geopolitics.
Use the HEADLINES given (and a search tool if you have one). Judge each item: credible (Reuters, Bloomberg, ET, Mint, Business Standard, CNBC, RBI, EIA, exchange or company filings; or corroborated) or unverified/rumour (unknown sites, social media); ignore stale or irrelevant items. If no headline covers the question, say so.
Reply in this short format only:
Direction: Bullish/Bearish/Neutral (confidence %), horizon
• headline — source, date — impact ↑/↓ — credible/unverified (max 4)
Watch: upcoming events with dates (max 3)
No intro, no filler, no disclaimers. If asked something else, answer briefly.`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  imageBase64?: string;
  mediaType?: string;
}

/** Keeps only the last `max` turns (and drops images from all but the latest turn) to save tokens. */
export function trimHistory(turns: ChatTurn[], max = 6): ChatTurn[] {
  const kept = turns.slice(-max);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept.map((t, i) => (i === kept.length - 1 ? t : { role: t.role, text: t.text }));
}

/** "NSE OPEN, 75 min to close (09:15–15:30 IST)" or "NSE CLOSED (09:15–15:30 IST); next open Mon 01 Dec 09:15 IST". */
export function sessionText(exchange: OptionExchange, now: number): { open: boolean; text: string; nextOpen: number } {
  const s = sessionInfo(exchange, now);
  if (s.open) return { open: true, text: `${exchange} OPEN, ${s.minutesToClose} min to close (${s.hours})`, nextOpen: s.nextOpen };
  const d = new Date((s.nextOpen + 19800) * 1000);
  // Built by hand so the text is identical in Node and Electron (no locale differences).
  const day = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].at(d.getUTCDay())} ${String(d.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].at(d.getUTCMonth())}`;
  const hm = d.toISOString().slice(11, 16);
  return { open: false, text: `${exchange} CLOSED (${s.hours}); next open ${day} ${hm} IST`, nextOpen: s.nextOpen };
}
