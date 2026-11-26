import { describe, expect, it } from 'vitest';
import { impliedVolatility, normCdf, parityForward, priceGreeks, type ModelInput } from '@core/options/option-greeks';
import { maxPain } from '@core/options/max-pain';
import { pcrSet, ratio } from '@core/options/pcr';
import { atmStrike, filterRows, inLots, moneyness, sortRows, strikeWindow } from '@core/options/option-chain';
import { summarizeChain } from '@core/options/option-analytics';
import { buildupByStrike, classifyBuildup, oiConcentration, supportResistance, writingLabel } from '@core/options/oi-analysis';
import { activeExpiries, chainFreshness, daysToExpiry, expiryMoment, istDate, marketSession, yearsToExpiry } from '@core/options/option-contracts';
import { analyzeGreeks, impliedForwardFromParity, ivRankPercentile, ivSkew, ivSmile } from '@core/options/iv-analysis';
import type { OptionChain, StrikeRow } from '@core/options/types';

const row = (strike: number, c?: Partial<NonNullable<StrikeRow['call']>>, p?: Partial<NonNullable<StrikeRow['put']>>): StrikeRow => ({ strike, call: c, put: p });

describe('normal distribution', () => {
  it('matches reference CDF values to 1e-9', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 9);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 9);
    expect(normCdf(-8)).toBeCloseTo(6.22096057e-16, 20);
  });
});

describe('Black-Scholes', () => {
  it('prices Hull’s textbook example (S=42, K=40, r=10%, σ=20%, T=0.5): call 4.76, put 0.81', () => {
    const base = { S: 42, K: 40, r: 0.1, sigma: 0.2, T: 0.5, model: 'black-scholes' as const };
    expect(priceGreeks({ ...base, type: 'call' }).price).toBeCloseTo(4.76, 2);
    expect(priceGreeks({ ...base, type: 'put' }).price).toBeCloseTo(0.81, 2);
  });

  it('reproduces Hull’s Greeks example (S=49, K=50, r=5%, σ=20%, T=20 weeks)', () => {
    const g = priceGreeks({ type: 'call', S: 49, K: 50, r: 0.05, sigma: 0.2, T: 20 / 52, model: 'black-scholes' });
    expect(g.delta).toBeCloseTo(0.522, 2);
    expect(g.gamma).toBeCloseTo(0.066, 2);
    expect(g.theta).toBeCloseTo(-4.31, 1); // per year
    expect(g.vega).toBeCloseTo(12.1, 1); // per 1.00 of volatility
    expect(g.rho).toBeCloseTo(8.91, 1);
  });

  it('satisfies put-call parity with a dividend yield', () => {
    const i = { S: 25000, K: 25500, r: 0.065, q: 0.012, sigma: 0.14, T: 21 / 365, model: 'black-scholes' as const };
    const c = priceGreeks({ ...i, type: 'call' }).price;
    const p = priceGreeks({ ...i, type: 'put' }).price;
    expect(c - p).toBeCloseTo(i.S * Math.exp(-i.q * i.T) - i.K * Math.exp(-i.r * i.T), 8);
    expect(parityForward(i.K, c, p, i.r, i.T)).toBeCloseTo(i.S * Math.exp((i.r - i.q) * i.T), 6);
  });
});

describe('Black-76', () => {
  it('prices Hull’s futures-option example (F=K=20, r=9%, σ=25%, T=4 months): put 1.12', () => {
    const g = priceGreeks({ type: 'put', S: 20, K: 20, r: 0.09, sigma: 0.25, T: 4 / 12, model: 'black-76' });
    expect(g.price).toBeCloseTo(1.12, 2);
    // At the money on a future, call and put are equal.
    expect(priceGreeks({ type: 'call', S: 20, K: 20, r: 0.09, sigma: 0.25, T: 4 / 12, model: 'black-76' }).price).toBeCloseTo(g.price, 10);
  });
});

describe('Greeks agree with finite differences', () => {
  const cases: ModelInput[] = [
    { type: 'call', S: 25000, K: 25200, T: 0.05, r: 0.065, q: 0.012, sigma: 0.13, model: 'black-scholes' },
    { type: 'put', S: 25000, K: 24800, T: 0.05, r: 0.065, q: 0.012, sigma: 0.16, model: 'black-scholes' },
    { type: 'call', S: 6200, K: 6300, T: 0.06, r: 0.065, sigma: 0.35, model: 'black-76' },
    { type: 'put', S: 6200, K: 6100, T: 0.06, r: 0.065, sigma: 0.38, model: 'black-76' },
  ];
  for (const c of cases) {
    it(`${c.model} ${c.type} K=${c.K}`, () => {
      const g = priceGreeks(c);
      const p = (o: Partial<ModelInput>) => priceGreeks({ ...c, ...o }).price;
      const hS = c.S * 1e-4;
      expect(g.delta).toBeCloseTo((p({ S: c.S + hS }) - p({ S: c.S - hS })) / (2 * hS), 5);
      expect(g.gamma).toBeCloseTo((p({ S: c.S + hS }) - 2 * g.price + p({ S: c.S - hS })) / (hS * hS), 6);
      expect(g.vega).toBeCloseTo((p({ sigma: c.sigma + 1e-5 }) - p({ sigma: c.sigma - 1e-5 })) / 2e-5, 2);
      expect(g.rho).toBeCloseTo((p({ r: c.r + 1e-6 }) - p({ r: c.r - 1e-6 })) / 2e-6, 1);
      // Theta = −∂V/∂T (value decay as time passes).
      expect(g.theta).toBeCloseTo(-(p({ T: c.T + 1e-6 }) - p({ T: c.T - 1e-6 })) / 2e-6, 0);
    });
  }
});

describe('implied volatility', () => {
  it('recovers the volatility used to price, for both models and both sides', () => {
    for (const m of ['black-scholes', 'black-76'] as const)
      for (const type of ['call', 'put'] as const)
        for (const sigma of [0.08, 0.15, 0.45, 1.2]) {
          const i = { type, S: 100, K: 105, T: 0.1, r: 0.06, q: 0.01, model: m };
          const price = priceGreeks({ ...i, sigma }).price;
          expect(impliedVolatility(price, i)).toBeCloseTo(sigma, 6);
        }
  });

  it('refuses prices outside the no-arbitrage bounds', () => {
    const i = { type: 'call' as const, S: 100, K: 90, T: 0.1, r: 0.06, model: 'black-scholes' as const };
    expect(impliedVolatility(5, i)).toBeUndefined(); // below intrinsic ≈ 10.5
    expect(impliedVolatility(150, i)).toBeUndefined(); // above the spot
    expect(impliedVolatility(0, i)).toBeUndefined();
  });
});

describe('Max Pain', () => {
  it('finds the strike with the lowest total payout (hand-worked example 1)', () => {
    // S=100: puts 110:20×10 + 120:10×20 = 400; S=110: calls 100:10×10 + puts 120:10×10 = 200; S=120: calls 200+200 = 400.
    const rows = [row(100, { oi: 10 }, { oi: 30 }), row(110, { oi: 20 }, { oi: 20 }), row(120, { oi: 30 }, { oi: 10 })];
    const mp = maxPain(rows)!;
    expect(mp.strike).toBe(110);
    expect(mp.payout).toBe(200);
    expect(mp.curve.map((p) => p.total)).toEqual([400, 200, 400]);
  });

  it('hand-worked example 2, with a lot-size multiplier', () => {
    // S=90: puts 100:20×10 + 110:10×20 = 400; S=100: call 90:10×10 + put 110:10×10 = 200; S=110: calls 90:10×20 + 100:5×10 = 250.
    const rows = [row(90, { oi: 10 }, { oi: 40 }), row(100, { oi: 5 }, { oi: 20 }), row(110, { oi: 50 }, { oi: 10 })];
    const mp = maxPain(rows, 65)!;
    expect(mp.strike).toBe(100);
    expect(mp.payout).toBe(200 * 65);
    expect(mp.curve[2]).toEqual({ strike: 110, callPayout: 250 * 65, putPayout: 0, total: 250 * 65 });
    // The multiplier never changes which strike wins.
    expect(maxPain(rows, 1)!.strike).toBe(100);
  });

  it('is undefined without open interest', () => {
    expect(maxPain([row(100, { ltp: 1 }, { ltp: 2 })])).toBeUndefined();
  });
});

describe('PCR', () => {
  it('divides put by call totals and refuses a zero call side', () => {
    expect(ratio(300, 200)).toBe(1.5);
    expect(ratio(300, 0)).toBeUndefined();
    const p = pcrSet({ callOi: 200, putOi: 260, callVolume: 1000, putVolume: 700, callOiChange: 50, putOiChange: -10 });
    expect(p.oi).toBeCloseTo(1.3, 10);
    expect(p.volume).toBeCloseTo(0.7, 10);
    expect(p.oiChange).toBeUndefined(); // put OI fell, so a change ratio would mislead
  });
});

describe('strikes: ATM, moneyness, windows, sorting, filtering', () => {
  const rows = [24800, 24900, 25000, 25100, 25200].map((k, i) => row(k, { oi: 10 * (i + 1), ltp: 300 - i * 50 }, { oi: 50 - 10 * i, ltp: 20 + i * 40 }));

  it('picks the nearest strike, the lower one on a tie', () => {
    expect(atmStrike(rows, 25030)).toBe(25000);
    expect(atmStrike(rows, 25050)).toBe(25000);
    expect(atmStrike(rows, 25051)).toBe(25100);
    expect(atmStrike(rows, undefined)).toBeUndefined();
  });

  it('classifies ITM/OTM per side and ATM on both', () => {
    expect(moneyness('call', 24900, 25030, 25000)).toBe('ITM');
    expect(moneyness('put', 24900, 25030, 25000)).toBe('OTM');
    expect(moneyness('call', 25100, 25030, 25000)).toBe('OTM');
    expect(moneyness('put', 25100, 25030, 25000)).toBe('ITM');
    expect(moneyness('put', 25000, 25030, 25000)).toBe('ATM');
  });

  it('keeps n strikes either side of ATM', () => {
    expect(strikeWindow(rows, 25000, 1).map((r) => r.strike)).toEqual([24900, 25000, 25100]);
    expect(strikeWindow(rows, 24800, 1).map((r) => r.strike)).toEqual([24800, 24900]);
    expect(strikeWindow(rows, 25000, 'all')).toHaveLength(5);
  });

  it('sorts by any column with missing values last', () => {
    const withGap = [...rows, row(25300, undefined, { oi: 1 })];
    expect(sortRows(withGap, 'call.oi', 'desc').map((r) => r.strike)).toEqual([25200, 25100, 25000, 24900, 24800, 25300]);
    expect(sortRows(withGap, 'put.oi', 'asc')[0].strike).toBe(25300);
    expect(sortRows([...withGap].reverse(), 'strike').map((r) => r.strike)).toEqual([24800, 24900, 25000, 25100, 25200, 25300]);
  });

  it('filters by search text, range, moneyness and empty rows', () => {
    expect(filterRows(rows, { search: '251' }).map((r) => r.strike)).toEqual([25100]);
    expect(filterRows(rows, { search: '24,900 - 25,100' }).map((r) => r.strike)).toEqual([24900, 25000, 25100]);
    expect(filterRows(rows, { moneyness: 'call-itm' }, 25030).map((r) => r.strike)).toEqual([24800, 24900, 25000]);
    expect(filterRows([...rows, row(26000, { oi: 0 }, {})], { hideEmpty: true })).toHaveLength(5);
  });

  it('converts unit counts to lots only when the lot size is known', () => {
    expect(inLots(750, { oiUnit: 'units', lotSize: 75 })).toBe(10);
    expect(inLots(750, { oiUnit: 'units' })).toBe(750);
    expect(inLots(12, { oiUnit: 'lots', lotSize: 75 })).toBe(12);
  });
});

const chainOf = (rows: StrikeRow[], extra: Partial<OptionChain> = {}): OptionChain => ({
  provider: 'csv',
  exchange: 'NSE',
  symbol: 'TEST',
  underlyingId: 'NSE:TEST',
  expiry: '2026-12-29',
  expiryTime: expiryMoment('2026-12-29', 'NSE'),
  underlyingPrice: 25030,
  underlyingIsFutures: false,
  oiUnit: 'units',
  fetchedAt: 0,
  rows,
  ...extra,
});

describe('chain summary', () => {
  it('totals, PCRs, extremes, ATM and Max Pain from the reported rows', () => {
    const rows = [
      row(24900, { oi: 100, oiChange: 10, volume: 500 }, { oi: 400, oiChange: 120, volume: 900 }),
      row(25000, { oi: 300, oiChange: -20, volume: 800 }, { oi: 350, oiChange: 60, volume: 700 }),
      row(25100, { oi: 600, oiChange: 150, volume: 1200 }, { oi: 50, oiChange: -5, volume: 100 }),
    ];
    const s = summarizeChain(chainOf(rows));
    expect([s.totalCallOi, s.totalPutOi, s.totalCallOiChange, s.totalPutOiChange]).toEqual([1000, 800, 140, 175]);
    expect(s.pcr.oi).toBeCloseTo(0.8, 10);
    expect(s.pcr.volume).toBeCloseTo(1700 / 2500, 10);
    expect(s.maxCallOi).toEqual({ strike: 25100, value: 600 });
    expect(s.maxPutOi).toEqual({ strike: 24900, value: 400 });
    expect(s.maxCallOiAdd).toEqual({ strike: 25100, value: 150 });
    expect(s.maxPutOiAdd).toEqual({ strike: 24900, value: 120 });
    expect(s.atm).toBe(25000);
    expect(s.maxPain?.strike).toBe(25000);
  });
});

describe('OI analysis', () => {
  it('classifies the four build-ups and labels writing as interpretation', () => {
    expect(classifyBuildup(5, 100)).toBe('long-buildup');
    expect(classifyBuildup(-5, 100)).toBe('short-buildup');
    expect(classifyBuildup(5, -100)).toBe('short-covering');
    expect(classifyBuildup(-5, -100)).toBe('long-unwinding');
    expect(classifyBuildup(0, 100)).toBe('none');
    expect(classifyBuildup(undefined, 100)).toBe('none');
    expect(writingLabel('call', 'short-buildup')).toBe('Call writing (interpretation)');
    expect(writingLabel('put', 'short-buildup')).toBe('Put writing (interpretation)');
    expect(writingLabel('put', 'long-buildup')).toBeUndefined();
    expect(buildupByStrike([row(100, { change: -2, oiChange: 50 }, { change: 3, oiChange: -10 })])[0]).toEqual({ strike: 100, call: 'short-buildup', put: 'short-covering' });
  });

  it('finds potential support (put OI below) and resistance (call OI above)', () => {
    const rows = [row(24800, { oi: 5 }, { oi: 900 }), row(24900, { oi: 50 }, { oi: 1500 }), row(25000, { oi: 800 }, { oi: 700 }), row(25100, { oi: 2000 }, { oi: 10 }), row(25200, { oi: 1200 }, { oi: 0 })];
    const sr = supportResistance(rows, 25030, 2);
    expect(sr.supports.map((x) => x.strike)).toEqual([24900, 24800]);
    expect(sr.resistances.map((x) => x.strike)).toEqual([25100, 25200]);
    const conc = oiConcentration(rows, 'call', 2)!;
    expect(conc.strikes).toEqual([25100, 25200]);
    expect(conc.share).toBeCloseTo(3200 / 4055, 10);
  });
});

describe('expiry and session timing', () => {
  it('places NSE expiry at 15:30 IST and MCX at 23:30 IST', () => {
    expect(expiryMoment('2026-12-01', 'NSE')).toBe(Date.UTC(2026, 11, 1, 10, 0) / 1000);
    expect(expiryMoment('2026-12-16', 'MCX')).toBe(Date.UTC(2026, 11, 16, 18, 0) / 1000);
    expect(() => expiryMoment('01-12-2026', 'NSE')).toThrow(/YYYY-MM-DD/);
  });

  it('converts instrument-master expiry timestamps to IST dates', () => {
    expect(istDate(Date.parse('2026-12-01T18:29:59Z'))).toBe('2026-12-01');
  });

  it('measures time to expiry and drops expired series', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0) / 1000;
    const exp = expiryMoment('2026-12-01', 'NSE');
    expect(daysToExpiry(exp, now)).toBeCloseTo(5 + 5 / 24, 10);
    expect(yearsToExpiry(exp, now)).toBeCloseTo((5 + 5 / 24) / 365, 12);
    expect(yearsToExpiry(now - 10, now)).toBeCloseTo(60 / (365 * 86400), 12); // floor of one minute
    expect(activeExpiries(['2026-12-08', '2026-11-24', '2026-11-26', '2026-12-01'], 'NSE', now)).toEqual(['2026-11-26', '2026-12-01', '2026-12-08']);
  });

  it('knows regular market hours and flags stale data', () => {
    const thu1030 = Date.UTC(2026, 10, 26, 5, 0) / 1000; // 10:30 IST
    const thu1630 = Date.UTC(2026, 10, 26, 11, 0) / 1000; // 16:30 IST
    const sat = Date.UTC(2026, 10, 28, 5, 0) / 1000;
    expect(marketSession('NSE', thu1030)).toBe('open');
    expect(marketSession('NSE', thu1630)).toBe('closed');
    expect(marketSession('MCX', thu1630)).toBe('open');
    expect(marketSession('NSE', sat)).toBe('closed');
    expect(chainFreshness(thu1030 - 30, thu1030, 'NSE', 30)).toBe('fresh');
    expect(chainFreshness(thu1030 - 120, thu1030, 'NSE', 30)).toBe('delayed');
    expect(chainFreshness(thu1030 - 400, thu1030, 'NSE', 30)).toBe('stale');
    expect(chainFreshness(thu1630 - 3 * 3600, thu1630, 'NSE', 30)).toBe('fresh'); // closing data after hours
  });
});

describe('chain IV and Greeks', () => {
  const now = Date.UTC(2026, 10, 26, 5, 0) / 1000;
  const T = 30 / 365;
  const S = 25000;
  const r = 0.065;
  const q = 0.012;
  const strikes = Array.from({ length: 21 }, (_, i) => 24000 + i * 100);
  const priced = (vol: (k: number) => number) =>
    chainOf(
      strikes.map((K) => {
        const i = { S, K, T, r, q, sigma: vol(K), model: 'black-scholes' as const };
        return row(K, { ltp: priceGreeks({ ...i, type: 'call' }).price }, { ltp: priceGreeks({ ...i, type: 'put' }).price });
      }),
      { underlyingPrice: S, expiryTime: now + 30 * 86400 },
    );

  it('recovers the parity forward, the carry yield and a flat 15% IV', () => {
    const g = analyzeGreeks(priced(() => 0.15), { r, qFallback: 0, now });
    expect(g.model).toBe('black-scholes');
    expect(g.forwardSource).toBe('parity');
    expect(g.forward).toBeCloseTo(S * Math.exp((r - q) * T), 4);
    expect(g.q).toBeCloseTo(q, 8);
    expect(g.atm).toBe(25100);
    for (const x of g.rows) {
      expect(x.call?.iv?.source).toBe('calculated');
      expect(x.call?.iv?.value).toBeCloseTo(15, 4);
      expect(x.put?.iv?.value).toBeCloseTo(15, 4);
    }
    expect(g.atmIv).toBeCloseTo(15, 4);
    const atm = g.rows.find((x) => x.strike === 25100)!;
    const ref = priceGreeks({ type: 'call', S, K: 25100, T, r, q, sigma: 0.15, model: 'black-scholes' });
    expect(atm.call!.delta!.value).toBeCloseTo(ref.delta, 6);
    expect(atm.call!.theta!.value).toBeCloseTo(ref.theta / 365, 6);
    expect(atm.call!.vega!.value).toBeCloseTo(ref.vega / 100, 6);
    expect(atm.call!.rho!.source).toBe('calculated');
  });

  it('prefers sane provider IV and Greeks and labels their source', () => {
    const c = priced(() => 0.15);
    c.rows[10].call = { ...c.rows[10].call, iv: 14.2, greeks: { delta: 0.51, gamma: 0.0004, theta: -9, vega: 13 } };
    c.rows[11].call = { ...c.rows[11].call, greeks: { delta: 7 } }; // implausible: ignored
    c.rows[12].call = { ...c.rows[12].call, greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 } }; // zeros for an unquoted strike: ignored
    c.rows[13].call = { ...c.rows[13].call, greeks: { delta: 0.95, gamma: 0.001 } }; // far from the model's delta: ignored
    const g = analyzeGreeks(c, { r, qFallback: 0, now });
    expect(g.rows[10].call!.iv).toEqual({ value: 14.2, source: 'provider' });
    expect(g.rows[10].call!.delta).toEqual({ value: 0.51, source: 'provider' });
    expect(g.rows[10].call!.ivCalculated).toBeCloseTo(15, 4);
    expect(g.rows[11].call!.delta!.source).toBe('calculated');
    expect(g.rows[12].call!.delta!.source).toBe('calculated');
    expect(g.rows[12].call!.gamma!.source).toBe('calculated');
    expect(g.rows[12].call!.delta!.value).toBeGreaterThan(0.2);
    expect(g.rows[13].call!.delta!.source).toBe('calculated');
  });

  it('falls back to the stated yield assumption when parity cannot be measured, and says so', () => {
    const c = chainOf([row(25000, { ltp: 300 }), row(25100, { ltp: 250 })], { expiryTime: now + 30 * 86400 });
    const g = analyzeGreeks(c, { r, qFallback: 0.01, now });
    expect(g.qSource).toBe('assumed');
    expect(g.q).toBe(0.01);
    expect(g.notes.join(' ')).toMatch(/assumption/);
  });

  it('uses Black-76 on the futures price for options on futures', () => {
    const F = 6200;
    const c = chainOf([row(6200, { ltp: priceGreeks({ type: 'call', S: F, K: 6200, T, r, sigma: 0.4, model: 'black-76' }).price })], {
      exchange: 'MCX',
      underlyingPrice: F,
      underlyingIsFutures: true,
      expiryTime: now + 30 * 86400,
    });
    const g = analyzeGreeks(c, { r, qFallback: 0, now });
    expect(g.model).toBe('black-76');
    expect(g.forwardSource).toBe('futures');
    expect(g.rows[0].call!.iv!.value).toBeCloseTo(40, 4);
  });

  it('builds the smile and measures put-over-call skew', () => {
    const g = analyzeGreeks(priced((K) => 0.15 + (25000 - K) / 25000), { r, qFallback: 0, now });
    const smile = ivSmile(g);
    expect(smile).toHaveLength(21);
    expect(smile[0].otmIv).toBeGreaterThan(smile[20].otmIv!);
    const sk = ivSkew(g, 3)!;
    expect(sk.skew).toBeGreaterThan(0);
    expect(sk.putWingStrike).toBeLessThan(g.forward!);
    expect(sk.callWingStrike).toBeGreaterThan(g.forward!);
    expect(impliedForwardFromParity([], 1, r, T)).toBeUndefined();
  });

  it('needs 20 captured days before showing IV rank and percentile', () => {
    const day = (i: number) => Date.UTC(2026, 9, 1 + i, 9, 0) / 1000;
    const hist = Array.from({ length: 20 }, (_, i) => ({ t: day(i), atmIv: 10 + i }));
    const few = ivRankPercentile(hist.slice(0, 19), 24.5);
    expect(few.days).toBe(19);
    expect(few.rank).toBeUndefined();
    expect(few.percentile).toBeUndefined();
    const s = ivRankPercentile([...hist, { t: day(19) - 3600, atmIv: 99 }], 24.5); // same-day earlier value is superseded
    expect(s.days).toBe(20);
    expect(s.rank).toBeCloseTo(((24.5 - 10) / 19) * 100, 8);
    expect(s.percentile).toBeCloseTo(75, 8);
  });
});
