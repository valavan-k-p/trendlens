/**
 * Pure technical indicators. Every function returns an array aligned with its
 * input; positions without enough history hold NaN. Conventions follow the
 * common charting-platform definitions:
 *  - EMA is seeded with the SMA of the first `period` values.
 *  - RSI, ATR and ADX use Wilder's smoothing (RMA), seeded with a simple average.
 *  - Bollinger Bands use the population standard deviation.
 */
import type { Candle } from '../types';

export type Line = number[];

const nanArray = (n: number): Line => new Array<number>(n).fill(NaN);

export function closes(c: Candle[]): Line {
  return c.map((x) => x.close);
}

export function sma(values: Line, period: number): Line {
  const out = nanArray(values.length);
  if (period <= 0) return out;
  let sum = 0;
  let count = 0; // consecutive finite values in window
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > period) {
      sum -= values[i - period];
      count = period;
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, SMA-seeded. Leading NaNs in input are skipped. */
export function ema(values: Line, period: number): Line {
  return smoothed(values, period, 2 / (period + 1));
}

/** Wilder's moving average (RMA), alpha = 1/period, SMA-seeded. */
export function rma(values: Line, period: number): Line {
  return smoothed(values, period, 1 / period);
}

function smoothed(values: Line, period: number, alpha: number): Line {
  const out = nanArray(values.length);
  let start = 0;
  while (start < values.length && !Number.isFinite(values[start])) start++;
  if (values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i];
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    const v = values[i];
    prev = Number.isFinite(v) ? alpha * v + (1 - alpha) * prev : prev;
    out[i] = prev;
  }
  return out;
}

export function wma(values: Line, period: number): Line {
  const out = nanArray(values.length);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = 0; k < period; k++) {
      const v = values[i - k];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      s += v * (period - k);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

/** Population standard deviation over a rolling window. */
export function stdev(values: Line, period: number): Line {
  const out = nanArray(values.length);
  const mean = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    if (!Number.isFinite(mean[i])) continue;
    let s = 0;
    for (let k = i - period + 1; k <= i; k++) s += (values[k] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

export function rsi(values: Line, period = 14): Line {
  const n = values.length;
  const out = nanArray(n);
  if (n <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdResult {
  macd: Line;
  signal: Line;
  histogram: Line;
}

export function macd(values: Line, fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => f[i] - s[i]);
  const signal = ema(line, signalPeriod);
  const histogram = line.map((v, i) => v - signal[i]);
  return { macd: line, signal, histogram };
}

export function trueRange(c: Candle[]): Line {
  return c.map((x, i) =>
    i === 0
      ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)),
  );
}

export function atr(c: Candle[], period = 14): Line {
  return rma(trueRange(c), period);
}

export interface AdxResult {
  adx: Line;
  plusDI: Line;
  minusDI: Line;
}

export function adx(c: Candle[], period = 14): AdxResult {
  const n = c.length;
  const plusDM = nanArray(n);
  const minusDM = nanArray(n);
  const tr = nanArray(n);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
  }
  const trS = rma(tr, period);
  const pS = rma(plusDM, period);
  const mS = rma(minusDM, period);
  const plusDI = trS.map((t, i) => (t > 0 ? (100 * pS[i]) / t : NaN));
  const minusDI = trS.map((t, i) => (t > 0 ? (100 * mS[i]) / t : NaN));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    const s = p + m;
    return Number.isFinite(s) ? (s === 0 ? 0 : (100 * Math.abs(p - m)) / s) : NaN;
  });
  return { adx: rma(dx, period), plusDI, minusDI };
}

export interface BandsResult {
  upper: Line;
  middle: Line;
  lower: Line;
  /** (upper - lower) / middle */
  bandwidth: Line;
  /** (close - lower) / (upper - lower) */
  percentB: Line;
}

export function bollinger(values: Line, period = 20, mult = 2): BandsResult {
  const middle = sma(values, period);
  const sd = stdev(values, period);
  const upper = middle.map((m, i) => m + mult * sd[i]);
  const lower = middle.map((m, i) => m - mult * sd[i]);
  return {
    upper,
    middle,
    lower,
    bandwidth: middle.map((m, i) => (m !== 0 ? (upper[i] - lower[i]) / m : NaN)),
    percentB: values.map((v, i) => {
      const w = upper[i] - lower[i];
      return w > 0 ? (v - lower[i]) / w : NaN;
    }),
  };
}

export interface StochResult {
  k: Line;
  d: Line;
}

/** Stochastic oscillator: %K = SMA(raw, smoothK); %D = SMA(%K, smoothD). */
export function stochastic(c: Candle[], period = 14, smoothK = 3, smoothD = 3): StochResult {
  const raw = nanArray(c.length);
  for (let i = period - 1; i < c.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = i - period + 1; k <= i; k++) {
      hh = Math.max(hh, c[k].high);
      ll = Math.min(ll, c[k].low);
    }
    raw[i] = hh === ll ? 50 : (100 * (c[i].close - ll)) / (hh - ll);
  }
  const k = sma(raw, smoothK);
  return { k, d: sma(k, smoothD) };
}

export function obv(c: Candle[]): Line {
  const out = nanArray(c.length);
  if (!c.length) return out;
  out[0] = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close;
    out[i] = out[i - 1] + (d > 0 ? c[i].volume : d < 0 ? -c[i].volume : 0);
  }
  return out;
}

/** Money Flow Index. */
export function mfi(c: Candle[], period = 14): Line {
  const out = nanArray(c.length);
  const tp = c.map((x) => (x.high + x.low + x.close) / 3);
  for (let i = period; i < c.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const flow = tp[k] * c[k].volume;
      if (tp[k] > tp[k - 1]) pos += flow;
      else if (tp[k] < tp[k - 1]) neg += flow;
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

function moneyFlowMultiplier(x: Candle): number {
  const r = x.high - x.low;
  return r === 0 ? 0 : (x.close - x.low - (x.high - x.close)) / r;
}

/** Chaikin Accumulation/Distribution line. */
export function adLine(c: Candle[]): Line {
  const out = nanArray(c.length);
  let acc = 0;
  for (let i = 0; i < c.length; i++) {
    acc += moneyFlowMultiplier(c[i]) * c[i].volume;
    out[i] = acc;
  }
  return out;
}

/** Chaikin Money Flow. */
export function cmf(c: Candle[], period = 20): Line {
  const out = nanArray(c.length);
  for (let i = period - 1; i < c.length; i++) {
    let mfv = 0;
    let vol = 0;
    for (let k = i - period + 1; k <= i; k++) {
      mfv += moneyFlowMultiplier(c[k]) * c[k].volume;
      vol += c[k].volume;
    }
    out[i] = vol === 0 ? NaN : mfv / vol;
  }
  return out;
}

/**
 * Session VWAP that resets at each exchange-local day boundary.
 * `gmtOffset` is the exchange offset from UTC in seconds.
 */
export function vwap(c: Candle[], gmtOffset = 0): Line {
  const out = nanArray(c.length);
  let day = NaN;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < c.length; i++) {
    const d = Math.floor((c[i].time + gmtOffset) / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (c[i].high + c[i].low + c[i].close) / 3;
    pv += tp * c[i].volume;
    vol += c[i].volume;
    out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}

export interface SupertrendResult {
  line: Line;
  /** +1 uptrend, -1 downtrend, NaN warmup */
  direction: Line;
}

export function supertrend(c: Candle[], period = 10, mult = 3): SupertrendResult {
  const a = atr(c, period);
  const line = nanArray(c.length);
  const direction = nanArray(c.length);
  let upper = NaN;
  let lower = NaN;
  let dir = 1;
  for (let i = 0; i < c.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (c[i].high + c[i].low) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    const prevClose = i > 0 ? c[i - 1].close : c[i].close;
    const newUpper = !Number.isFinite(upper) || bu < upper || prevClose > upper ? bu : upper;
    const newLower = !Number.isFinite(lower) || bl > lower || prevClose < lower ? bl : lower;
    if (Number.isFinite(direction[i - 1])) {
      if (dir === 1 && c[i].close < newLower) dir = -1;
      else if (dir === -1 && c[i].close > newUpper) dir = 1;
    } else {
      dir = c[i].close >= hl2 ? 1 : -1;
    }
    upper = newUpper;
    lower = newLower;
    direction[i] = dir;
    line[i] = dir === 1 ? lower : upper;
  }
  return { line, direction };
}

/** Rate of change in percent. */
export function roc(values: Line, period = 10): Line {
  return values.map((v, i) =>
    i >= period && values[i - period] !== 0 ? (100 * (v - values[i - period])) / values[i - period] : NaN,
  );
}

/** Least-squares slope per bar over the trailing window. */
export function linregSlope(values: Line, period: number): Line {
  const out = nanArray(values.length);
  const xMean = (period - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < period; x++) sxx += (x - xMean) ** 2;
  for (let i = period - 1; i < values.length; i++) {
    let yMean = 0;
    for (let k = 0; k < period; k++) yMean += values[i - period + 1 + k];
    yMean /= period;
    let sxy = 0;
    for (let k = 0; k < period; k++) sxy += (k - xMean) * (values[i - period + 1 + k] - yMean);
    out[i] = sxy / sxx;
  }
  return out;
}

/** Percentile rank (0..100) of the last value within the trailing window. */
export function percentRank(values: Line, period: number): Line {
  const out = nanArray(values.length);
  for (let i = period - 1; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let below = 0;
    let count = 0;
    for (let k = i - period + 1; k <= i; k++) {
      if (!Number.isFinite(values[k])) continue;
      count++;
      if (values[k] < v) below++;
    }
    if (count > 1) out[i] = (100 * below) / (count - 1);
  }
  return out;
}

export function last(values: Line, offset = 0): number {
  return values[values.length - 1 - offset];
}

/** Last finite value, or NaN. */
export function lastFinite(values: Line): number {
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return values[i];
  return NaN;
}
