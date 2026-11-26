import { analyze } from '@core/analysis/engine';
import type { AnalysisReport } from '@core/analysis/types';
import { HIGHER_TIMEFRAMES, resample } from '@core/data';
import type { Series, SymbolInfo, Timeframe } from '@core/types';
import { timeframeSeconds } from '@core/types';

/**
 * Loads the higher-timeframe series used by multi-timeframe alignment, then runs the
 * engine. Network series come from the same provider; CSV series are resampled locally.
 */
export async function runAnalysis(series: Series, symbol: SymbolInfo): Promise<AnalysisReport> {
  const higherTfs = HIGHER_TIMEFRAMES[series.timeframe];
  let higher: Series[] = [];
  if (symbol.provider === 'csv') {
    higher = higherTfs
      .filter((tf) => timeframeSeconds(tf) > timeframeSeconds(series.timeframe))
      .map((tf) => ({ ...series, timeframe: tf, candles: resample(series.candles, tf, series.meta.gmtOffset ?? 0) }))
      .filter((s) => s.candles.length >= 30);
  } else {
    const results = await Promise.allSettled(
      higherTfs.map((tf: Timeframe) => window.trendlens.getSeries({ provider: symbol.provider, symbol: symbol.symbol, timeframe: tf })),
    );
    higher = results.filter((r): r is PromiseFulfilledResult<Series> => r.status === 'fulfilled' && r.value.candles.length >= 30).map((r) => r.value);
  }
  const report = analyze(series, { higher });
  if (!report.name && symbol.name) report.name = symbol.name;
  return report;
}
