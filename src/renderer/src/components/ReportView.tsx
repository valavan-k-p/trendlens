import type { AnalysisReport } from '@core/analysis/types';
import { formatPrice } from '@core/format';
import { timeframeLabel } from '@core/types';
import { conditionTone, riskTone, toneClass } from '../lib/report';
import { Gauge } from './Gauge';

function Metric({ label, value, sub, pct }: { label: string; value: string; sub?: string; pct?: number }) {
  return (
    <div className="metric">
      <label>{label}</label>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
      {pct !== undefined && (
        <div className="bar">
          <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
      )}
    </div>
  );
}

export function ReportView({ report }: { report: AnalysisReport }) {
  const r = report;
  const condTone = conditionTone(r.condition);
  const mtf = r.modules.find((m) => m.id === 'mtf');
  return (
    <div className="report">
      <div className="card">
        <h4>
          <span>
            Market condition · {r.symbol} · {timeframeLabel(r.timeframe)}
          </span>
          <span>{new Date(r.generatedAt).toLocaleTimeString()}</span>
        </h4>
        <div className="hero">
          <Gauge value={r.biasScore} label="BIAS" />
          <div>
            <div className={`condition ${toneClass(condTone)}`}>{r.condition}</div>
            <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className={`badge ${toneClass(riskTone(r.risk.level))}`}>Risk: {r.risk.level}</span>
              <span className="badge tone-neutral">Phase: {r.phase}</span>
            </div>
            <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
              S {formatPrice(r.keyLevels.support)} · R {formatPrice(r.keyLevels.resistance)} · Last {formatPrice(r.lastPrice)}
            </div>
          </div>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Confidence" value={`${r.confidence}%`} pct={r.confidence} sub={r.confidence >= 65 ? 'High' : r.confidence >= 40 ? 'Medium' : 'Low'} />
        <Metric label="Strength index" value={`${r.strengthIndex}`} pct={r.strengthIndex} sub={r.strengthLabel} />
        <Metric label="Bias score" value={`${r.biasScore > 0 ? '+' : ''}${r.biasScore}`} pct={(r.biasScore + 100) / 2} sub="−100 bearish … +100 bullish" />
      </div>

      <div className="card">
        <h4>Insight summary</h4>
        <div className="insight">{r.insight}</div>
      </div>

      <div className="card">
        <h4>Bottom line</h4>
        <div className="verdict">{r.verdict}</div>
      </div>

      <div className="card">
        <h4>
          Risk environment <span className={toneClass(riskTone(r.risk.level))}>{r.risk.level}</span>
        </h4>
        {r.risk.flags.length ? (
          <ul className="flags">
            {r.risk.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <div style={{ color: 'var(--muted)' }}>No no-trade-zone, late-entry or counter-trend flags raised.</div>
        )}
      </div>

      {mtf && r.mtf.length > 1 && (
        <div className="card">
          <h4>Multi-timeframe alignment</h4>
          {r.mtf.map((row) => {
            const w = Math.abs(row.score) / 2;
            const color = row.score >= 20 ? 'var(--bull)' : row.score <= -20 ? 'var(--bear)' : 'var(--neutral)';
            return (
              <div className="mtf-row" key={row.timeframe}>
                <span>{timeframeLabel(row.timeframe)}</span>
                <div className="mtf-bar">
                  <i style={{ background: color, left: row.score >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` }} />
                </div>
                <b style={{ color, textAlign: 'right' }}>{row.bias}</b>
              </div>
            );
          })}
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{mtf.summary}</div>
        </div>
      )}

      {r.modules
        .filter((m) => m.id !== 'mtf')
        .map((m) => (
          <details className="card module" key={m.id} open={m.id === 'structure'}>
            <summary>
              <b>{m.title}</b>
              {m.score !== null ? (
                <span className={`score ${toneClass(m.score > 10 ? 'bull' : m.score < -10 ? 'bear' : 'neutral')}`}>
                  {m.score > 0 ? '+' : ''}
                  {m.score}
                </span>
              ) : (
                <span />
              )}
              <p>{m.summary}</p>
            </summary>
            <div className="signals">
              {m.items.map((s, i) => (
                <div className="signal" key={`${s.label}-${i}`} title={s.detail}>
                  <span>{s.label}</span>
                  <b className={toneClass(s.tone)}>{s.value}</b>
                  {s.detail && <small>{s.detail}</small>}
                </div>
              ))}
            </div>
          </details>
        ))}

      {r.dataNotes.length > 0 && (
        <div className="card">
          <h4>Data notes</h4>
          <ul className="notes">
            {r.dataNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="disclaimer">
        Generated from {r.barsAnalyzed} bars by deterministic rules (see Help → How Analysis Works). Educational and informational only — not investment advice or a buy/sell
        recommendation.
      </div>
    </div>
  );
}
