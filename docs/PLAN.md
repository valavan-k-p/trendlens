# TrendLens — implementation plan

A personal Windows desktop app that reproduces the publicly documented TrueTrendView
workflow (see `research/FEATURES.md`) under its own name, with its own analysis engine.

## Stack

- **Electron** desktop shell (native window, menus, no login), packaged to a
  Windows `.exe` with **electron-builder**.
- **React + TypeScript** renderer, built with **electron-vite**.
- **lightweight-charts** (TradingView's open-source, Apache-2.0 charting library)
  for candles, volume, indicator panes and level overlays.
- **Vitest** for unit tests of indicators and analysis.

## Modules

| Folder | Responsibility |
| --- | --- |
| `src/core/types.ts` | Shared types: `Candle`, `Timeframe`, `AnalysisReport` |
| `src/core/indicators/` | Pure indicator functions (SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, Stochastic, OBV, MFI, CMF, VWAP, Supertrend) |
| `src/core/analysis/` | Analysis modules: structure, levels, momentum, volatility, liquidity, smart money, risk, multi-timeframe, scoring → report |
| `src/core/data/` | Provider interface + Yahoo Finance and Binance providers, CSV import, resampling |
| `src/main/` | Electron main process: window, menu, network fetches (no CORS), settings + history persistence, optional AI chart review |
| `src/preload/` | Typed, minimal bridge exposed to the renderer |
| `src/renderer/` | UI: ticker tape, symbol search, chart, analysis panel, market dashboard, history, settings |

## Data sources

- Yahoo Finance public chart/search endpoints (no key; unofficial, personal use) for
  NSE/BSE, US stocks, indices, forex, commodities, crypto.
- Binance public market-data API (official, no key) for crypto pairs.
- Local CSV import (any OHLCV export) for offline use.

## Workflow (mirrors the site)

1. Search symbol → 2. Preview chart, pick timeframe → 3. Analyse → structured report:
   Market Condition, Confidence, Strength Index, Risk Environment, Insight Summary,
   Bottom-line verdict, plus module cards (structure, phase, momentum, volatility,
   liquidity, levels, smart money, MTF alignment).
4. Chart image upload → optional AI review via the user's own Anthropic API key.
5. Dashboard: ticker tape, NASDAQ and Indian market watchlists, NIFTY / BANK NIFTY
   index bias.
6. History of past reports, stored locally.

## Testing

- Indicators checked against hand-computed and published reference values
  (e.g., Wilder's RSI/ATR/ADX textbook series).
- Analysis modules checked on synthetic uptrend / downtrend / range / sweep fixtures.
- Provider parsers checked on recorded responses.
- End-to-end: launch the built app and drive the main workflow.
