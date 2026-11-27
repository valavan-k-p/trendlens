import { mkdtempSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUpstoxChain, parseUpstoxInstruments, upstoxChainUrl, upstoxError } from '@core/options/providers/upstox';
import { dhanChainRequest, dhanError, parseDhanChain, parseDhanScripMaster } from '@core/options/providers/dhan';
import { parseCsvNumber, parseNseCsvName, parseOptionChainCsv, splitCsvLine } from '@core/options/providers/csv';
import { compareChains, fromSnapshot, shouldSnapshot, snapshotKey, toSnapshot } from '@core/options/option-snapshots';
import { summarizeChain } from '@core/options/option-analytics';
import { inLots } from '@core/options/option-chain';
import { SnapshotStore } from '../src/main/options/snapshot-store';
import type { OptionChain, OptionUnderlying } from '@core/options/types';

const NOW = Date.UTC(2026, 10, 26, 5, 0) / 1000; // Thu 26 Nov 2026, 10:30 IST
const exp = (d: string) => Date.parse(`${d}T18:29:59Z`); // Upstox stores expiry as 23:59:59 IST

describe('Upstox instrument master', () => {
  const records = [
    { segment: 'NSE_INDEX', name: 'Nifty 50', instrument_key: 'NSE_INDEX|Nifty 50', instrument_type: 'INDEX' },
    { segment: 'NSE_EQ', name: 'RELIANCE INDUSTRIES LTD', instrument_key: 'NSE_EQ|INE002A01018', instrument_type: 'EQ' },
    { segment: 'NSE_FO', instrument_type: 'CE', underlying_key: 'NSE_INDEX|Nifty 50', underlying_symbol: 'NIFTY', underlying_type: 'INDEX', lot_size: 65, expiry: exp('2026-12-01'), strike_price: 26000 },
    { segment: 'NSE_FO', instrument_type: 'PE', underlying_key: 'NSE_INDEX|Nifty 50', underlying_symbol: 'NIFTY', underlying_type: 'INDEX', lot_size: 65, expiry: exp('2026-12-08'), strike_price: 26000 },
    { segment: 'NSE_FO', instrument_type: 'CE', underlying_key: 'NSE_INDEX|Nifty 50', underlying_symbol: 'NIFTY', underlying_type: 'INDEX', lot_size: 65, expiry: exp('2026-11-24'), strike_price: 26000 },
    { segment: 'NSE_FO', instrument_type: 'FUT', underlying_key: 'NSE_INDEX|Nifty 50', underlying_symbol: 'NIFTY', underlying_type: 'INDEX', lot_size: 65, expiry: exp('2026-12-29') },
    { segment: 'NSE_FO', instrument_type: 'CE', underlying_key: 'NSE_EQ|INE002A01018', underlying_symbol: 'RELIANCE', underlying_type: 'EQUITY', lot_size: 500, expiry: exp('2026-12-29'), strike_price: 1500 },
    { segment: 'NCD_FO', instrument_type: 'CE', underlying_symbol: 'USDINR', underlying_type: 'CUR', lot_size: 1, expiry: exp('2026-12-04') },
  ];

  it('lists option underlyings with lot sizes and open expiries, indices first', () => {
    const list = parseUpstoxInstruments(records, 'NSE', NOW);
    expect(list.map((u) => u.symbol)).toEqual(['NIFTY', 'RELIANCE']);
    expect(list[0]).toMatchObject({ id: 'NSE:NIFTY', name: 'Nifty 50', kind: 'index', lotSize: 65, upstoxKey: 'NSE_INDEX|Nifty 50', expiries: ['2026-12-01', '2026-12-08'] });
    expect(list[1]).toMatchObject({ kind: 'stock', lotSize: 500, name: 'RELIANCE INDUSTRIES LTD', upstoxKey: 'NSE_EQ|INE002A01018' });
    expect(() => parseUpstoxInstruments({}, 'NSE')).toThrow(/not a list/);
  });

  it('groups MCX options by commodity although each expiry has its own futures contract', () => {
    const mcx = [
      { segment: 'MCX_FO', name: 'CRUDE OIL', instrument_type: 'CE', underlying_key: 'MCX_FO|580377', underlying_symbol: 'CRUDEOIL', underlying_type: 'COM', lot_size: 100, expiry: exp('2027-01-15'), strike_price: 8000 },
      { segment: 'MCX_FO', name: 'CRUDE OIL', instrument_type: 'PE', underlying_key: 'MCX_FO|576264', underlying_symbol: 'CRUDEOIL', underlying_type: 'COM', lot_size: 100, expiry: exp('2026-12-16'), strike_price: 8000 },
    ];
    const list = parseUpstoxInstruments(mcx, 'MCX', NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'MCX:CRUDEOIL', name: 'CRUDE OIL', kind: 'commodity', lotSize: 100, expiries: ['2026-12-16', '2027-01-15'], upstoxKey: undefined });
  });

  it('builds the documented chain URL', () => {
    expect(upstoxChainUrl('NSE_INDEX|Nifty 50', '2026-12-01')).toBe('https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=2026-12-01');
  });
});

const nifty: OptionUnderlying = { id: 'NSE:NIFTY', symbol: 'NIFTY', name: 'Nifty 50', exchange: 'NSE', kind: 'index', lotSize: 75, expiries: ['2025-02-13'], upstoxKey: 'NSE_INDEX|Nifty 50' };

describe('Upstox option chain', () => {
  // The example response from Upstox's "Put/Call Option Chain" documentation.
  const doc = {
    status: 'success',
    data: [
      {
        expiry: '2025-02-13',
        pcr: 7515.3,
        strike_price: 21100,
        underlying_key: 'NSE_INDEX|Nifty 50',
        underlying_spot_price: 22976.2,
        call_options: {
          instrument_key: 'NSE_FO|51059',
          market_data: { ltp: 2449.9, volume: 0, oi: 750, close_price: 2449.9, bid_price: 1856.65, bid_qty: 1125, ask_price: 1941.65, ask_qty: 1125, prev_oi: 1500 },
          option_greeks: { vega: 4.1731, theta: -472.8941, gamma: 0.0001, delta: 0.743, iv: 262.31, pop: 40.56 },
        },
        put_options: {
          instrument_key: 'NSE_FO|51060',
          market_data: { ltp: 0.3, volume: 22315725, oi: 5636475, close_price: 0.35, bid_price: 0.3, bid_qty: 1979400, ask_price: 0.35, ask_qty: 2152500, prev_oi: 5797500 },
          option_greeks: { vega: 0.0568, theta: -1.2461, gamma: 0, delta: -0.0013, iv: 50.78, pop: 0.15 },
        },
      },
    ],
  };

  it('parses every column of the documented example', () => {
    const c = parseUpstoxChain(doc, nifty, '2025-02-13', NOW);
    expect(c).toMatchObject({ provider: 'upstox', underlyingPrice: 22976.2, oiUnit: 'units', underlyingIsFutures: false, expiry: '2025-02-13' });
    const r = c.rows[0];
    expect(r.strike).toBe(21100);
    expect(r.call).toMatchObject({ ltp: 2449.9, prevClose: 2449.9, change: 0, oi: 750, prevOi: 1500, oiChange: -750, volume: 0, bidPrice: 1856.65, bidQty: 1125, askPrice: 1941.65, askQty: 1125, iv: 262.31 });
    expect(r.call!.greeks).toEqual({ delta: 0.743, gamma: 0.0001, theta: -472.8941, vega: 4.1731 });
    expect(r.put!.change).toBeCloseTo(-0.05, 10);
    expect(r.put!.oiChange).toBe(5636475 - 5797500);
    // The example's per-strike pcr (7515.3) equals put OI / call OI, and 750 units = 10 lots of 75: OI is in units.
    expect(r.put!.oi! / r.call!.oi!).toBeCloseTo(7515.3, 1);
    expect(inLots(r.call!.oi, c)).toBe(10);
  });

  it('surfaces documented error bodies', () => {
    const body = { status: 'error', errors: [{ errorCode: 'UDAPI100011', message: 'Invalid Instrument key' }] };
    expect(upstoxError(body)).toBe('Invalid Instrument key (UDAPI100011)');
    expect(() => parseUpstoxChain(body, nifty, '2025-02-13', NOW)).toThrow(/UDAPI100011/);
    expect(() => parseUpstoxChain({ status: 'success' }, nifty, '2025-02-13', NOW)).toThrow(/no data/);
  });
});

describe('Dhan', () => {
  const HEADER =
    'EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE';
  const line = (o: Record<string, string | number>) => HEADER.split(',').map((h) => o[h] ?? 'NA').join(',');
  const csv = [
    HEADER,
    line({ EXCH_ID: 'NSE', SEGMENT: 'I', SECURITY_ID: 13, INSTRUMENT: 'INDEX', UNDERLYING_SECURITY_ID: 13, UNDERLYING_SYMBOL: 'NIFTY', DISPLAY_NAME: 'Nifty 50', LOT_SIZE: 1, SM_EXPIRY_DATE: '0001-01-01' }),
    line({ EXCH_ID: 'NSE', SEGMENT: 'D', SECURITY_ID: 35028, INSTRUMENT: 'OPTIDX', UNDERLYING_SECURITY_ID: 26000, UNDERLYING_SYMBOL: 'NIFTY', LOT_SIZE: 65, SM_EXPIRY_DATE: '2026-12-01', STRIKE_PRICE: 20000, OPTION_TYPE: 'CE' }),
    line({ EXCH_ID: 'NSE', SEGMENT: 'D', SECURITY_ID: 35029, INSTRUMENT: 'OPTIDX', UNDERLYING_SECURITY_ID: 26000, UNDERLYING_SYMBOL: 'NIFTY', LOT_SIZE: 65, SM_EXPIRY_DATE: '2026-11-24', STRIKE_PRICE: 20000, OPTION_TYPE: 'PE' }),
    line({ EXCH_ID: 'NSE', SEGMENT: 'D', SECURITY_ID: 41000, INSTRUMENT: 'OPTSTK', UNDERLYING_SECURITY_ID: 2885, UNDERLYING_SYMBOL: 'RELIANCE', LOT_SIZE: 500, SM_EXPIRY_DATE: '2026-12-29', STRIKE_PRICE: 1500, OPTION_TYPE: 'CE' }),
    line({ EXCH_ID: 'MCX', SEGMENT: 'M', SECURITY_ID: 576264, INSTRUMENT: 'FUTCOM', UNDERLYING_SECURITY_ID: 294, UNDERLYING_SYMBOL: 'CRUDEOIL', LOT_SIZE: 1, SM_EXPIRY_DATE: '2026-12-18' }),
    line({ EXCH_ID: 'MCX', SEGMENT: 'M', SECURITY_ID: 580377, INSTRUMENT: 'FUTCOM', UNDERLYING_SECURITY_ID: 294, UNDERLYING_SYMBOL: 'CRUDEOIL', LOT_SIZE: 1, SM_EXPIRY_DATE: '2027-01-19' }),
    line({ EXCH_ID: 'MCX', SEGMENT: 'M', SECURITY_ID: 585905, INSTRUMENT: 'OPTFUT', UNDERLYING_SECURITY_ID: 294, UNDERLYING_SYMBOL: 'CRUDEOIL', LOT_SIZE: 1, SM_EXPIRY_DATE: '2026-12-16', STRIKE_PRICE: 8350, OPTION_TYPE: 'CE' }),
    line({ EXCH_ID: 'MCX', SEGMENT: 'M', SECURITY_ID: 590001, INSTRUMENT: 'OPTFUT', UNDERLYING_SECURITY_ID: 294, UNDERLYING_SYMBOL: 'CRUDEOIL', LOT_SIZE: 1, SM_EXPIRY_DATE: '2027-01-15', STRIKE_PRICE: 8350, OPTION_TYPE: 'CE' }),
  ].join('\n');

  it('maps index, stock and MCX underlyings to the ids the option-chain API expects', () => {
    const list = parseDhanScripMaster(csv, NOW);
    const nifty = list.find((u) => u.symbol === 'NIFTY')!;
    expect(nifty).toMatchObject({ exchange: 'NSE', kind: 'index', lotSize: 65, name: 'Nifty 50', expiries: ['2026-12-01'], dhan: { scrip: 13, seg: 'IDX_I' } });
    expect(list.find((u) => u.symbol === 'RELIANCE')!.dhan).toEqual({ scrip: 2885, seg: 'NSE_EQ' });
    const crude = list.find((u) => u.symbol === 'CRUDEOIL')!;
    expect(crude).toMatchObject({ exchange: 'MCX', kind: 'commodity', lotSize: undefined, expiries: ['2026-12-16', '2027-01-15'] });
    expect(crude.dhan!.futuresByExpiry).toEqual({ '2026-12-16': 576264, '2027-01-15': 580377 });
    expect(dhanChainRequest(crude, '2027-01-15')).toEqual({ UnderlyingScrip: 580377, UnderlyingSeg: 'MCX_COMM', Expiry: '2027-01-15' });
    expect(dhanChainRequest(nifty, '2026-12-01')).toEqual({ UnderlyingScrip: 13, UnderlyingSeg: 'IDX_I', Expiry: '2026-12-01' });
    expect(() => parseDhanScripMaster('A,B\n1,2')).toThrow(/missing the EXCH_ID/);
  });

  it('parses the documented option-chain example', () => {
    // The illustrative response from Dhan's "Option Chain" documentation (NIFTY 13, one strike shown).
    const body = {
      data: {
        last_price: 25812.4,
        oc: {
          '25800.000000': {
            ce: { average_price: 138.6, greeks: { delta: 0.52, theta: -14.8, gamma: 0.0011, vega: 12.6 }, implied_volatility: 13.7, last_price: 140.2, oi: 6234500, previous_close_price: 151.3, previous_oi: 5987000, previous_volume: 98234500, security_id: 42528, top_ask_price: 140.3, top_ask_quantity: 750, top_bid_price: 140.1, top_bid_quantity: 1125, volume: 112345000 },
            pe: { average_price: 126.4, greeks: { delta: -0.48, theta: -12.9, gamma: 0.0011, vega: 12.6 }, implied_volatility: 13.9, last_price: 124.8, oi: 5876250, previous_close_price: 118.2, previous_oi: 5612000, previous_volume: 87456000, security_id: 42529, top_ask_price: 124.9, top_ask_quantity: 600, top_bid_price: 124.7, top_bid_quantity: 900, volume: 104567000 },
          },
        },
      },
      status: 'success',
    };
    const u: OptionUnderlying = { id: 'NSE:NIFTY', symbol: 'NIFTY', name: 'Nifty 50', exchange: 'NSE', kind: 'index', lotSize: 65, expiries: ['2026-11-17'], dhan: { scrip: 13, seg: 'IDX_I' } };
    const c = parseDhanChain(body, u, '2026-11-17', NOW);
    expect(c).toMatchObject({ provider: 'dhan', underlyingPrice: 25812.4, oiUnit: 'units', underlyingIsFutures: false });
    expect(c.rows[0].strike).toBe(25800);
    expect(c.rows[0].call).toMatchObject({ ltp: 140.2, change: 140.2 - 151.3, oi: 6234500, oiChange: 247500, bidPrice: 140.1, bidQty: 1125, askPrice: 140.3, askQty: 750, iv: 13.7, instrumentKey: '42528' });
    expect(c.rows[0].put!.greeks).toEqual({ delta: -0.48, gamma: 0.0011, theta: -12.9, vega: 12.6 });
    expect(dhanError({ errorType: 'RATE_LIMIT_ERROR', errorCode: 'RL001', errorMessage: 'Too many requests. Please retry after 1 second.' })).toBe('Too many requests. Please retry after 1 second. (RL001)');
    expect(() => parseDhanChain({ status: 'success', data: {} }, u, '2026-11-17', NOW)).toThrow(/no "oc"/);
  });

  it('treats MCX chains as options on futures with OI in lots', () => {
    const u: OptionUnderlying = { id: 'MCX:CRUDEOIL', symbol: 'CRUDEOIL', name: 'CRUDEOIL', exchange: 'MCX', kind: 'commodity', expiries: ['2026-12-16'], dhan: { scrip: 576264, seg: 'MCX_COMM', futuresByExpiry: { '2026-12-16': 576264 } } };
    const c = parseDhanChain({ status: 'success', data: { last_price: 6210, oc: { '6200.000000': { ce: { last_price: 150, oi: 1200 } } } } }, u, '2026-12-16', NOW);
    expect(c).toMatchObject({ underlyingIsFutures: true, oiUnit: 'lots', underlyingPrice: 6210 });
    expect(c.notes?.[0]).toMatch(/lots/);
  });
});

describe('option-chain CSV import', () => {
  it('reads the NSE website download layout and file name', () => {
    const text = [
      ',CALLS,,,,,,,,,,,PUTS,,,,,,,,,,',
      ',OI,CHNG IN OI,VOLUME,IV,LTP,CHNG,BID QTY,BID,ASK,ASK QTY,STRIKE,BID QTY,BID,ASK,ASK QTY,CHNG,LTP,IV,VOLUME,CHNG IN OI,OI,',
      ',"1,200",300,"5,000",12.5,"1,050.00",-20.5,75,"1,049.00","1,051.00",150,"24,000.00",300,2.1,2.2,600,-0.4,2.15,18.2,"9,000",-100,"8,000",',
      ',-,-,-,-,-,-,-,-,-,-,"24,100.00",75,3,3.2,150,0.1,3.1,17.9,500,50,700,',
    ].join('\r\n');
    const p = parseOptionChainCsv(text, 'C:\\Downloads\\option-chain-ED-NIFTY-25-Nov-2025.csv');
    expect(p).toMatchObject({ layout: 'nse', symbol: 'NIFTY', expiry: '2025-11-25', oiUnitHint: 'lots' });
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].call).toEqual({ oi: 1200, oiChange: 300, volume: 5000, iv: 12.5, ltp: 1050, change: -20.5, bidQty: 75, bidPrice: 1049, askPrice: 1051, askQty: 150 });
    expect(p.rows[0].put).toEqual({ bidQty: 300, bidPrice: 2.1, askPrice: 2.2, askQty: 600, change: -0.4, ltp: 2.15, iv: 18.2, volume: 9000, oiChange: -100, oi: 8000 });
    expect(p.rows[1].call).toBeUndefined();
    expect(p.rows[1].put?.oi).toBe(700);
  });

  it('reads generic side-prefixed columns', () => {
    const p = parseOptionChainCsv('Strike,Call OI,Call LTP,CE IV,Put OI,PE LTP,put_chng_in_oi\n100,10,5.5,20,20,1.2,-3\n90,4,12,22,30,0.5,7\n');
    expect(p.layout).toBe('generic');
    expect(p.rows.map((r) => r.strike)).toEqual([90, 100]);
    expect(p.rows[1]).toEqual({ strike: 100, call: { oi: 10, ltp: 5.5, iv: 20 }, put: { oi: 20, ltp: 1.2, oiChange: -3 } });
  });

  it('explains files it cannot use', () => {
    expect(() => parseOptionChainCsv('a,b\n1,2')).toThrow(/STRIKE/);
    expect(() => parseOptionChainCsv('strike,foo\n1,2')).toThrow(/OI or LTP/);
  });

  it('handles quotes, Indian digit grouping and empty markers', () => {
    expect(splitCsvLine('a,"b,c","d ""e"""')).toEqual(['a', 'b,c', 'd "e"']);
    expect(parseCsvNumber('"1,23,456.50"')).toBe(123456.5);
    expect(parseCsvNumber('-')).toBeUndefined();
    expect(parseCsvNumber('')).toBeUndefined();
    expect(parseNseCsvName('option-chain-EQ-RELIANCE-30-Dec-2025.csv')).toEqual({ symbol: 'RELIANCE', expiry: '2025-12-30' });
    expect(parseNseCsvName('chain.csv')).toEqual({});
  });
});

const sampleChain = (t: number, callOi: number, putOi: number): OptionChain => ({
  provider: 'upstox',
  exchange: 'NSE',
  symbol: 'NIFTY',
  underlyingId: 'NSE:NIFTY',
  expiry: '2026-12-01',
  expiryTime: Date.UTC(2026, 11, 1, 10, 0) / 1000,
  underlyingPrice: 25030,
  underlyingIsFutures: false,
  lotSize: 65,
  oiUnit: 'units',
  fetchedAt: t,
  rows: [
    { strike: 25000, call: { oi: callOi, ltp: 120, iv: 12 }, put: { oi: putOi, ltp: 90, iv: 13 } },
    { strike: 25100, call: { oi: callOi * 2, ltp: 70 } },
  ],
});

describe('snapshots', () => {
  it('round-trips a chain through the compact snapshot format', () => {
    const c = sampleChain(NOW, 1000, 1500);
    const s = toSnapshot(c, { spot: 25030, pcrOi: 0.5, callOi: 3000, putOi: 1500, maxPain: 25000 });
    const back = fromSnapshot(JSON.parse(JSON.stringify(s)));
    expect(back.provider).toBe('snapshot');
    expect(back.rows).toEqual(c.rows);
    expect(back).toMatchObject({ symbol: 'NIFTY', expiry: '2026-12-01', underlyingPrice: 25030, lotSize: 65, fetchedAt: NOW });
  });

  it('compares OI and IV strike by strike over the union of strikes', () => {
    const later = sampleChain(NOW, 1300, 1400);
    later.rows[0].call!.iv = 12.6;
    const earlier = sampleChain(NOW - 600, 1000, 1500);
    earlier.rows.push({ strike: 25200, call: { oi: 5 } });
    const cmp = compareChains(later, earlier);
    expect(cmp.map((x) => x.strike)).toEqual([25000, 25100, 25200]);
    expect(cmp[0]).toMatchObject({ callOiDiff: 300, putOiDiff: -100 });
    expect(cmp[0].callIvDiff).toBeCloseTo(0.6, 10);
    expect(cmp[1].callOiDiff).toBe(600);
    expect(cmp[2].callOiDiff).toBeUndefined();
  });

  it('saves on the configured interval only', () => {
    expect(shouldSnapshot(undefined, 1000, 60)).toBe(true);
    expect(shouldSnapshot(970, 1000, 60)).toBe(false);
    expect(shouldSnapshot(940, 1000, 60)).toBe(true);
    expect(shouldSnapshot(undefined, 1000, 0)).toBe(false);
    expect(snapshotKey('NSE', 'M&M', '2026-12-29')).toBe('NSE_M&M_2026-12-29');
    expect(snapshotKey('BSE', 'S/X', '2026-12-29')).toBe('BSE_S_X_2026-12-29');
  });

  it('persists, lists, loads and survives a torn line on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trendlens-snap-'));
    const store = new SnapshotStore(dir);
    const mk = (t: number, expiry: string, callOi: number) => {
      const c = { ...sampleChain(t, callOi, 1500), expiry };
      return toSnapshot(c, { ...summarize(c), callOi: 0, putOi: 0 });
    };
    const summarize = (c: OptionChain) => {
      const s = summarizeChain(c);
      return { spot: s.underlying, pcrOi: s.pcr.oi, maxPain: s.maxPain?.strike, atm: s.atm };
    };
    store.save(mk(NOW - 120, '2026-12-01', 1000));
    store.save(mk(NOW - 60, '2026-12-01', 1100));
    store.save(mk(NOW, '2026-12-08', 900));
    // A different underlying whose key starts the same way must not leak in.
    store.save({ ...mk(NOW, '2026-12-01', 1), symbol: 'NIFTYNXT50' });
    appendFileSync(join(dir, 'snapshots', 'NSE_NIFTY_2026-12-01.jsonl'), '{"v":1,"t":12'); // crash mid-write
    expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual(['NSE_NIFTYNXT50_2026-12-01.jsonl', 'NSE_NIFTY_2026-12-01.jsonl', 'NSE_NIFTY_2026-12-08.jsonl']);
    const all = store.list('NSE', 'NIFTY');
    expect(all.map((m) => [m.t, m.expiry])).toEqual([
      [NOW - 120, '2026-12-01'],
      [NOW - 60, '2026-12-01'],
      [NOW, '2026-12-08'],
    ]);
    expect(store.list('NSE', 'NIFTY', '2026-12-08')).toHaveLength(1);
    expect(all[0].summary.pcrOi).toBeCloseTo(1500 / 3000, 10);
    expect(store.load('NSE', 'NIFTY', '2026-12-01', NOW - 60)?.rows[0][1]).toBe(1100);
    expect(store.latestBefore('NSE', 'NIFTY', '2026-12-01', NOW - 60)?.t).toBe(NOW - 120);
    expect(store.load('NSE', 'NIFTY', '2026-12-01', 1)).toBeUndefined();
  });
});
