import { useEffect, useMemo, useState } from 'react';
import { inLots } from '@core/options/option-chain';
import { compareChains, fromSnapshot } from '@core/options/option-snapshots';
import type { OptionChain } from '@core/options/types';
import type { OptionSnapshotMeta } from '../../../../shared/api';
import { compact, expiryLabel, fixed, istTime, num, ratio, signedCompact, strike, timeTick } from '../../lib/optionsFormat';
import { LineChart, StrikeBars } from './charts';

export function HistoryPanel({
  chain,
  metas,
  expiry,
  strikes,
  units,
  snapshotSeconds,
  onView,
}: {
  chain: OptionChain;
  metas: OptionSnapshotMeta[];
  expiry: string;
  strikes: Set<number>;
  units: 'lots' | 'units';
  snapshotSeconds: number;
  onView: (m: OptionSnapshotMeta) => void;
}) {
  const [cmp, setCmp] = useState<OptionSnapshotMeta | null>(null);
  const [earlier, setEarlier] = useState<OptionChain | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sameExpiry = metas.filter((m) => m.expiry === expiry);
  const list = [...metas].reverse();
  const lots = units === 'lots' && chain.oiUnit === 'units' && !!chain.lotSize;
  const conv = (v: number | undefined) => (lots ? inLots(v, chain) : v);

  useEffect(() => {
    if (!cmp) return setEarlier(null);
    setErr(null);
    void window.trendlens
      .loadOptionSnapshot(chain.exchange, chain.symbol, cmp.expiry, cmp.t)
      .then((s) => (s ? setEarlier(fromSnapshot(s)) : setErr('That snapshot could not be read.')))
      .catch((e) => setErr(String(e?.message ?? e)));
  }, [cmp, chain.exchange, chain.symbol]);

  const diff = useMemo(() => (earlier ? compareChains(chain, earlier).filter((d) => strikes.has(d.strike)) : []), [chain, earlier, strikes]);

  return (
    <div className="oc-panels">
      <div className="grid-2">
        <div className="card">
          <h4>
            <span>Saved snapshots · {chain.symbol}</span>
            <span>{metas.length}</span>
          </h4>
          {!metas.length ? (
            <p className="oc-note">
              No snapshots yet. While the live chain refreshes, TrendLens saves one {snapshotSeconds > 0 ? `every ${snapshotSeconds} s per expiry` : 'never (turned off in Settings)'} on this PC. History starts from the first save; nothing earlier is invented.
            </p>
          ) : (
            <div className="oc-snap-list">
              <table className="quotes">
                <thead>
                  <tr>
                    <th>Captured</th>
                    <th>Expiry</th>
                    <th className="num">Spot</th>
                    <th className="num">PCR</th>
                    <th className="num">Max Pain</th>
                    <th className="num">ATM IV</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.slice(0, 400).map((m) => (
                    <tr key={`${m.expiry}-${m.t}`} className={cmp?.t === m.t && cmp.expiry === m.expiry ? 'sel' : ''}>
                      <td>{istTime(m.t)}</td>
                      <td>{m.expiry}</td>
                      <td className="num">{num(m.summary.spot, 2)}</td>
                      <td className="num">{ratio(m.summary.pcrOi)}</td>
                      <td className="num">{m.summary.maxPain !== undefined ? strike(m.summary.maxPain) : '—'}</td>
                      <td className="num">{m.summary.atmIv !== undefined ? `${m.summary.atmIv.toFixed(2)}%` : '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm" onClick={() => onView(m)}>
                          View
                        </button>{' '}
                        <button className="btn btn-sm" onClick={() => setCmp(m)} title="Compare the chain on screen with this snapshot">
                          Compare
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h4>
            <span>{expiryLabel(expiry)} over time</span>
            <span>{sameExpiry.length} snapshots</span>
          </h4>
          <LineChart
            height={150}
            series={[{ label: 'OI PCR', color: 'var(--accent)', points: sameExpiry.map((m) => ({ x: m.t, y: m.summary.pcrOi })) }]}
            formatX={timeTick}
            formatY={(y, d) => fixed(y, d, 2)}
          />
          <LineChart
            height={150}
            series={[{ label: 'ATM IV %', color: 'var(--accent-2)', points: sameExpiry.map((m) => ({ x: m.t, y: m.summary.atmIv })) }]}
            formatX={timeTick}
            formatY={(y, d) => fixed(y, d, 1, '%')}
          />
          <LineChart
            height={150}
            series={[
              { label: 'Spot', color: 'var(--text)', points: sameExpiry.map((m) => ({ x: m.t, y: m.summary.spot })) },
              { label: 'Max Pain', color: 'var(--warn)', points: sameExpiry.map((m) => ({ x: m.t, y: m.summary.maxPain })), dashed: true },
            ]}
            formatX={timeTick}
            formatY={(y) => (y === undefined ? '—' : num(y, 0))}
          />
        </div>
      </div>

      {cmp && (
        <div className="card">
          <h4>
            <span>
              Change from {istTime(cmp.t)} ({cmp.expiry === chain.expiry ? 'same expiry' : `expiry ${cmp.expiry}`}) to the chain on screen ({istTime(chain.fetchedAt)})
            </span>
            <button className="btn btn-sm" onClick={() => setCmp(null)}>
              Close
            </button>
          </h4>
          {err && <div className="tone-bear">{err}</div>}
          {earlier && (
            <>
              <StrikeBars
                strikes={diff.map((d) => d.strike)}
                series={[
                  { label: 'Call OI change', color: 'var(--bear)', values: diff.map((d) => conv(d.callOiDiff)) },
                  { label: 'Put OI change', color: 'var(--bull)', values: diff.map((d) => conv(d.putOiDiff)) },
                ]}
                format={signedCompact}
              />
              <div className="oc-greeks-wrap">
                <table className="quotes">
                  <thead>
                    <tr>
                      <th className="num">Call OI now</th>
                      <th className="num">Δ Call OI</th>
                      <th className="num">Δ Call IV</th>
                      <th className="num">Δ Call LTP</th>
                      <th className="num">Strike</th>
                      <th className="num">Δ Put LTP</th>
                      <th className="num">Δ Put IV</th>
                      <th className="num">Δ Put OI</th>
                      <th className="num">Put OI now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.map((d) => (
                      <tr key={d.strike}>
                        <td className="num">{compact(conv(d.callOi))}</td>
                        <td className={`num ${(d.callOiDiff ?? 0) >= 0 ? 'up' : 'down'}`}>{signedCompact(conv(d.callOiDiff))}</td>
                        <td className="num">{d.callIvDiff !== undefined ? d.callIvDiff.toFixed(2) : '—'}</td>
                        <td className="num">{d.callLtpDiff !== undefined ? d.callLtpDiff.toFixed(2) : '—'}</td>
                        <td className="num">
                          <b>{strike(d.strike)}</b>
                        </td>
                        <td className="num">{d.putLtpDiff !== undefined ? d.putLtpDiff.toFixed(2) : '—'}</td>
                        <td className="num">{d.putIvDiff !== undefined ? d.putIvDiff.toFixed(2) : '—'}</td>
                        <td className={`num ${(d.putOiDiff ?? 0) >= 0 ? 'up' : 'down'}`}>{signedCompact(conv(d.putOiDiff))}</td>
                        <td className="num">{compact(conv(d.putOi))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="oc-note">
                PCR then {ratio(cmp.summary.pcrOi)} → now shown in the cards above. {cmp.expiry !== chain.expiry ? 'Different expiries: strikes are matched by price, so differences mix the two series.' : ''}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
