import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import * as ind from '@core/indicators';
import type { AnalysisReport } from '@core/analysis/types';
import { formatPrice, formatVolume, priceDecimals } from '@core/format';
import type { Series } from '@core/types';
import type { Settings } from '../../../shared/api';

interface Props {
  series: Series | null;
  report: AnalysisReport | null;
  indicators: Settings['indicators'];
  lowerPane: Settings['lowerPane'];
  theme: Settings['theme'];
  loading: boolean;
  error: string | null;
  /** Receives a function that screenshots the chart (all panes, indicators, levels, markers). */
  captureRef?: { current: (() => HTMLCanvasElement | null) | null };
}

interface Legend {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  chg: number;
}

function palette(theme: Settings['theme']) {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    bg: v('--bg'),
    text: v('--muted'),
    grid: theme === 'dark' ? 'rgba(130,150,170,0.08)' : 'rgba(30,50,70,0.07)',
    border: v('--border'),
    bull: v('--bull'),
    bear: v('--bear'),
    warn: v('--warn'),
    accent: v('--accent'),
    accent2: v('--accent-2'),
  };
}

export function ChartPanel({ series, report, indicators, lowerPane, theme, loading, error, captureRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<ISeriesApi<never>[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const keyRef = useRef<string>('');
  const [legend, setLegend] = useState<Legend | null>(null);

  // Create the chart once.
  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, { autoSize: true });
    chartRef.current = chart;
    if (captureRef) captureRef.current = () => chartRef.current?.takeScreenshot() ?? null;
    return () => {
      if (captureRef) captureRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRefs.current = [];
    };
  }, []);

  // (Re)draw whenever the data, analysis or display options change.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const p = palette(theme);
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: p.bg }, textColor: p.text, fontFamily: 'Segoe UI, system-ui, sans-serif', fontSize: 11, panes: { separatorColor: p.border, enableResize: true } },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: p.border },
      timeScale: { borderColor: p.border, timeVisible: series ? !['1d', '1wk', '1mo'].includes(series.timeframe) : true, secondsVisible: false, rightOffset: 6 },
    });

    const key = series ? `${series.meta.symbol}:${series.timeframe}` : '';
    const keepRange: LogicalRange | null = key && key === keyRef.current ? chart.timeScale().getVisibleLogicalRange() : null;
    markersRef.current?.detach();
    markersRef.current = null;
    for (const s of seriesRefs.current) chart.removeSeries(s);
    seriesRefs.current = [];
    // Remove empty extra panes left from a previous lower-pane choice.
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
    if (!series || !series.candles.length) {
      setLegend(null);
      keyRef.current = key;
      return;
    }

    const track = <T,>(s: T) => {
      seriesRefs.current.push(s as unknown as ISeriesApi<never>);
      return s;
    };
    // Show bars in exchange-local time.
    const shift = series.meta.gmtOffset ?? 0;
    const t = (sec: number) => (sec + shift) as UTCTimestamp;
    const c = series.candles;
    const dec = priceDecimals(c[c.length - 1].close);
    const priceFormat = { type: 'price' as const, precision: dec, minMove: 1 / 10 ** dec };

    const candles = track(
      chart.addSeries(CandlestickSeries, {
        upColor: p.bull,
        downColor: p.bear,
        borderUpColor: p.bull,
        borderDownColor: p.bear,
        wickUpColor: p.bull,
        wickDownColor: p.bear,
        priceFormat,
      }),
    );
    candles.setData(c.map((x) => ({ time: t(x.time), open: x.open, high: x.high, low: x.low, close: x.close })));

    if (indicators.volume && series.meta.volumeAvailable) {
      const vol = track(chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }));
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(c.map((x) => ({ time: t(x.time), value: x.volume, color: x.close >= x.open ? `${p.bull}55` : `${p.bear}55` })));
    }

    const close = ind.closes(c);
    const line = (values: number[], color: string, width: 1 | 2 = 1, pane = 0, style: LineStyle = LineStyle.Solid, title = '') => {
      const s = track(chart.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: !!title, crosshairMarkerVisible: false, title, priceFormat }, pane));
      s.setData(values.map((v, i) => (Number.isFinite(v) ? { time: t(c[i].time), value: v } : { time: t(c[i].time) })));
      return s;
    };
    if (indicators.ema20) line(ind.ema(close, 20), '#f5a524');
    if (indicators.ema50) line(ind.ema(close, 50), '#3b9eff');
    if (indicators.ema200) line(ind.ema(close, 200), '#c084fc', 2);
    if (indicators.vwap && series.meta.volumeAvailable && !['1d', '1wk', '1mo'].includes(series.timeframe)) line(ind.vwap(c, shift), '#22d3c5', 1, 0, LineStyle.Dashed);
    if (indicators.bollinger) {
      const b = ind.bollinger(close, 20, 2);
      line(b.upper, '#8193a6', 1, 0, LineStyle.Dotted);
      line(b.middle, '#56677a', 1, 0, LineStyle.Dotted);
      line(b.lower, '#8193a6', 1, 0, LineStyle.Dotted);
    }
    if (indicators.supertrend) {
      const st = ind.supertrend(c, 10, 3);
      const s = track(chart.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat }));
      s.setData(st.line.map((v, i) => (Number.isFinite(v) ? { time: t(c[i].time), value: v, color: st.direction[i] === 1 ? p.bull : p.bear } : { time: t(c[i].time) })));
    }

    // Lower indicator pane.
    if (lowerPane !== 'none') {
      const fmt2 = { type: 'price' as const, precision: 2, minMove: 0.01 };
      const lower = (values: number[], color: string, title: string, style: LineStyle = LineStyle.Solid) => {
        const s = track(chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: true, title, priceFormat: fmt2 }, 1));
        s.setData(values.map((v, i) => (Number.isFinite(v) ? { time: t(c[i].time), value: v } : { time: t(c[i].time) })));
        return s;
      };
      if (lowerPane === 'rsi') {
        const s = lower(ind.rsi(close, 14), '#c084fc', 'RSI 14');
        for (const lvl of [70, 50, 30]) s.createPriceLine({ price: lvl, color: lvl === 50 ? p.border : p.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      } else if (lowerPane === 'macd') {
        const m = ind.macd(close);
        const h = track(chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: dec, minMove: 1 / 10 ** dec } }, 1));
        h.setData(m.histogram.map((v, i) => (Number.isFinite(v) ? { time: t(c[i].time), value: v, color: v >= 0 ? `${p.bull}99` : `${p.bear}99` } : { time: t(c[i].time) })));
        lower(m.macd, '#3b9eff', 'MACD');
        lower(m.signal, '#f5a524', 'Signal');
      } else if (lowerPane === 'stochastic') {
        const s = ind.stochastic(c, 14, 3, 3);
        const k = lower(s.k, '#3b9eff', '%K');
        lower(s.d, '#f5a524', '%D');
        for (const lvl of [80, 20]) k.createPriceLine({ price: lvl, color: p.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      } else if (lowerPane === 'adx') {
        const a = ind.adx(c, 14);
        const s = lower(a.adx, '#e2e8f0', 'ADX');
        lower(a.plusDI, p.bull, '+DI');
        lower(a.minusDI, p.bear, '−DI');
        s.createPriceLine({ price: 25, color: p.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      }
      // Price pane gets ~78% of the height, the indicator pane ~22%.
      const panes = chart.panes();
      panes[0]?.setStretchFactor(0.78);
      panes[1]?.setStretchFactor(0.22);
    }

    // Analysis overlays.
    if (report && report.symbol === series.meta.symbol && report.timeframe === series.timeframe) {
      if (indicators.levels) {
        for (const lv of report.levels) {
          const color = lv.kind === 'support' ? p.bull : lv.kind === 'resistance' ? p.bear : p.text;
          candles.createPriceLine({
            price: lv.price,
            color: lv.kind === 'psychological' ? `${color}88` : color,
            lineWidth: lv.strength >= 60 ? 2 : 1,
            lineStyle: lv.kind === 'psychological' ? LineStyle.SparseDotted : LineStyle.Dashed,
            axisLabelVisible: lv.kind !== 'psychological',
            title: lv.kind === 'psychological' ? 'Round' : `${lv.kind === 'support' ? 'S' : 'R'} ×${lv.touches}`,
          });
        }
      }
      if (indicators.zones) {
        for (const z of report.zones) {
          const color = z.kind.startsWith('bullish') ? p.bull : p.bear;
          const label = z.kind.endsWith('ob') ? 'OB' : 'FVG';
          candles.createPriceLine({ price: z.top, color: `${color}99`, lineWidth: 1, lineStyle: LineStyle.LargeDashed, axisLabelVisible: false, title: `${label} ▲` });
          candles.createPriceLine({ price: z.bottom, color: `${color}99`, lineWidth: 1, lineStyle: LineStyle.LargeDashed, axisLabelVisible: false, title: `${label} ▼` });
        }
      }
      if (indicators.markers) {
        const toneColor = { bull: p.bull, bear: p.bear, warn: p.warn, neutral: p.text };
        const markers: SeriesMarker<Time>[] = report.markers.map((m) => ({
          time: t(m.time),
          position: m.position,
          shape: m.kind === 'BOS' || m.kind === 'CHoCH' ? (m.position === 'belowBar' ? 'arrowUp' : 'arrowDown') : m.kind === 'SWEEP' || m.kind === 'TRAP' ? 'square' : 'circle',
          color: toneColor[m.tone],
          text: m.text,
          size: m.kind === 'BOS' || m.kind === 'CHoCH' ? 1 : 0.6,
        }));
        markersRef.current = createSeriesMarkers(candles, markers);
      }
    }

    if (keepRange) chart.timeScale().setVisibleLogicalRange(keepRange);
    else chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, c.length - 160), to: c.length + 5 });
    keyRef.current = key;

    const lastBar = c[c.length - 1];
    const prevBar = c[c.length - 2] ?? lastBar;
    const def: Legend = { o: lastBar.open, h: lastBar.high, l: lastBar.low, c: lastBar.close, v: lastBar.volume, chg: ((lastBar.close - prevBar.close) / prevBar.close) * 100 };
    setLegend(def);
    const byTime = new Map(c.map((x, i) => [x.time + shift, i]));
    const onMove = (param: { time?: Time }) => {
      const i = param.time !== undefined ? byTime.get(param.time as number) : undefined;
      if (i === undefined) return setLegend(def);
      const x = c[i];
      const prev = c[i - 1] ?? x;
      setLegend({ o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume, chg: ((x.close - prev.close) / prev.close) * 100 });
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [series, report, indicators, lowerPane, theme]);

  return (
    <div className="chart-wrap">
      <div ref={host} className="chart-host" />
      {legend && series && (
        <div className="legend">
          <span>
            O <b>{formatPrice(legend.o)}</b>
          </span>
          <span>
            H <b>{formatPrice(legend.h)}</b>
          </span>
          <span>
            L <b>{formatPrice(legend.l)}</b>
          </span>
          <span>
            C <b className={legend.chg >= 0 ? 'up' : 'down'}>{formatPrice(legend.c)}</b>
          </span>
          {series.meta.volumeAvailable && (
            <span>
              Vol <b>{formatVolume(legend.v)}</b>
            </span>
          )}
          {indicators.ema20 && <span style={{ color: '#f5a524' }}>EMA20</span>}
          {indicators.ema50 && <span style={{ color: '#3b9eff' }}>EMA50</span>}
          {indicators.ema200 && <span style={{ color: '#c084fc' }}>EMA200</span>}
        </div>
      )}
      {(loading || error || !series) && (
        <div className="chart-overlay">
          {loading ? (
            <span>
              <span className="spinner" /> Loading market data…
            </span>
          ) : error ? (
            <span className="tone-bear">{error}</span>
          ) : (
            <span>Search a symbol to load its chart.</span>
          )}
        </div>
      )}
    </div>
  );
}
