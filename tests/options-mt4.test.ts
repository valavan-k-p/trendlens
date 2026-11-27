import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultExpiry,
  exchangeOf,
  groupMt4Series,
  mt4Chain,
  parseMt4OptionsExport,
  parseOptionDescription,
  pickUnderlying,
  quotePrice,
  serverOffset,
} from '@core/options/providers/mt4';
import { analyzeGreeks } from '@core/options/iv-analysis';
import { summarizeChain } from '@core/options/option-analytics';

// Shaped like TrendLensFeed 1.10's options.json (symbol names and descriptions as on Omega-MT4 Algo).
const q = (s: string, d: string, b: number, a = b, pc?: number) => ({ s, d, b, a, t: 1795741200, pc: pc ?? 0, dg: 2 });
const EXPORT = JSON.stringify({
  feed: 'TrendLensFeed',
  version: '1.10',
  server_time: 1795741200,
  gmt_time: 1795741200 - 18000,
  connected: true,
  options: [
    q('NFW_C_26000', 'NIFTY 26000 CE Wkly Opt', 43, 43, 38),
    q('NFW_P_26000', 'NIFTY 26000 PE Wkly Opt', 399.6, 399.6, 410),
    q('NFW_C_26100', 'NIFTY 26100 CE Wkly Opt', 21.5),
    q('NF_C_26000', 'NIFTY 26000 CE Opt', 315.5),
    q('NF_P_26000', 'NIFTY 26000 PE Opt', 568.65),
    q('MCRO_C_7900', 'CRUDEOIL 7900 CE Opt', 450, 452.4),
    q('SC_84500', 'SENSEX 84500 CE Opt', 0),
  ],
  underlyings: [
    q('NIFTY#', 'NIFTY Spot Index', 25640.5),
    q('NIFTY', 'NIFTY Fut', 25790),
    q('MCRO', 'CRUDEOIL MCX Fut', 7866),
    q('MCRO#', 'CRUDEOIL MCX Fut Next', 7901),
    q('SENSEX', 'SENSEX Spot Index', 83950.2),
  ],
});

describe('MT4 option export', () => {
  it('parses the EA export and rejects other files', () => {
    const e = parseMt4OptionsExport(EXPORT);
    expect(e).toMatchObject({ version: '1.10', connected: true });
    expect(e.options).toHaveLength(7);
    expect(e.options[0]).toEqual({ symbol: 'NFW_C_26000', description: 'NIFTY 26000 CE Wkly Opt', bid: 43, ask: 43, time: 1795741200, prevClose: 38, digits: 2 });
    expect(e.options[3].prevClose).toBeUndefined(); // 0 = no previous daily close
    expect(serverOffset(e)).toBe(18000); // broker server = UTC+5
    expect(() => parseMt4OptionsExport('{"feed":"Other"}')).toThrow(/not a TrendLensFeed/);
  });

  it('reads strike, type and weekly/monthly from MT4 descriptions', () => {
    expect(parseOptionDescription('NIFTY 26000 CE Wkly Opt')).toEqual({ underlying: 'NIFTY', strike: 26000, type: 'CE', weekly: true });
    expect(parseOptionDescription('BANKNIFTY 62300 PE Opt')).toEqual({ underlying: 'BANKNIFTY', strike: 62300, type: 'PE', weekly: false });
    expect(parseOptionDescription('CRUDEOIL 6500.5 CE Opt')?.strike).toBe(6500.5);
    expect(parseOptionDescription('NIFTY Spot Index')).toBeUndefined();
    expect([exchangeOf('SENSEX'), exchangeOf('CRUDEOIL'), exchangeOf('FINNIFTY')]).toEqual(['BSE', 'MCX', 'NSE']);
  });

  it('groups series and picks spot for index options, the near future for MCX', () => {
    const e = parseMt4OptionsExport(EXPORT);
    const s = groupMt4Series(e);
    expect(s.map((x) => x.key)).toEqual(['CRUDEOIL:M', 'NIFTY:M', 'NIFTY:W', 'SENSEX:M']);
    const wk = s.find((x) => x.key === 'NIFTY:W')!;
    expect([...wk.calls.keys()]).toEqual([26000, 26100]);
    expect(pickUnderlying(wk, e.underlyings)).toMatchObject({ price: 25640.5, futures: false, quote: { symbol: 'NIFTY#' } });
    const crude = s.find((x) => x.key === 'CRUDEOIL:M')!;
    expect(pickUnderlying(crude, e.underlyings)).toMatchObject({ price: 7866, futures: true, quote: { symbol: 'MCRO' } });
    expect(pickUnderlying({ underlying: 'FINNIFTY', exchange: 'NSE' }, e.underlyings)).toBeUndefined();
    // No BANKNIFTY spot: the monthly series uses the near-month future (its forward); a weekly series does not.
    const unds = [...e.underlyings, { symbol: 'BANKNIFTY', description: 'BANKNIFTY Fut', bid: 63410, ask: 63410, time: 0, digits: 2 }];
    expect(pickUnderlying({ underlying: 'BANKNIFTY', exchange: 'NSE', weekly: false }, unds)).toMatchObject({ price: 63410, futures: true });
    expect(pickUnderlying({ underlying: 'BANKNIFTY', exchange: 'NSE', weekly: true }, unds)).toBeUndefined();
    // With a spot quote available, the spot wins even for monthly options.
    expect(pickUnderlying({ underlying: 'NIFTY', exchange: 'NSE', weekly: false }, e.underlyings)?.quote.symbol).toBe('NIFTY#');
  });

  it('takes equal bid/ask as the traded price and keeps real two-sided quotes', () => {
    expect(quotePrice({ bid: 43, ask: 43 })).toBe(43);
    expect(quotePrice({ bid: 450, ask: 452.4 })).toBeCloseTo(451.2, 10);
    expect(quotePrice({ bid: 0, ask: 0 })).toBeUndefined();
    expect(quotePrice({ bid: 5, ask: 4 })).toBeUndefined();
  });

  it('assumes nearest weekly or nearest monthly expiry from the contract list', () => {
    const u = { expiries: ['2026-12-01', '2026-12-08', '2026-12-29'], monthlyExpiries: ['2026-12-29'] };
    expect(defaultExpiry({ weekly: true }, u)).toBe('2026-12-01');
    expect(defaultExpiry({ weekly: false }, u)).toBe('2026-12-29');
    expect(defaultExpiry({ weekly: false }, { expiries: ['2026-12-16'] })).toBe('2026-12-16');
    expect(defaultExpiry({ weekly: true }, undefined)).toBeUndefined();
  });

  it('builds a price-only chain the Greeks engine can use', () => {
    const e = parseMt4OptionsExport(EXPORT);
    const wk = groupMt4Series(e).find((x) => x.key === 'NIFTY:W')!;
    const c = mt4Chain(wk, e, { expiry: '2026-12-01', lotSize: 65, underlying: pickUnderlying(wk, e.underlyings), expiryAssumed: true });
    expect(c).toMatchObject({ provider: 'mt4', exchange: 'NSE', symbol: 'NIFTY', underlyingPrice: 25640.5, underlyingIsFutures: false, lotSize: 65, fetchedAt: 1795741200 - 18000 });
    expect(c.rows.map((r) => r.strike)).toEqual([26000, 26100]);
    expect(c.rows[0].call).toEqual({ instrumentKey: 'NFW_C_26000', ltp: 43, prevClose: 38, change: 5 });
    expect(c.rows[0].put?.change).toBeCloseTo(-10.4, 10);
    expect(c.rows[1].put).toBeUndefined();
    expect(c.notes?.join(' ')).toMatch(/prices only/);
    expect(c.notes?.join(' ')).toMatch(/2026-12-01 is assumed \(nearest weekly/);
    // No OI anywhere: OI figures stay empty instead of showing zeros as data.
    const s = summarizeChain(c);
    expect(s.maxPain).toBeUndefined();
    expect(s.pcr.oi).toBeUndefined();
    // IV is calculated from the price.
    const g = analyzeGreeks(c, { r: 0.065, qFallback: 0, now: c.fetchedAt });
    expect(g.rows[0].call?.iv?.source).toBe('calculated');
    expect(g.rows[0].call?.iv?.value).toBeGreaterThan(1);

    const crude = groupMt4Series(e).find((x) => x.key === 'CRUDEOIL:M')!;
    const cc = mt4Chain(crude, e, { expiry: '2026-12-16', underlying: pickUnderlying(crude, e.underlyings), expiryAssumed: false });
    expect(cc.underlyingIsFutures).toBe(true);
    expect(cc.rows[0].call).toMatchObject({ bidPrice: 450, askPrice: 452.4 });
    expect(cc.rows[0].call?.ltp).toBeUndefined();
    expect(cc.notes?.join(' ')).not.toMatch(/assumed/);
  });
});

describe('bundled TrendLensFeed 1.10 option export', () => {
  const src = readFileSync(resolve(__dirname, '..', 'resources', 'mt4', 'TrendLensFeed.mq4'), 'utf8');
  it('writes options.json with the fields TrendLens parses', () => {
    expect(src).toContain('#define FEED_VERSION  "1.10"');
    expect(src).toContain('OUT_DIR + "options.json"');
    for (const k of ['\\"s\\":', '\\"d\\":', '\\"b\\":', '\\"a\\":', '\\"t\\":', '\\"pc\\":', '\\"dg\\":', '\\"options\\":[', '\\"underlyings\\":[', '\\"gmt_time\\":']) expect(src, k).toContain(k);
  });
});
