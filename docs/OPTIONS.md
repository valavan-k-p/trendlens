# Option Chain module

The Option Chain tab (Ctrl+5) shows a live option chain with analytics, OI analysis, Greeks/IV,
Max Pain and locally captured history. Calculations live in `src/core/options/`; network, files
and credentials stay in the main process (`src/main/options/`).

## Data sources (researched 26 Nov 2026)

| Source | Exchanges | Access | Used for |
| --- | --- | --- | --- |
| Upstox instrument master — `assets.upstox.com/market-quote/instruments/exchange/{NSE,BSE}.json.gz` | NSE, BSE | Public, no key | Underlyings, lot sizes, expiries |
| Upstox Put/Call Option Chain — `GET api.upstox.com/v2/option/chain` | NSE, BSE (not MCX) | Bearer token; the free **Analytics Token** (read-only, 1-year validity) covers it | Live chain (default provider) |
| Dhan scrip master — `images.dhan.co/api-data/api-scrip-master-detailed.csv` | NSE, BSE, MCX | Public, no key | Underlyings, lot sizes, expiries, MCX futures ids |
| Dhan Option Chain — `POST api.dhan.co/v2/optionchain` | NSE, BSE, MCX | `access-token` + `client-id` headers; Data API plan (₹499/month); tokens last 24 h; 1 request / 3 s | MCX chains; optional NSE/BSE provider |
| CSV import | any | local file | Offline fallback, e.g. the CSV the NSE website lets a person download |

Not used: NSE/BSE website endpoints (undocumented, bot-protected) and any scraping. Exchange
"official" data feeds need vendor licences and are out of scope for a personal app.

Routing: NSE and BSE use the provider chosen in Settings (Upstox by default); MCX always uses
Dhan. Without credentials the tab says exactly what is missing and offers CSV import.

### Units and field notes

- Upstox OI, volume and quantities are in **units**: the documented example's OI 750 is 10 lots
  of 75, and its per-strike `pcr` equals put OI ÷ call OI. `iv` is in percent. `close_price` is
  the previous close. Greeks are reported as Upstox computes them (shown as "P").
- Dhan does not document OI units. NSE/BSE quantities are treated as units (bid/ask quantities are
  multiples of the lot size); MCX quantities are in lots (lot size 1 in Dhan's list), and the MCX
  contract multiplier is not in the list, so MCX Max Pain payouts are shown in price × lots.
- MCX options are options on futures. The underlying sent to Dhan is the futures contract
  expiring on or after the option expiry. This mapping is from the instrument list and has not
  been verified against a live Dhan account.

## Calculations

| Output | Method |
| --- | --- |
| PCR (OI / volume) | Σ put ÷ Σ call over all strikes returned; undefined when the call side is 0 |
| ATM | Strike nearest the underlying (lower strike on a tie) |
| Max Pain | For each settlement strike S: Σ callOI·max(S−K,0) + Σ putOI·max(K−S,0), × units per OI figure; lowest total wins |
| Build-up | Per leg: price↑OI↑ long build-up, price↓OI↑ short build-up, price↑OI↓ short covering, price↓OI↓ long unwinding. Call/put writing = short build-up, labelled as interpretation |
| Support / resistance | Highest put OI at or below spot / highest call OI at or above spot |
| OI concentration | Share of a side's OI in its top 3 strikes |
| Pricing model | Spot options: Black-Scholes with carry yield q implied by put-call parity near the money (equivalent to Black-76 on the parity forward); if parity cannot be measured, the Settings dividend yield, labelled "assumed". Options on futures: Black-76 |
| Time to expiry | ACT/365 to 15:30 IST (NSE/BSE) or 23:30 IST (MCX, assumed) on expiry day |
| IV | Provider IV when present; otherwise solved (Newton with bisection fallback) from the bid/ask mid, or LTP |
| Greeks | Provider values when delta is strictly in range and within 0.10 of the model; else calculated. Theta per calendar day, vega and rho per 1 point. Rho always calculated |
| IV skew | Put IV at ≈ (1 − w)·F minus call IV at ≈ (1 + w)·F; w = 3 % (5 % for futures) |
| IV rank / percentile | Over the last ATM IV captured on each IST day (nearest expiry); needs 20 captured days |
| r | Settings → Option chain data (default 6.5 %, an assumption shown on the Greeks tab) |

## History

While the tab refreshes, a compact snapshot is saved per exchange/underlying/expiry at the
interval chosen in Settings (default 60 s) to `%APPDATA%\trendlens\options\snapshots\*.jsonl`
(at most 3,000 per file). History, PCR trend, IV change vs the previous captured day and IV rank
use only these snapshots; nothing is back-filled. Imported CSVs can be saved as snapshots.

## Verification

- 49 unit tests (`tests/options-math.test.ts`, `tests/options-data.test.ts`): normal CDF, Hull's
  Black-Scholes and Black-76 reference examples, Greeks vs finite differences, IV round trips and
  bounds, hand-worked Max Pain examples, PCR, ATM/ITM/OTM, sorting/filtering, build-up, support
  and resistance, expiry/session timing, stale detection, parity forward and carry recovery,
  provider-Greek reliability, smile/skew, IV rank, Upstox and Dhan parsing of their documented
  examples, instrument lists, CSV formats, snapshot round trip, comparison and on-disk storage.
- UI checked end to end against a local mock that returns Upstox's documented response shape,
  with the real public instrument lists (NSE, BSE via Upstox; MCX via Dhan).
- Not verified: a live Upstox or Dhan account (needs the user's own token), and Dhan's MCX
  futures mapping.

`TRENDLENS_UPSTOX_CHAIN_URL` (environment variable) redirects the Upstox chain request; it exists
only for that mock test and is not set in normal use.
