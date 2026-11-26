# How TrendLens analysis works

Every output is a deterministic function of the OHLCV bars: same data in, same report out.
Source: `src/core/analysis/` (engine, structure, levels, smartMoney) and `src/core/indicators/`.
TrueTrendView's own algorithms are not public; these rules are TrendLens's own design,
built to produce the outputs that site documents (see `research/FEATURES.md`).

## Indicators (`src/core/indicators/index.ts`)

| Indicator | Definition |
| --- | --- |
| SMA / WMA | Simple / linearly weighted mean |
| EMA | α = 2/(n+1), seeded with the SMA of the first n values |
| RMA | Wilder smoothing, α = 1/n, SMA-seeded (used by RSI, ATR, ADX) |
| RSI(14) | Wilder. Verified against the published StockCharts reference series (exact by hand on the first value: 70.464; ≤0.15 rounding drift after) |
| MACD(12,26,9) | EMA12 − EMA26, signal EMA9, histogram = difference |
| ATR(14) | RMA of true range |
| ADX/DMI(14) | Wilder +DM/−DM, DI, DX, ADX = RMA(DX) |
| Bollinger(20,2) | SMA ± 2 × population standard deviation |
| Stochastic(14,3,3) | %K = SMA3 of raw %K, %D = SMA3 of %K |
| OBV, A/D line, CMF(20), MFI(14) | Standard volume formulas |
| VWAP | Typical-price VWAP, reset at each exchange-local day |
| Supertrend(10,3) | ATR bands with ratcheting final bands |

## Modules and scores (each −100 … +100 unless noted)

- **Market structure** — fractal swing points (3 bars each side; 4 for >400 bars),
  merged so highs and lows alternate, labelled HH/LH/HL/LL. A close beyond the last
  *confirmed* swing high/low is a BOS; if it reverses the prevailing trend it is a CHoCH.
  Integrity = share of the last six swing labels that agree with the trend.
- **Trend strength matrix** — EMA 20/50/200 stack (30%), price vs EMAs (20%),
  Supertrend (20%), 20-bar regression slope in ATR units (30%), scaled by ADX.
- **Momentum** — RSI distance from 50, MACD histogram in ATR units, ROC(10),
  ±20 for RSI divergence on the last two swings. *Market pulse*: "Expanding" when
  |MACD hist| rose two bars running with range ≥ ATR; "Fading" when it fell twice.
- **Volatility regime** (not directional) — ATR% percentile over 100 bars:
  ≤20 compressed, ≥70 elevated, ≥90 extreme. Range conditions: ADX < 20, or
  Bollinger-width percentile ≤ 25 with ADX < 25.
- **Liquidity participation** — OBV 10-bar slope, CMF(20), MFI(14), boosted when
  5-bar relative volume > 1.2. Skipped when the source reports no volume.
- **Price behaviour** — swing points clustered within 0.6 × ATR form S/R levels
  (strength = touches + recency). Round-number levels use a 1/2/2.5/5 × 10ᵏ step
  near 1% of price. Break-and-retest: a close through a level in the last 30 bars,
  then a return within 0.35 × ATR.
- **Smart money** — liquidity sweep (wick through a confirmed swing level that
  closes back inside, last 15 bars); trap (close through a level reversed within
  3 bars); order block (last opposite candle before a ≥1.5 × ATR three-bar
  displacement, dropped once closed through); fair-value gap (three-candle
  imbalance not yet filled); equal highs/lows (within 0.15 × ATR); institutional
  bars (volume ≥ 2× average with body ≥ 60% of range); A/D-line slope.
- **Multi-timeframe alignment** — a compact bias (structure, EMA20/50, RSI,
  Supertrend) on two higher timeframes (e.g. 15m → 1h, 1d; 1d → 1wk, 1mo).

## Core outputs

- **Bias score** = weighted mean: structure 26%, trend 20%, momentum 16%,
  multi-timeframe 16%, smart money 10%, price behaviour 6%, liquidity 6%
  (weights of unavailable modules are redistributed).
- **Market condition** — Consolidating if range conditions and |bias| < 40;
  else ≥ 60 Strong Bullish, ≥ 20 Bullish, ≤ −60 Strong Bearish, ≤ −20 Bearish,
  otherwise Neutral.
- **Confidence** (5–95) = 0.45 × |bias| + 50 × (share of directional modules agreeing)
  − 10 extreme volatility − 10 if < 150 bars − 5 if no volume.
- **Strength index** (0–100) = 40% ADX (45 → 100), 25% |momentum|, 20% expansion,
  15% relative volume.
- **Market phase** — Markup / Markdown when trending; in a range: Distribution after
  an advance, Accumulation after a decline (EMA50 change over the prior 40 bars > 2 ATR),
  else Range; Transition when structure and swing sequence disagree.
- **Risk environment** — one flag each for: no-trade zone (range and price in the
  middle 40% of the 50-bar range, or confidence < 30); late entry (> 2.5 ATR from
  EMA20 or RSI > 75 / < 25 in the bias direction); counter-trend (every higher
  timeframe opposes); extreme volatility; opposing level within 0.5 ATR; divergence
  against the bias; a sweep/trap against the bias in the last 5 bars.
  0 flags Low, 1 Moderate, 2 Elevated, 3+ High.

## Validation

`npm test` runs 137 checks (the option-chain math is covered in `docs/OPTIONS.md`): indicator reference values and identities, synthetic
uptrend/downtrend/range/sweep/trap/FVG fixtures, parsers against recorded Yahoo and
Binance responses, MT4 `.hst` v400/v401 decoding and source selection, CSV formats,
resampling, and watchlist parsing.
