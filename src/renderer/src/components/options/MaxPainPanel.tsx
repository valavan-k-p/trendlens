import type { ChainSummary } from '@core/options/option-analytics';
import type { OptionChain } from '@core/options/types';
import { compact, num, strike } from '../../lib/optionsFormat';
import { StrikeBars } from './charts';

export function MaxPainPanel({ chain, s, strikes }: { chain: OptionChain; s: ChainSummary; strikes: Set<number> }) {
  const mp = s.maxPain;
  if (!mp) return <div className="card oc-note">Max Pain needs open interest; this chain has none.</div>;
  const curve = mp.curve.filter((p) => strikes.has(p.strike));
  const dist = s.underlying !== undefined ? s.underlying - mp.strike : undefined;
  const money = chain.oiUnit === 'units' || (chain.oiUnit === 'lots' && chain.lotSize);
  const unit = money ? 'rupees (OI × intrinsic value)' : 'price × lots';
  const fmt = (v: number | undefined) => (v === undefined ? '—' : `${money ? '₹' : ''}${compact(v)}`);
  return (
    <div className="oc-panels">
      <div className="oc-cards">
        <div className="oc-card">
          <label>Max Pain strike</label>
          <b className="tone-warn">{strike(mp.strike)}</b>
          <small>lowest total payout to option holders</small>
        </div>
        <div className="oc-card">
          <label>{chain.underlyingIsFutures ? 'Futures price' : 'Underlying price'}</label>
          <b>{s.underlying !== undefined ? num(s.underlying, 2) : '—'}</b>
          <small>{chain.symbol}</small>
        </div>
        <div className="oc-card">
          <label>Distance to Max Pain</label>
          <b>{dist !== undefined ? `${dist >= 0 ? '−' : '+'}${num(Math.abs(dist), 2)}` : '—'}</b>
          <small>{dist !== undefined && s.underlying ? `${((Math.abs(dist) / s.underlying) * 100).toFixed(2)}% ${dist >= 0 ? 'below' : 'above'} the underlying` : 'underlying not reported'}</small>
        </div>
        <div className="oc-card">
          <label>Payout at Max Pain</label>
          <b>{fmt(mp.payout)}</b>
          <small>{unit}</small>
        </div>
      </div>
      <div className="card">
        <h4>
          <span>Total intrinsic payout if the expiry settles at each strike</span>
          <span>{unit}</span>
        </h4>
        <StrikeBars
          strikes={curve.map((p) => p.strike)}
          mode="stacked"
          series={[
            { label: 'Calls pay', color: 'var(--bear)', values: curve.map((p) => p.callPayout) },
            { label: 'Puts pay', color: 'var(--bull)', values: curve.map((p) => p.putPayout) },
          ]}
          markers={[
            ...(s.underlying !== undefined ? [{ at: s.underlying, label: `Spot ${s.underlying.toFixed(0)}`, color: 'var(--accent)' }] : []),
            { at: mp.strike, label: 'Max Pain', color: 'var(--warn)', dashed: true },
          ]}
          highlight={mp.strike}
          height={300}
          format={fmt}
        />
        <p className="oc-note">
          For each settlement strike S, payout = Σ call OI × max(S − K, 0) + Σ put OI × max(K − S, 0) over every strike K the provider returned
          {chain.oiUnit === 'units' ? ', with OI counted in units of the underlying (so the result is in rupees).' : chain.lotSize ? `, × lot size ${chain.lotSize}.` : '. OI is in lots and the contract multiplier is unknown, so payouts are in price × lots.'}{' '}
          The lot size scales every strike equally, so it never changes which strike is Max Pain. Max Pain is a statistic of open positions, not a forecast.
        </p>
      </div>
    </div>
  );
}
