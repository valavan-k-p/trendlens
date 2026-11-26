# TrendLens

A personal Windows desktop app for structured, educational chart analysis — market
structure, momentum, liquidity and risk in one view. It reproduces the publicly
documented workflow of truetrendview.com (search a symbol → preview the chart →
analyse → structured review) with its own name, design and analysis engine.
No login: it opens straight to the analyzer.

> Outputs are educational and informational only — not investment advice or buy/sell
> recommendations.

## Run it

**Installed app** (after `npm run dist`):

- `release\TrendLens Setup 1.0.0.exe` — installer (Start menu + desktop shortcut), or
- `release\TrendLens-Portable-1.0.0.exe` — single portable exe, no install.

**From source** (Node.js 22.12+):

```powershell
npm install
npm run build
npm start
```

`npm run dev` runs with hot reload. `npm test` runs the test suite.
`npm run dist` builds the Windows installer and portable exe into `release\`.

## Features

| Area | What you get |
| --- | --- |
| Analyzer | Live candlestick chart (1m … 1mo), EMA 20/50/200, VWAP, Bollinger, Supertrend, volume, RSI / MACD / Stochastic / ADX pane |
| Analysis report | Market condition, confidence, strength index, risk environment, market phase, insight summary, bottom line |
| Modules | Market structure (HH/HL, BOS, CHoCH), trend strength matrix, momentum + pulse, volatility regime, liquidity participation, price behaviour (S/R, round numbers, break & retest), smart money (sweeps, traps, order blocks, FVGs, equal highs/lows, A/D), multi-timeframe alignment, risk control |
| Chart overlays | Key levels, order-block / FVG zones, structure and sweep/trap markers |
| Markets | Scrolling global ticker, NASDAQ & Indian live price tables, NIFTY / BANK NIFTY index bias |
| AI chart review | Upload, paste or drop a chart screenshot for a structured review by Claude (needs your own Anthropic API key) |
| History | Save reports locally, revisit, export as Markdown |
| Data | Yahoo Finance (NSE/BSE, US, indices, forex, futures), Binance (crypto), CSV import |

Keyboard: `Ctrl+K` search · `F5` analyse · `Ctrl+O` import CSV · `Ctrl+E` export ·
`Ctrl+1…4` switch views · `Ctrl+,` settings.

## Project layout

```
src/core/        pure TypeScript, fully unit-tested
  indicators/    SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, Stochastic, OBV, MFI, CMF, VWAP, Supertrend
  analysis/      structure, levels, smart money, scoring engine → AnalysisReport
  data/          Yahoo + Binance parsers, CSV import, resampling
src/main/        Electron main process: window, menu, network, settings/history, AI review
src/preload/     typed IPC bridge
src/renderer/    React UI (chart, report, markets, AI review, history, settings)
tests/           Vitest suites + recorded API responses
research/        public-site research notes and REA evidence
docs/            PLAN.md, ANALYSIS.md (every rule and threshold)
```

## Data sources and notes

- Yahoo Finance public chart/search endpoints: no key; unofficial, intended here for
  personal use; quotes for some exchanges are delayed. Indices and forex report no
  volume, so volume modules are skipped for them.
- Binance public market data: official, no key.
- Settings, history and the encrypted API key live in `%APPDATA%\trendlens\`.
- The Anthropic key is encrypted with Windows DPAPI and used only by the main
  process; each AI review is billed to your Anthropic account.
