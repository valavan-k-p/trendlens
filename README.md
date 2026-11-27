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

- `release\TrendLens Setup 1.2.0.exe` — installer (Start menu + desktop shortcut), or
- `release\TrendLens-Portable-1.2.0.exe` — single portable exe, no install.

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
| Option Chain | NSE/BSE/MCX option chains (calls · strike · puts, 10 columns a side), ATM/ITM/OTM, highest OI and OI additions, sorting and filters; 14-figure dashboard (PCR, Max Pain, …); OI analysis with build-up, support/resistance, concentration and strike charts; Greeks and IV (provider or Black-Scholes/Black-76), IV smile, skew, IV rank; Max Pain chart; saved snapshots with comparisons. See `docs/OPTIONS.md` |
| AI chart review | Upload, paste or drop a chart screenshot for a structured AI review with your own key: Claude, OpenAI, Google Gemini, OpenRouter, Groq or any OpenAI-compatible server (DeepSeek, Ollama, LM Studio) |
| History | Save reports locally, revisit, export as Markdown |
| Data | MetaTrader 4 history (primary: Indian indices, MCX, options), Yahoo Finance, Binance, CSV import |

Keyboard: `Ctrl+K` search · `F5` analyse · `Ctrl+O` import CSV · `Ctrl+E` export ·
`Ctrl+1…5` switch views (5 = Option Chain) · `Ctrl+,` settings.

## Project layout

```
src/core/        pure TypeScript, fully unit-tested
  indicators/    SMA, EMA, RSI, MACD, ATR, ADX, Bollinger, Stochastic, OBV, MFI, CMF, VWAP, Supertrend
  analysis/      structure, levels, smart money, scoring engine → AnalysisReport
  data/          Yahoo + Binance + MT4 parsers, CSV import, resampling
  options/       option chain model, PCR, Max Pain, OI analysis, Greeks/IV, snapshots,
                 Upstox / Dhan / CSV parsers
src/main/        Electron main process: window, menu, network, settings/history, AI review
src/preload/     typed IPC bridge
src/renderer/    React UI (chart, report, markets, AI review, history, settings)
tests/           Vitest suites + recorded API responses
research/        public-site research notes and REA evidence
docs/            PLAN.md, ANALYSIS.md (every rule and threshold)
```

## Data sources and notes

- **MetaTrader 4 (primary).** TrendLens reads MT4's own chart history files (`.hst`)
  read-only, from every data folder under `%APPDATA%\MetaQuotes\Terminal\` plus any
  folder added in Settings. MT4 symbols are listed first in search (tagged **MT4**),
  and the app opens on MT4's NIFTY. Your broker's MT4 includes NIFTY, BANKNIFTY,
  SENSEX, SENSEX futures, MCX crude oil and natural gas, gold, silver and option strikes.
  - **Live bars** need the bundled **TrendLensFeed** EA (`resources/mt4/`), because MT4
    only saves its history files when it closes. Settings → **Install MT4 live feed**
    copies it into MT4; then in MT4 refresh Expert Advisors, drag TrendLensFeed onto a
    chart and keep AutoTrading on. It has no trading code and writes only to
    `%APPDATA%\MetaQuotes\Terminal\Common\Files\TrendLens\`. TrendLens also reads the
    MarketDataExporter EA's output (`Common\Files\MT4AI\`) if present.
  - With the feed attached, bars match MT4 exactly (same broker bar grid, e.g. hourly
    NIFTY bars at :45 server time). Without MT4 running, charts show the last saved data.
  - If a timeframe's file is missing or shorter, TrendLens builds it from a finer MT4
    timeframe that has more history (e.g. 15m from 5m).
  - Too little history? Open the chart in MT4 and press Home to download more.
  - Bar times are the broker's server time; tick volume is used as volume.
- **Option chains.** NSE and BSE come from Upstox's documented option-chain API with your free
  Upstox Analytics Token (read-only, valid one year); MCX comes from Dhan (Data API plan, daily
  token). Settings → Option chain data stores them encrypted. Without a token, the Option Chain
  tab says what is missing and accepts a CSV (e.g. the NSE website's download). Underlyings, lot
  sizes and expiries come from the providers' public instrument lists. Snapshots are saved
  locally for history. Without a broker API, **Source → MetaTrader 4 (prices)** shows live option
  prices from your MT4 (TrendLensFeed 1.10 exports the option symbols in Market Watch) with
  calculated IV and Greeks; MT4 has no option OI, so PCR and Max Pain need a broker API.
  Details and assumptions: `docs/OPTIONS.md`.
- Yahoo Finance public chart/search endpoints: no key; unofficial, intended here for
  personal use; quotes for some exchanges are delayed. Indices and forex report no
  volume, so volume modules are skipped for them.
- Binance public market data: official, no key.
- Settings, history and the encrypted API key live in `%APPDATA%\trendlens\`.
- AI review keys are encrypted with Windows DPAPI and used only by the main process.
  Settings → AI provider can auto-detect the service from the key (`sk-ant-` Claude,
  `sk-` OpenAI, `AIza` Gemini, `sk-or-` OpenRouter, `gsk_` Groq); **Test** checks the key
  and lists its models. The chart image goes only to the chosen provider, and each
  review is billed to that account. The model must accept images.
