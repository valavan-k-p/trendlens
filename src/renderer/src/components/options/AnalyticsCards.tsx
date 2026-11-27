import type { ChainSummary } from '@core/options/option-analytics';
import { inLots } from '@core/options/option-chain';
import type { Freshness } from '@core/options/option-contracts';
import type { OptionChain } from '@core/options/types';
import { age, compact, istTime, num, ratio, signedCompact, strike } from '../../lib/optionsFormat';

function Card({ label, value, sub, tone, title }: { label: string; value: string; sub?: string; tone?: string; title?: string }) {
  return (
    <div className="oc-card" title={title}>
      <label>{label}</label>
      <b className={tone}>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function AnalyticsCards({
  chain,
  s,
  units,
  freshness,
  now,
  session,
}: {
  chain: OptionChain;
  s: ChainSummary;
  units: 'lots' | 'units';
  freshness: Freshness;
  now: number;
  session: 'open' | 'closed';
}) {
  const lots = units === 'lots' && chain.oiUnit === 'units' && !!chain.lotSize;
  const unitLabel = chain.oiUnit === 'lots' || lots ? 'lots' : 'qty';
  const q = (v: number | undefined) => compact(lots ? inLots(v, chain) : v);
  const qs = (v: number | undefined) => signedCompact(lots ? inLots(v, chain) : v);
  const mp = s.maxPain;
  const hasOi = chain.rows.some((r) => r.call?.oi !== undefined || r.put?.oi !== undefined);
  const hasVol = chain.rows.some((r) => r.call?.volume !== undefined || r.put?.volume !== undefined);
  const noOi = chain.provider === 'mt4' ? 'not in MT4' : 'no OI data';
  const dist = mp && s.underlying !== undefined ? s.underlying - mp.strike : undefined;
  const pcrTone = (v?: number) => (v === undefined ? '' : v >= 1 ? 'tone-bull' : 'tone-bear');
  const fresh = freshness === 'fresh' ? 'tone-bull' : freshness === 'delayed' ? 'tone-warn' : 'tone-bear';
  const atmCard = <Card label="ATM" value={s.atm !== undefined ? strike(s.atm) : '—'} sub="nearest strike" />;
  const undCard = (
    <Card
      label={chain.underlyingIsFutures ? 'Futures' : 'Underlying'}
      value={s.underlying !== undefined ? num(s.underlying, 2) : '—'}
      sub={chain.underlyingPrice === undefined && s.underlying !== undefined ? 'from parity' : chain.symbol}
    />
  );
  const timeCard = (
    <Card
      label="Data time"
      value={istTime(chain.fetchedAt, false).replace(' IST', '')}
      sub={`IST · ${chain.provider === 'snapshot' ? 'snapshot' : chain.provider === 'csv' ? 'CSV' : session === 'closed' ? 'closed' : freshness}`}
      tone={chain.provider === 'upstox' || chain.provider === 'dhan' || chain.provider === 'mt4' ? fresh : 'tone-warn'}
      title={`${istTime(chain.fetchedAt)} · ${age(now - chain.fetchedAt)}`}
    />
  );
  if (!hasOi)
    // A price-only source (MetaTrader 4, some CSVs): show what the prices support and say what is missing.
    return (
      <div className="oc-cards">
        {atmCard}
        {undCard}
        {timeCard}
        <div className="oc-card" style={{ gridColumn: 'span 4' }}>
          <label>Open interest</label>
          <small style={{ whiteSpace: 'normal', marginTop: 4, color: 'var(--muted)' }}>
            {chain.provider === 'mt4' ? 'MetaTrader 4 sends option prices only.' : 'This chain has no open interest.'} OI totals, PCR, highest OI and Max Pain need a broker API source (Settings → Option
            chain data). IV and Greeks below are calculated from the prices.
          </small>
        </div>
      </div>
    );
  return (
    <div className="oc-cards oc-dash">
      <Card label="Call OI" value={hasOi ? q(s.totalCallOi) : '—'} sub={hasOi ? `total · ${unitLabel}` : noOi} />
      <Card label="Put OI" value={hasOi ? q(s.totalPutOi) : '—'} sub={hasOi ? `total · ${unitLabel}` : noOi} />
      <Card label="Call Chg OI" value={hasOi ? qs(s.totalCallOiChange) : '—'} tone={hasOi ? (s.totalCallOiChange >= 0 ? 'up' : 'down') : ''} sub={hasOi ? 'vs prev. day' : noOi} />
      <Card label="Put Chg OI" value={hasOi ? qs(s.totalPutOiChange) : '—'} tone={hasOi ? (s.totalPutOiChange >= 0 ? 'up' : 'down') : ''} sub={hasOi ? 'vs prev. day' : noOi} />
      <Card label="PCR (OI)" value={ratio(s.pcr.oi)} tone={pcrTone(s.pcr.oi)} sub={hasOi ? 'put ÷ call OI' : noOi} />
      <Card label="Volume PCR" value={ratio(s.pcr.volume)} tone={pcrTone(s.pcr.volume)} sub={hasVol ? 'put ÷ call vol' : chain.provider === 'mt4' ? 'not in MT4' : 'no volume data'} />
      <Card label="Max Call OI" value={s.maxCallOi ? strike(s.maxCallOi.strike) : '—'} sub={s.maxCallOi ? q(s.maxCallOi.value) : hasOi ? undefined : noOi} tone="tone-bear" />
      <Card label="Max Put OI" value={s.maxPutOi ? strike(s.maxPutOi.strike) : '—'} sub={s.maxPutOi ? q(s.maxPutOi.value) : hasOi ? undefined : noOi} tone="tone-bull" />
      <Card label="Call OI added" value={s.maxCallOiAdd ? strike(s.maxCallOiAdd.strike) : '—'} sub={s.maxCallOiAdd ? qs(s.maxCallOiAdd.value) : hasOi ? 'no additions' : noOi} />
      <Card label="Put OI added" value={s.maxPutOiAdd ? strike(s.maxPutOiAdd.strike) : '—'} sub={s.maxPutOiAdd ? qs(s.maxPutOiAdd.value) : hasOi ? 'no additions' : noOi} />
      <Card label="ATM" value={s.atm !== undefined ? strike(s.atm) : '—'} sub="nearest strike" />
      <Card
        label="Max Pain"
        value={mp ? strike(mp.strike) : '—'}
        sub={!hasOi ? noOi : dist !== undefined ? `spot ${dist >= 0 ? '+' : '−'}${num(Math.abs(dist), 1)}` : undefined}
        title={dist !== undefined ? `The underlying is ${num(Math.abs(dist), 2)} ${dist >= 0 ? 'above' : 'below'} Max Pain` : undefined}
      />
      <Card
        label={chain.underlyingIsFutures ? 'Futures' : 'Underlying'}
        value={s.underlying !== undefined ? num(s.underlying, 2) : '—'}
        sub={chain.underlyingPrice === undefined && s.underlying !== undefined ? 'from parity' : chain.symbol}
      />
      <Card
        label="Data time"
        value={istTime(chain.fetchedAt, false).replace(' IST', '')}
        sub={`IST · ${chain.provider === 'snapshot' ? 'snapshot' : chain.provider === 'csv' ? 'CSV' : session === 'closed' ? 'closed' : freshness}`}
        tone={chain.provider === 'upstox' || chain.provider === 'dhan' || chain.provider === 'mt4' ? fresh : 'tone-warn'}
        title={`${istTime(chain.fetchedAt)} · ${age(now - chain.fetchedAt)}`}
      />
    </div>
  );
}
