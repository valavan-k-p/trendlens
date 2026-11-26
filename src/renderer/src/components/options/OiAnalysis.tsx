import { useMemo } from 'react';
import type { ChainSummary } from '@core/options/option-analytics';
import { inLots } from '@core/options/option-chain';
import { BUILDUP_LABEL, buildupByStrike, buildupCounts, oiConcentration, supportResistance, writingLabel, type Buildup } from '@core/options/oi-analysis';
import { pcrReading } from '@core/options/pcr';
import type { OptionChain, StrikeRow } from '@core/options/types';
import type { OptionSnapshotMeta } from '../../../../shared/api';
import { compact, fixed, pct, ratio, signedCompact, strike, timeTick } from '../../lib/optionsFormat';
import { LineChart, StrikeBars, type Marker } from './charts';

const CALL = 'var(--bear)';
const PUT = 'var(--bull)';

export function chainMarkers(s: ChainSummary): Marker[] {
  const m: Marker[] = [];
  if (s.underlying !== undefined) m.push({ at: s.underlying, label: `Spot ${s.underlying.toFixed(0)}`, color: 'var(--accent)' });
  if (s.maxPain) m.push({ at: s.maxPain.strike, label: 'Max Pain', color: 'var(--warn)', dashed: true });
  return m;
}

function TotalsBar({ label, call, put, fmt }: { label: string; call: number; put: number; fmt: (v: number) => string }) {
  const max = Math.max(Math.abs(call), Math.abs(put), 1);
  return (
    <div className="oc-total">
      <label>{label}</label>
      <div className="oc-total-row">
        <span>Calls</span>
        <i style={{ width: `${(Math.abs(call) / max) * 100}%`, background: CALL, opacity: call < 0 ? 0.45 : 1 }} />
        <b>{fmt(call)}</b>
      </div>
      <div className="oc-total-row">
        <span>Puts</span>
        <i style={{ width: `${(Math.abs(put) / max) * 100}%`, background: PUT, opacity: put < 0 ? 0.45 : 1 }} />
        <b>{fmt(put)}</b>
      </div>
    </div>
  );
}

const BUILD_TONE: Record<Buildup, string> = { 'long-buildup': 'tone-bull', 'short-buildup': 'tone-bear', 'short-covering': 'tone-bull', 'long-unwinding': 'tone-bear', none: '' };

export function OiAnalysis({
  chain,
  rows,
  s,
  units,
  pcrHistory,
  onPick,
}: {
  chain: OptionChain;
  rows: StrikeRow[];
  s: ChainSummary;
  units: 'lots' | 'units';
  pcrHistory: OptionSnapshotMeta[];
  onPick: (strike: number) => void;
}) {
  const lots = units === 'lots' && chain.oiUnit === 'units' && !!chain.lotSize;
  const conv = (v: number | undefined) => (lots ? inLots(v, chain) : v);
  const strikes = rows.map((r) => r.strike);
  const markers = chainMarkers(s);
  const build = useMemo(() => buildupByStrike(rows), [rows]);
  const sr = supportResistance(chain.rows, s.underlying, 3);
  const cc = oiConcentration(chain.rows, 'call', 3);
  const pc = oiConcentration(chain.rows, 'put', 3);
  const callCounts = buildupCounts(build, 'call');
  const putCounts = buildupCounts(build, 'put');
  const unit = chain.oiUnit === 'lots' || lots ? 'lots' : 'qty';

  return (
    <div className="oc-panels">
      <div className="grid-2">
        <div className="card">
          <h4>
            <span>Call OI vs Put OI by strike</span>
            <span>{unit}</span>
          </h4>
          <StrikeBars
            strikes={strikes}
            series={[
              { label: 'Call OI', color: CALL, values: rows.map((r) => conv(r.call?.oi)) },
              { label: 'Put OI', color: PUT, values: rows.map((r) => conv(r.put?.oi)) },
            ]}
            markers={markers}
            highlight={s.atm}
            format={compact}
            onPick={onPick}
          />
        </div>
        <div className="card">
          <h4>
            <span>Change in OI by strike</span>
            <span>{unit}</span>
          </h4>
          <StrikeBars
            strikes={strikes}
            series={[
              { label: 'Call Chg OI', color: CALL, values: rows.map((r) => conv(r.call?.oiChange)) },
              { label: 'Put Chg OI', color: PUT, values: rows.map((r) => conv(r.put?.oiChange)) },
            ]}
            markers={markers}
            highlight={s.atm}
            format={signedCompact}
            onPick={onPick}
          />
        </div>
        <div className="card">
          <h4>
            <span>Volume by strike</span>
            <span>{unit}</span>
          </h4>
          <StrikeBars
            strikes={strikes}
            series={[
              { label: 'Call volume', color: CALL, values: rows.map((r) => conv(r.call?.volume)) },
              { label: 'Put volume', color: PUT, values: rows.map((r) => conv(r.put?.volume)) },
            ]}
            markers={markers}
            highlight={s.atm}
            format={compact}
            onPick={onPick}
          />
        </div>
        <div className="card">
          <h4>
            <span>PCR trend (captured on this PC)</span>
            <span>{pcrHistory.length} snapshots</span>
          </h4>
          <LineChart
            series={[
              { label: 'OI PCR', color: 'var(--accent)', points: pcrHistory.map((h) => ({ x: h.t, y: h.summary.pcrOi })) },
              { label: 'Volume PCR', color: 'var(--accent-2)', points: pcrHistory.map((h) => ({ x: h.t, y: h.summary.pcrVolume })), dashed: true },
            ]}
            formatX={timeTick}
            formatY={(y, d) => fixed(y, d, 2)}
          />
          <p className="oc-note">Each point is a snapshot TrendLens saved while this chain was refreshing. Nothing is filled in for times it was not running.</p>
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <h4>Totals</h4>
          <TotalsBar label={`Open interest (${unit})`} call={conv(s.totalCallOi) ?? 0} put={conv(s.totalPutOi) ?? 0} fmt={compact} />
          <TotalsBar label={`Change in OI (${unit})`} call={conv(s.totalCallOiChange) ?? 0} put={conv(s.totalPutOiChange) ?? 0} fmt={signedCompact} />
          <p className="oc-note">
            OI PCR {ratio(s.pcr.oi)}: {pcrReading(s.pcr.oi)}. Interpretation only.
          </p>
        </div>
        <div className="card">
          <h4>Potential support and resistance (OI)</h4>
          <div className="oc-sr">
            <div>
              <label className="tone-bull">Support · put OI below</label>
              {sr.supports.length ? sr.supports.map((x) => <div key={x.strike}>{strike(x.strike)} <small>{compact(conv(x.oi))}</small></div>) : <div className="oc-note">—</div>}
            </div>
            <div>
              <label className="tone-bear">Resistance · call OI above</label>
              {sr.resistances.length ? sr.resistances.map((x) => <div key={x.strike}>{strike(x.strike)} <small>{compact(conv(x.oi))}</small></div>) : <div className="oc-note">—</div>}
            </div>
          </div>
          <p className="oc-note">Strikes with the heaviest open interest on each side of the underlying. They mark where positions are concentrated, not guaranteed turning points.</p>
        </div>
        <div className="card">
          <h4>OI concentration</h4>
          <div className="signal">
            <span>Top 3 call strikes hold</span>
            <b>{cc ? `${pct(cc.share * 100, 1)} (${cc.strikes.map(strike).join(', ')})` : '—'}</b>
          </div>
          <div className="signal">
            <span>Top 3 put strikes hold</span>
            <b>{pc ? `${pct(pc.share * 100, 1)} (${pc.strikes.map(strike).join(', ')})` : '—'}</b>
          </div>
          <div className="signal">
            <span>Calls: long / short build-up</span>
            <b>
              {callCounts['long-buildup']} / {callCounts['short-buildup']}
            </b>
          </div>
          <div className="signal">
            <span>Puts: long / short build-up</span>
            <b>
              {putCounts['long-buildup']} / {putCounts['short-buildup']}
            </b>
          </div>
          <p className="oc-note">Counts over the strikes shown.</p>
        </div>
      </div>

      <div className="card">
        <h4>
          <span>Build-up by strike (price change × OI change, vs previous day)</span>
          <span>interpretation, not confirmed participant activity</span>
        </h4>
        <table className="quotes oc-build">
          <thead>
            <tr>
              <th className="num">Call Chg</th>
              <th className="num">Call Chg OI</th>
              <th>Call reading</th>
              <th className="num">Strike</th>
              <th>Put reading</th>
              <th className="num">Put Chg OI</th>
              <th className="num">Put Chg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const b = build[i];
              return (
                <tr key={r.strike} className={r.strike === s.atm ? 'atm' : ''} onClick={() => onPick(r.strike)}>
                  <td className={`num ${(r.call?.change ?? 0) > 0 ? 'up' : (r.call?.change ?? 0) < 0 ? 'down' : ''}`}>{r.call?.change?.toFixed(2) ?? '—'}</td>
                  <td className="num">{signedCompact(conv(r.call?.oiChange))}</td>
                  <td className={BUILD_TONE[b.call]}>
                    {BUILDUP_LABEL[b.call]}
                    {writingLabel('call', b.call) && <small className="oc-interp"> · {writingLabel('call', b.call)}</small>}
                  </td>
                  <td className="num">
                    <b>{strike(r.strike)}</b>
                  </td>
                  <td className={BUILD_TONE[b.put]}>
                    {BUILDUP_LABEL[b.put]}
                    {writingLabel('put', b.put) && <small className="oc-interp"> · {writingLabel('put', b.put)}</small>}
                  </td>
                  <td className="num">{signedCompact(conv(r.put?.oiChange))}</td>
                  <td className={`num ${(r.put?.change ?? 0) > 0 ? 'up' : (r.put?.change ?? 0) < 0 ? 'down' : ''}`}>{r.put?.change?.toFixed(2) ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="oc-note">
          Long build-up = price ↑ OI ↑ · Short build-up = price ↓ OI ↑ · Short covering = price ↑ OI ↓ · Long unwinding = price ↓ OI ↓. Short build-up on calls or puts is commonly read as call or
          put writing; the data cannot confirm who traded.
        </p>
      </div>
    </div>
  );
}
