import { ivSkew, ivSmile, type ChainGreeks, type GreekValue, type IvStats, type LegGreeks } from '@core/options/iv-analysis';
import type { OptionChain } from '@core/options/types';
import { fixed, num, pct, strike } from '../../lib/optionsFormat';
import { LineChart } from './charts';

function V({ g, d = 2 }: { g?: GreekValue; d?: number }) {
  if (!g) return <td className="num">—</td>;
  return (
    <td className="num" title={g.source === 'provider' ? 'Provider-supplied' : 'Calculated by TrendLens'}>
      {g.value.toFixed(d)}
      <sup className={g.source === 'provider' ? 'src-p' : 'src-c'}>{g.source === 'provider' ? 'P' : 'C'}</sup>
    </td>
  );
}

function legCells(l: LegGreeks | undefined) {
  return (
    <>
      <V g={l?.iv} d={2} />
      <V g={l?.delta} d={3} />
      <V g={l?.gamma} d={5} />
      <V g={l?.theta} d={2} />
      <V g={l?.vega} d={2} />
      <V g={l?.rho} d={2} />
    </>
  );
}

const MODEL_LABEL = { 'black-scholes': 'Black-Scholes (spot, carry yield q)', 'black-76': 'Black-76 (options on futures)' };
const FWD_LABEL = { futures: 'futures price', parity: 'put-call parity near the money', 'assumed-yield': 'spot carried at r − q (assumed q)', none: 'not available' };

export function GreeksPanel({
  chain,
  g,
  strikes,
  ivChange,
  ivStats,
  onPick,
}: {
  chain: OptionChain;
  g: ChainGreeks;
  strikes: Set<number>;
  ivChange?: { vsPrev?: number; prevLabel?: string; vsDay?: number; dayLabel?: string };
  ivStats: IvStats;
  onPick: (strike: number) => void;
}) {
  const smile = ivSmile(g).filter((p) => strikes.has(p.strike));
  const skew = ivSkew(g, chain.underlyingIsFutures ? 5 : 3);
  const rows = g.rows.filter((r) => strikes.has(r.strike));
  const days = g.T * 365;
  return (
    <div className="oc-panels">
      <div className="grid-3">
        <div className="card">
          <h4>Model and assumptions</h4>
          <div className="signal">
            <span>Model</span>
            <b>{MODEL_LABEL[g.model]}</b>
          </div>
          <div className="signal">
            <span>{chain.underlyingIsFutures ? 'Futures price' : 'Spot (S)'}</span>
            <b>{g.underlying !== undefined ? num(g.underlying, 2) : '—'}</b>
          </div>
          <div className="signal">
            <span>Forward</span>
            <b>{g.forward !== undefined ? num(g.forward, 2) : '—'}</b>
            <small>from {FWD_LABEL[g.forwardSource]}</small>
          </div>
          <div className="signal">
            <span>Risk-free rate r</span>
            <b>{pct(g.r * 100)}</b>
            <small>your assumption (Settings → Option chain data)</small>
          </div>
          {!chain.underlyingIsFutures && (
            <div className="signal">
              <span>Carry / dividend yield q</span>
              <b>{g.q !== undefined ? pct(g.q * 100) : '—'}</b>
              <small>{g.qSource === 'parity' ? 'implied by put-call parity' : 'your assumption (Settings)'}</small>
            </div>
          )}
          <div className="signal">
            <span>Time to expiry</span>
            <b>{days.toFixed(2)} days</b>
            <small>to {chain.exchange === 'MCX' ? '23:30' : '15:30'} IST on {chain.expiry} (ACT/365)</small>
          </div>
          {g.notes.map((n) => (
            <p key={n} className="oc-note tone-warn">
              {n}
            </p>
          ))}
        </div>
        <div className="card">
          <h4>IV summary</h4>
          <div className="signal">
            <span>ATM IV ({g.atm !== undefined ? strike(g.atm) : '—'})</span>
            <b>{pct(g.atmIv)}</b>
          </div>
          <div className="signal">
            <span>IV change vs {ivChange?.prevLabel ?? 'previous refresh'}</span>
            <b className={(ivChange?.vsPrev ?? 0) >= 0 ? 'up' : 'down'}>{ivChange?.vsPrev !== undefined ? `${ivChange.vsPrev >= 0 ? '+' : ''}${ivChange.vsPrev.toFixed(2)} pts` : '—'}</b>
          </div>
          <div className="signal">
            <span>IV change vs {ivChange?.dayLabel ?? 'previous captured day'}</span>
            <b className={(ivChange?.vsDay ?? 0) >= 0 ? 'up' : 'down'}>{ivChange?.vsDay !== undefined ? `${ivChange.vsDay >= 0 ? '+' : ''}${ivChange.vsDay.toFixed(2)} pts` : '—'}</b>
          </div>
          <div className="signal">
            <span>IV rank / IV percentile</span>
            <b>{ivStats.rank !== undefined ? `${ivStats.rank.toFixed(0)} / ${ivStats.percentile!.toFixed(0)}` : '—'}</b>
            <small>
              {ivStats.rank !== undefined
                ? `over ${ivStats.days} captured days (ATM IV ${ivStats.min!.toFixed(1)}–${ivStats.max!.toFixed(1)}%)`
                : `needs ${ivStats.required} days of saved snapshots; ${ivStats.days} captured so far`}
            </small>
          </div>
          <div className="signal">
            <span>Skew ({skew ? `${strike(skew.putWingStrike)}P vs ${strike(skew.callWingStrike)}C` : 'wings'})</span>
            <b>{skew ? `${skew.skew >= 0 ? '+' : ''}${skew.skew.toFixed(2)} pts` : '—'}</b>
            <small>{skew ? `put wing ${skew.putWingIv.toFixed(1)}% · call wing ${skew.callWingIv.toFixed(1)}% · ±${skew.wingPct}% from forward` : 'not enough strikes with IV around the forward'}</small>
          </div>
        </div>
        <div className="card">
          <h4>Sources</h4>
          <p className="oc-note" style={{ marginTop: 0 }}>
            <sup className="src-p">P</sup> provider-supplied ({chain.provider === 'upstox' ? 'Upstox' : chain.provider === 'dhan' ? 'Dhan' : 'file'}), shown as reported. <sup className="src-c">C</sup> calculated by TrendLens with
            the model on the left: theta per calendar day, vega and rho per 1 percentage point, delta per 1 point of {chain.underlyingIsFutures ? 'the futures price' : 'the spot'}.
          </p>
          <p className="oc-note">
            IV is calculated from the bid/ask mid when both are quoted, otherwise from the LTP. Provider Greeks are used only when their delta is strictly within the valid range and within 0.10 of the model's
            delta (zeros sent for unquoted strikes fail this); otherwise the calculated values are shown. Rho is always calculated.
          </p>
        </div>
      </div>

      <div className="card">
        <h4>
          <span>IV smile</span>
          <span>{smile.length} strikes</span>
        </h4>
        <LineChart
          series={[
            { label: 'Call IV %', color: 'var(--bear)', points: smile.map((p) => ({ x: p.strike, y: p.callIv })) },
            { label: 'Put IV %', color: 'var(--bull)', points: smile.map((p) => ({ x: p.strike, y: p.putIv })) },
            { label: 'OTM IV %', color: 'var(--accent)', points: smile.map((p) => ({ x: p.strike, y: p.otmIv })), dashed: true },
          ]}
          formatX={(x) => strike(x)}
          formatY={(y, d) => fixed(y, d, 1, '%')}
          markers={g.forward !== undefined ? [{ at: g.forward, label: 'Forward', color: 'var(--accent)' }] : []}
        />
      </div>

      <div className="card">
        <h4>
          <span>Greeks by strike</span>
          <span>P = provider · C = calculated</span>
        </h4>
        <div className="oc-greeks-wrap">
          <table className="quotes oc-greeks">
            <thead>
              <tr>
                <th className="num">Call IV</th>
                <th className="num">Delta</th>
                <th className="num">Gamma</th>
                <th className="num">Theta/day</th>
                <th className="num">Vega</th>
                <th className="num">Rho</th>
                <th className="num">Strike</th>
                <th className="num">Put IV</th>
                <th className="num">Delta</th>
                <th className="num">Gamma</th>
                <th className="num">Theta/day</th>
                <th className="num">Vega</th>
                <th className="num">Rho</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.strike} className={r.strike === g.atm ? 'atm' : ''} onClick={() => onPick(r.strike)}>
                  {legCells(r.call)}
                  <td className="num">
                    <b>{strike(r.strike)}</b>
                  </td>
                  {legCells(r.put)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
