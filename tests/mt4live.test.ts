import { describe, expect, it } from 'vitest';
import type { Candle } from '@core/types';
import { formingFromMinutes, heartbeatIsLive, mergeBars, parseExporterCandles, parseHeartbeat, splitExporterName, updateFormingBar } from '@core/data/mt4live';

describe('MarketDataExporter candles', () => {
  it('parses rows, skips the header, and lets a re-appended backfill row win', () => {
    const csv = [
      'bar_time,symbol,tf,open,high,low,close,tick_volume,observed_server_time,source,session',
      '1795697700,NIFTY,5,25966.00,25981.20,25949.00,25964.30,80,1795698002,backfill,a',
      '1795698000,NIFTY,5,25955.00,25957.40,25925.00,25940.00,124,1795698305,live,a',
      '1795697700,NIFTY,5,25966.00,25985.00,25949.00,25970.00,95,1795699000,backfill,b',
      'garbage line',
      '',
    ].join('\r\n');
    const m = new Map<number, Candle>();
    parseExporterCandles(csv, m);
    expect(m.size).toBe(2);
    expect(m.get(1795697700)).toEqual({ time: 1795697700, open: 25966, high: 25985, low: 25949, close: 25970, volume: 95 });
  });

  it('reads symbol and period from file names', () => {
    expect(splitExporterName('candles_SENSEX-FUT_5.csv')).toEqual({ symbol: 'SENSEX-FUT', period: 5 });
    expect(splitExporterName('candles_NIFTY_1440.csv')).toEqual({ symbol: 'NIFTY', period: 1440 });
    expect(splitExporterName('kbp_NIFTY_5.csv')).toBeNull();
  });
});

describe('heartbeat and forming bars', () => {
  const hbText = '{"exporter_version":"1.12","server_time":1795698708,"local_time":1795700509,"gmt_time":1795680709,"connected":true,"quotes":[{"symbol":"NIFTY","bid":25948.00,"ask":25948.00,"spread_points":0,"last_tick_time":1795698704,"digits":2}]}';

  it('parses the heartbeat and judges liveness from its GMT clock', () => {
    const hb = parseHeartbeat(hbText)!;
    expect(hb.quotes[0]).toEqual({ symbol: 'NIFTY', bid: 25948, ask: 25948, lastTickTime: 1795698704 });
    expect(heartbeatIsLive(hb, 1795680709 * 1000 + 5000)).toBe(true);
    expect(heartbeatIsLive(hb, 1795680709 * 1000 + 60_000)).toBe(false);
    expect(parseHeartbeat('{"half')).toBeNull();
  });

  it('builds the forming bar and rolls over at the period boundary', () => {
    let b = updateFormingBar(undefined, 100, 1_000_020, 5); // bucket 999_900
    b = updateFormingBar(b, 103, 1_000_100, 5);
    b = updateFormingBar(b, 98, 1_000_150, 5);
    expect(b).toEqual({ time: 999_900, open: 100, high: 103, low: 98, close: 98, volume: 0 });
    const next = updateFormingBar(b, 99, 1_000_200, 5);
    expect(next).toEqual({ time: 1_000_200, open: 99, high: 99, low: 99, close: 99, volume: 0 });
  });

  it('aligns the forming bar to the broker grid after the last closed bar', () => {
    const min = (t: number, p: number): Candle => ({ time: t, open: p, high: p + 1, low: p - 1, close: p, volume: 0 });
    // Broker hourly bars start at :45 (11:45 = 42300 s into the day). Last closed bar: 11:45.
    const day = 1_795_651_200; // a midnight
    const lastClosed = day + 42_300;
    const ms = [min(day + 45_900 - 120, 100), min(day + 45_900, 101), min(day + 46_000, 105), min(day + 46_800, 103)]; // 12:43, 12:45, 12:46.., 13:00
    const bar = formingFromMinutes(ms, 60, lastClosed)!;
    expect(bar.time).toBe(day + 45_900); // 12:45, not 13:00
    expect(bar).toMatchObject({ open: 101, high: 106, low: 100, close: 103 });
    // Still inside the last closed bar -> no forming bar.
    expect(formingFromMinutes([min(lastClosed + 60, 1)], 60, lastClosed)).toBeUndefined();
    // Without history, fall back to clock alignment.
    expect(formingFromMinutes([min(day + 46_800, 1)], 60, undefined)!.time).toBe(day + 46_800);
  });

  it('merges history, exporter bars and the forming bar by time', () => {
    const bar = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 });
    expect(mergeBars([bar(1, 10), bar(2, 11)], [bar(2, 12), bar(3, 13)], [bar(4, 14)]).map((c) => c.close)).toEqual([10, 12, 13, 14]);
  });
});
