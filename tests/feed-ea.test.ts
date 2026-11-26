import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExporterCandles, parseHeartbeat } from '@core/data/mt4live';
import type { Candle } from '@core/types';

const dir = resolve(__dirname, '..', 'resources', 'mt4');
const src = readFileSync(resolve(dir, 'TrendLensFeed.mq4'), 'utf8');
// Strip comments so the safety header itself does not count.
const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('bundled TrendLensFeed EA', () => {
  it('ships both the source and the compiled .ex4', () => {
    expect(existsSync(resolve(dir, 'TrendLensFeed.ex4'))).toBe(true);
  });

  it('contains no order or trading functions', () => {
    for (const fn of ['OrderSend', 'OrderModify', 'OrderClose', 'OrderDelete', 'OrderCloseBy', 'SymbolSelect', 'ObjectCreate', 'iCustom'])
      expect(code.includes(fn), fn).toBe(false);
  });

  it('opens files only in the terminal Common\\Files folder', () => {
    const opens = code.match(/FileOpen\([^;]*\)/g) ?? [];
    expect(opens.length).toBeGreaterThan(0);
    for (const o of opens) expect(o).toContain('FILE_COMMON');
    expect(code).toContain('#define OUT_DIR       "TrendLens\\\\"');
  });

  it('writes the candle header TrendLens parses', () => {
    const header = /#define CANDLE_HEADER "([^"]+)"/.exec(code)![1];
    const m = new Map<number, Candle>();
    parseExporterCandles(`${header}\r\n1795698000,NIFTY,5,25955.00,25957.40,25925.00,25940.00,124,1795698305,backfill,s\r\n`, m);
    expect(m.get(1795698000)?.close).toBe(25940);
  });
});

describe('TrendLensFeed heartbeat', () => {
  it('parses exact forming bars per timeframe', () => {
    const hb = parseHeartbeat(
      '{"feed":"TrendLensFeed","version":"1.00","server_time":1795698708,"local_time":1795700509,"gmt_time":1795680709,"connected":true,"quotes":[{"symbol":"NIFTY","bid":25948.00,"ask":25948.00,"last_tick_time":1795698704,"digits":2,"bars":[{"tf":5,"time":1795698600,"o":25940.00,"h":25951.00,"l":25936.50,"c":25948.00,"v":61},{"tf":60,"time":1795695900,"o":25955.00,"h":25987.50,"l":25925.00,"c":25948.00,"v":900}]}]}',
    )!;
    expect(hb.feed).toBe('TrendLensFeed');
    expect(hb.quotes[0].bars![5]).toEqual({ time: 1795698600, open: 25940, high: 25951, low: 25936.5, close: 25948, volume: 61 });
    expect(hb.quotes[0].bars![60].time).toBe(1795695900);
  });

  it('treats the existing MarketDataExporter heartbeat as price-only', () => {
    const hb = parseHeartbeat('{"server_time":1,"gmt_time":1,"quotes":[{"symbol":"MNAG","bid":337.1,"ask":337.1,"last_tick_time":1}]}')!;
    expect(hb.feed).toBe('MarketDataExporter');
    expect(hb.quotes[0].bars).toBeUndefined();
  });
});
