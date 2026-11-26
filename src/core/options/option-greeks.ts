/**
 * European option pricing, Greeks and implied volatility.
 *
 * - Black-Scholes(-Merton) with a continuous yield q, for options on a spot underlying
 *   (NSE/BSE index and stock options, which are European and cash-settled on spot).
 * - Black-76, for options on futures (MCX commodity options).
 *
 * Units: sigma, r, q as decimals (0.15 = 15%), T in years. Returned theta is per year, vega per
 * 1.00 of volatility and rho per 1.00 of rate; use the `perDay`/`perPoint` helpers for display.
 */

export type OptionType = 'call' | 'put';
export type PricingModel = 'black-scholes' | 'black-76';

export interface ModelInput {
  type: OptionType;
  /** Spot price (Black-Scholes) or futures/forward price (Black-76). */
  S: number;
  K: number;
  T: number;
  r: number;
  /** Continuous dividend / carry yield, Black-Scholes only. */
  q?: number;
  sigma: number;
  model: PricingModel;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

/** Standard normal density. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF, Hart (1968) double-precision algorithm as given by West (2005): ~1e-14 accuracy. */
export function normCdf(x: number): number {
  const a = Math.abs(x);
  let c: number;
  if (a > 37) c = 0;
  else {
    const e = Math.exp(-0.5 * a * a);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-2 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * a + 1.75566716318264;
      b = b * a + 16.064177579207;
      b = b * a + 86.7807322029461;
      b = b * a + 296.564248779674;
      b = b * a + 637.333633378831;
      b = b * a + 793.826512519948;
      b = b * a + 440.413735824752;
      c /= b;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/** Price and Greeks of a European option. */
export function priceGreeks(i: ModelInput): Greeks {
  const { type, S, K, T, r, sigma } = i;
  const call = type === 'call';
  const sqrtT = Math.sqrt(T);
  const vs = sigma * sqrtT;
  const df = Math.exp(-r * T);
  if (i.model === 'black-76') {
    const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / vs;
    const d2 = d1 - vs;
    const nd1 = normPdf(d1);
    const price = call ? df * (S * normCdf(d1) - K * normCdf(d2)) : df * (K * normCdf(-d2) - S * normCdf(-d1));
    const decay = (-S * df * nd1 * sigma) / (2 * sqrtT);
    return {
      price,
      delta: call ? df * normCdf(d1) : -df * normCdf(-d1),
      gamma: (df * nd1) / (S * vs),
      theta: call ? decay - r * K * df * normCdf(d2) + r * S * df * normCdf(d1) : decay + r * K * df * normCdf(-d2) - r * S * df * normCdf(-d1),
      vega: S * df * nd1 * sqrtT,
      // Futures price held fixed, so only discounting depends on r.
      rho: -T * price,
    };
  }
  const q = i.q ?? 0;
  const dq = Math.exp(-q * T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vs;
  const d2 = d1 - vs;
  const nd1 = normPdf(d1);
  const decay = (-S * dq * nd1 * sigma) / (2 * sqrtT);
  return {
    price: call ? S * dq * normCdf(d1) - K * df * normCdf(d2) : K * df * normCdf(-d2) - S * dq * normCdf(-d1),
    delta: call ? dq * normCdf(d1) : dq * (normCdf(d1) - 1),
    gamma: (dq * nd1) / (S * vs),
    theta: call ? decay - r * K * df * normCdf(d2) + q * S * dq * normCdf(d1) : decay + r * K * df * normCdf(-d2) - q * S * dq * normCdf(-d1),
    vega: S * dq * nd1 * sqrtT,
    rho: call ? K * T * df * normCdf(d2) : -K * T * df * normCdf(-d2),
  };
}

/** No-arbitrage price bounds of a European option under the given model inputs. */
export function priceBounds(i: Omit<ModelInput, 'sigma'>): [number, number] {
  const df = Math.exp(-i.r * i.T);
  const underlying = i.model === 'black-76' ? i.S * df : i.S * Math.exp(-(i.q ?? 0) * i.T);
  const strike = i.K * df;
  return i.type === 'call' ? [Math.max(0, underlying - strike), underlying] : [Math.max(0, strike - underlying), strike];
}

/**
 * Implied volatility (decimal) for a market price, by Newton-Raphson with a bisection fallback.
 * Returns undefined when the price is outside the no-arbitrage bounds or no solution is found.
 */
export function impliedVolatility(price: number, i: Omit<ModelInput, 'sigma'>): number | undefined {
  if (!(price > 0) || !(i.S > 0) || !(i.K > 0) || !(i.T > 0)) return undefined;
  const [lo, hi] = priceBounds(i);
  if (price <= lo + 1e-12 || price >= hi) return undefined;
  const f = (s: number) => priceGreeks({ ...i, sigma: s }).price - price;
  let a = 1e-4;
  let b = 5;
  if (f(a) > 0 || f(b) < 0) return undefined;
  let s = 0.3;
  for (let k = 0; k < 50; k++) {
    const g = priceGreeks({ ...i, sigma: s });
    const diff = g.price - price;
    if (Math.abs(diff) < 1e-9 * Math.max(1, price)) return s;
    if (diff > 0) b = Math.min(b, s);
    else a = Math.max(a, s);
    const next = g.vega > 1e-12 ? s - diff / g.vega : NaN;
    s = Number.isFinite(next) && next > a && next < b ? next : (a + b) / 2;
    if (b - a < 1e-10) return s;
  }
  return Math.abs(f(s)) < 1e-6 * Math.max(1, price) ? s : undefined;
}

/** Theta per calendar day. */
export const thetaPerDay = (thetaPerYear: number) => thetaPerYear / 365;
/** Vega or rho per one percentage point (0.01) change. */
export const perPoint = (v: number) => v / 100;

/** Forward implied by put-call parity at one strike: F = K + e^{rT}(C − P). */
export function parityForward(K: number, call: number, put: number, r: number, T: number): number {
  return K + Math.exp(r * T) * (call - put);
}
