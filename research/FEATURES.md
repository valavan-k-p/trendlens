# TrueTrendView — public feature research

Researched 2026-11-26 from the public marketing site only (https://truetrendview.com:
`/`, `/features`, `/how`, `/pricing`, `/support`, `/contact`). The product itself
("ZEM AI") lives at `app.truetrendview.com` behind login/paid plans and was **not**
accessed. Nothing below comes from authenticated pages.

## Method

1. Rendered every public page in a browser and read the full text.
2. Downloaded the public JS bundle (`static/js/main.2c39dad3.js`, 272 KB) into
   `research/site-bundle/` and ran REA static analysis on it:
   `rea analyze-javascript-application ... --detail summary`
   (evidence bundle: `research/rea-site-bundle.evidence.json`, parent evidence
   `ev_d355d12c…`). REA's route view returned no candidates because the analyzer
   hit its member-mutation alias-state limit on this minified bundle (reported as
   a limitation, not as absence). URL and path literals were extracted directly.
3. Findings from the bundle: the marketing site is a React SPA. It contains **no
   analysis logic** — only page copy, a TradingView ticker-tape embed
   (`tradingview-widget.com/embed-widget/ticker-tape`), a Tawk.to support chat,
   and links to `app.truetrendview.com` (login/signup) and `admin.truetrendview.com`.
   So the analysis algorithms are **unknown**; the clone's engine is our own design,
   built to produce the same documented outputs.

## Observed workflow ("How it works")

1. **Search a symbol** — stock, forex pair, crypto asset, or index (example: NIFTY 50).
2. **Preview the chart** — review latest candles, choose timeframe (example: 15 min).
3. **Analyse** — pipeline stages shown: Symbol → Timeframe → Context (mapped) →
   Structure (trend + levels) → Momentum (flow + liquidity) → Risk view.
4. Result groups: **Market bias**, **Key levels**, **Risk lens**.
5. Alternative entry: **upload a chart image** ("Upload. Review. Decide."; plans
   limit 5 or 12 uploads/day).

## Documented output ("Core Output")

| Output | Description on site |
| --- | --- |
| Market Condition | Bullish / bearish / neutral / consolidating, from structure + momentum |
| Confidence Level | Strength of interpretation from momentum, liquidity, structure signals |
| Strength Index | Numeric power of the move; continue vs. lose traction |
| Risk Environment | Late-entry zones, no-trade regions, counter-trend warnings |
| Insight Summary | Concise explanation of what the market is doing and why |
| Strategic Market Verdict | "Bottom line" summary |

## Documented analysis modules

- **Structural intelligence**: trend identification, market phase evaluation,
  structure integrity.
- **Market dynamics**: momentum, volatility, liquidity; sustainable vs. exhausted.
- **Price behavior**: support & resistance, break and retest, psychological levels.
- **Smart money**: trap detection, liquidity sweeps, institutional activity, order
  blocks, accumulation/distribution, money flow.
- **Risk control**: no-trade zone detection, late-entry warnings, counter-trend alerts.
- Pricing-page module names: Market Bias Intelligence, Confidence Probability Engine,
  Index Bias Module (NIFTY / BANK NIFTY), Volatility & Risk Regime Analyzer,
  Strategic Market Context, Institutional Trend Strength Matrix, Momentum Expansion
  Tracker (Market Pulse), Market Phase Intelligence, Market Structure Integrity
  Monitor, Institutional Zone Intelligence, Multi-Timeframe Alignment Engine,
  Liquidity Participation Meter.

## Other public UI

- Scrolling ticker tape: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, GBPJPY, XAUUSD,
  XAGUSD, USOIL, NAS100, US30, SPX500, GER40, BTCUSD, ETHUSD, SOLUSD, XRPUSD, AAPL,
  TSLA, NVDA, MSFT, AMZN.
- "NASDAQ live prices" and "Indian market live prices" panels.
- Positioning: educational, "not indicator-based", "not signal-driven", no buy/sell
  calls; prominent disclaimer.
- Dark theme, cyan/teal accents.

## Not reproduced (and why)

- Login, signup, plans, Razorpay payments, upload quotas — user asked for no login;
  personal app.
- Support tickets / Tawk.to chat / contact form — service-side features.
- Name, logo, "ZEM AI" branding, and copy — the clone uses its own name.
- Their actual algorithms — not public. Ours are documented in `docs/ANALYSIS.md`.
