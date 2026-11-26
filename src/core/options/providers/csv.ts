/**
 * Option-chain CSV import (offline fallback). Accepts:
 * - The CSV the NSE website's option-chain page lets a person download (calls left of STRIKE,
 *   puts right, both sides with OI, CHNG IN OI, VOLUME, IV, LTP, CHNG, BID QTY, BID, ASK, ASK QTY;
 *   OI in contracts; "-" for empty cells). File names look like option-chain-ED-NIFTY-25-Nov-2025.csv.
 * - Any CSV with a strike column and side-prefixed columns such as call_oi / CE OI / put_ltp / PE IV.
 */
import { normalizeRows, withDerived } from '../option-contracts';
import type { QuoteField } from '../option-chain';
import type { OptionQuote, StrikeRow } from '../types';

export interface ParsedOptionCsv {
  rows: StrikeRow[];
  layout: 'nse' | 'generic';
  /** From the file name when it follows the NSE pattern. */
  symbol?: string;
  expiry?: string;
  /** NSE's download counts OI in contracts (lots). */
  oiUnitHint?: 'lots' | 'units';
}

/** Splits one CSV line, honouring double quotes. */
export function splitCsvLine(line: string, sep = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === sep && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** "1,23,456.50" → 123456.5; "-", "", "--" → undefined. */
export function parseCsvNumber(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.replace(/[",\s]/g, '');
  if (!t || /^-+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const FIELD_ALIASES: Record<string, QuoteField> = {
  oi: 'oi',
  openinterest: 'oi',
  chnginoi: 'oiChange',
  changeinoi: 'oiChange',
  oichange: 'oiChange',
  chngoi: 'oiChange',
  volume: 'volume',
  vol: 'volume',
  iv: 'iv',
  impliedvolatility: 'iv',
  ltp: 'ltp',
  lastprice: 'ltp',
  chng: 'change',
  change: 'change',
  netchng: 'change',
  pricechange: 'change',
  bidqty: 'bidQty',
  bidquantity: 'bidQty',
  bid: 'bidPrice',
  bidprice: 'bidPrice',
  ask: 'askPrice',
  askprice: 'askPrice',
  askqty: 'askQty',
  askquantity: 'askQty',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Reads underlying and expiry from an NSE download name such as option-chain-ED-NIFTY-25-Nov-2025.csv. */
export function parseNseCsvName(name: string): { symbol?: string; expiry?: string } {
  const m = /option-chain-[A-Z]{2}-(.+?)-(\d{1,2})-([A-Za-z]{3})-(\d{4})/i.exec(name);
  if (!m) return {};
  const mon = MONTHS.indexOf(m[3].toLowerCase());
  if (mon < 0) return { symbol: m[1].toUpperCase() };
  return { symbol: m[1].toUpperCase(), expiry: `${m[4]}-${String(mon + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}` };
}

export function parseOptionChainCsv(text: string, fileName = ''): ParsedOptionCsv {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = (lines[0]?.match(/;/g)?.length ?? 0) > (lines[0]?.match(/,/g)?.length ?? 0) ? ';' : ',';
  const headerAt = lines.findIndex((l) => splitCsvLine(l, sep).some((c) => /^strike( ?price)?$/i.test(c.trim())));
  if (headerAt < 0) throw new Error('No STRIKE column found. The CSV needs a strike column with call and put columns around it.');
  const header = splitCsvLine(lines[headerAt], sep);
  const strikeCol = header.findIndex((c) => /^strike( ?price)?$/i.test(c.trim()));
  const nseLayout = /calls/i.test(lines[headerAt - 1] ?? '') || (header.filter((h) => norm(h) === 'oi').length === 2 && !header.some((h) => /^(call|put|ce|pe)/i.test(h.trim())));

  const cols: { i: number; side: 'call' | 'put'; field: QuoteField }[] = [];
  header.forEach((h, i) => {
    if (i === strikeCol) return;
    let n = norm(h);
    let side: 'call' | 'put' | undefined;
    const pre = /^(calls?|ce|puts?|pe)/.exec(n);
    if (pre && !nseLayout) {
      side = pre[1].startsWith('c') ? 'call' : 'put';
      n = n.slice(pre[1].length);
    } else side = i < strikeCol ? 'call' : 'put';
    const field = FIELD_ALIASES[n];
    if (field && !cols.some((c) => c.side === side && c.field === field)) cols.push({ i, side, field });
  });
  if (!cols.some((c) => c.field === 'oi' || c.field === 'ltp')) throw new Error('No OI or LTP columns recognised next to the STRIKE column.');

  const rows: StrikeRow[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    const cells = splitCsvLine(line, sep);
    const strike = parseCsvNumber(cells[strikeCol]);
    if (strike === undefined) continue;
    const call: OptionQuote = {};
    const put: OptionQuote = {};
    let hasC = false;
    let hasP = false;
    for (const c of cols) {
      const v = parseCsvNumber(cells[c.i]);
      if (v === undefined) continue;
      if (c.side === 'call') {
        call[c.field] = v;
        hasC = true;
      } else {
        put[c.field] = v;
        hasP = true;
      }
    }
    rows.push({ strike, call: hasC ? withDerived(call) : undefined, put: hasP ? withDerived(put) : undefined });
  }
  if (!rows.length) throw new Error('The CSV has no strike rows.');
  const named = parseNseCsvName(fileName);
  return { rows: normalizeRows(rows), layout: nseLayout ? 'nse' : 'generic', ...named, oiUnitHint: nseLayout ? 'lots' : undefined };
}
