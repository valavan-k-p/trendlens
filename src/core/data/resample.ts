import type { Candle, Timeframe } from '../types';
import { timeframeSeconds } from '../types';

/**
 * Aggregates candles into a coarser timeframe. Buckets are aligned to the
 * exchange-local day (via `gmtOffset`, seconds east of UTC) so 4h bars start at
 * local midnight, 04:00, 08:00, ...; weekly bars start on Monday.
 */
export function resample(candles: Candle[], to: Timeframe, gmtOffset = 0): Candle[] {
  const size = timeframeSeconds(to);
  const out: Candle[] = [];
  let bucket = NaN;
  for (const c of candles) {
    const local = c.time + gmtOffset;
    let b: number;
    if (to === '1wk') {
      const day = Math.floor(local / 86400);
      // 1970-01-01 was a Thursday; shift so weeks start on Monday.
      b = (day - ((day + 3) % 7)) * 86400 - gmtOffset;
    } else if (to === '1mo') {
      const d = new Date(local * 1000);
      b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - gmtOffset;
    } else {
      b = Math.floor(local / size) * size - gmtOffset;
    }
    const last = out[out.length - 1];
    if (b !== bucket || !last) {
      bucket = b;
      out.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}
