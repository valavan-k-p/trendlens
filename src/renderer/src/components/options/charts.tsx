/**
 * Small interactive SVG charts for the Option Chain page: strike-wise bars (grouped, stacked or
 * signed) and line charts over strikes or time. Theme colours come from CSS variables.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Rounded tick steps (1, 2, 2.5, 5 × 10^k) covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export interface BarSeries {
  label: string;
  color: string;
  values: (number | undefined)[];
}

export interface Marker {
  /** Position in x units (a strike or a time). */
  at: number;
  label: string;
  color: string;
  dashed?: boolean;
}

const PAD = { l: 66, r: 14, t: 14, b: 34 };

function Tooltip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), w - 200);
  return (
    <div className="oc-tip" style={{ left, top: Math.max(4, y - 10) }}>
      {children}
    </div>
  );
}

/**
 * Bars by strike. `mode` 'grouped' puts series side by side (negative values go below zero),
 * 'stacked' stacks non-negative series.
 */
export function StrikeBars({
  strikes,
  series,
  markers = [],
  height = 250,
  mode = 'grouped',
  format,
  highlight,
  onPick,
}: {
  strikes: number[];
  series: BarSeries[];
  markers?: Marker[];
  height?: number;
  mode?: 'grouped' | 'stacked';
  format: (v: number | undefined) => string;
  highlight?: number;
  onPick?: (strike: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const n = strikes.length;
  if (!n) return <div className="oc-chart-empty">No strikes to chart.</div>;
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    if (mode === 'stacked') hi = Math.max(hi, series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
    else for (const s of series) {
      const v = s.values[i] ?? 0;
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
    }
  }
  if (hi === lo) hi = lo + 1;
  const ticks = niceTicks(lo, hi);
  const yMin = Math.min(lo, ticks[0] ?? lo);
  const yMax = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const Y = (v: number) => PAD.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
  const slot = iw / n;
  const X = (i: number) => PAD.l + i * slot;
  const barW = mode === 'stacked' ? Math.max(1, slot * 0.7) : Math.max(1, (slot * 0.8) / series.length);
  // Strike → x for markers that fall between strikes (e.g. the underlying price).
  const xOfStrike = (k: number) => {
    if (k <= strikes[0]) return X(0) + slot / 2;
    if (k >= strikes[n - 1]) return X(n - 1) + slot / 2;
    const j = strikes.findIndex((s) => s >= k);
    const a = strikes[j - 1];
    const b = strikes[j];
    return X(j - 1) + slot / 2 + ((k - a) / (b - a)) * slot;
  };
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(iw / 62))));
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - PAD.l) / slot);
    setHover(i >= 0 && i < n ? { i, x: e.clientX - r.left, y: e.clientY - r.top } : null);
  };
  return (
    <div className="oc-chart" ref={ref} style={{ height }}>
      <svg width={width} height={height} onMouseMove={move} onMouseLeave={() => setHover(null)} onClick={() => hover && onPick?.(strikes[hover.i])}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={Y(t)} y2={Y(t)} className={t === 0 ? 'oc-axis' : 'oc-grid'} />
            <text x={PAD.l - 6} y={Y(t) + 4} textAnchor="end" className="oc-tick">
              {format(t)}
            </text>
          </g>
        ))}
        {highlight !== undefined && strikes.includes(highlight) && <rect x={X(strikes.indexOf(highlight))} y={PAD.t} width={slot} height={ih} className="oc-band" />}
        {hover && <rect x={X(hover.i)} y={PAD.t} width={slot} height={ih} className="oc-hover" />}
        {strikes.map((k, i) => {
          if (mode === 'stacked') {
            let acc = 0;
            return (
              <g key={k}>
                {series.map((s) => {
                  const v = Math.max(0, s.values[i] ?? 0);
                  const y0 = Y(acc);
                  acc += v;
                  return v ? <rect key={s.label} x={X(i) + (slot - barW) / 2} y={Y(acc)} width={barW} height={Math.max(0.5, y0 - Y(acc))} fill={s.color} /> : null;
                })}
              </g>
            );
          }
          return (
            <g key={k}>
              {series.map((s, j) => {
                const v = s.values[i];
                if (v === undefined || v === 0) return null;
                const y = v >= 0 ? Y(v) : Y(0);
                return <rect key={s.label} x={X(i) + slot * 0.1 + j * barW} y={y} width={barW} height={Math.max(0.5, Math.abs(Y(v) - Y(0)))} fill={s.color} rx={1} />;
              })}
            </g>
          );
        })}
        {strikes.map((k, i) =>
          i % labelEvery === 0 ? (
            <text key={k} x={X(i) + slot / 2} y={height - PAD.b + 16} textAnchor={X(i) + slot / 2 > width - PAD.r - 24 ? 'end' : 'middle'} className="oc-tick">
              {k}
            </text>
          ) : null,
        )}
        {markers.map((m, k) => {
          const x = xOfStrike(m.at);
          const right = x > width - PAD.r - 90;
          return (
            <g key={m.label}>
              <line x1={x} x2={x} y1={PAD.t} y2={PAD.t + ih} stroke={m.color} strokeWidth={1.4} strokeDasharray={m.dashed ? '4 3' : undefined} />
              <text x={right ? x - 4 : x + 4} y={PAD.t + 10 + k * 13} textAnchor={right ? 'end' : 'start'} className="oc-marker" fill={m.color}>
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="oc-legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      {hover && (
        <Tooltip x={hover.x} y={hover.y} w={width}>
          <b>Strike {strikes[hover.i]}</b>
          {series.map((s) => (
            <div key={s.label}>
              <i style={{ background: s.color }} />
              {s.label}: {format(s.values[hover.i])}
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

export interface LineSeries {
  label: string;
  color: string;
  points: { x: number; y: number | undefined }[];
  dashed?: boolean;
}

/** Line chart over a numeric x axis (strikes or unix seconds). */
export function LineChart({
  series,
  height = 230,
  formatX,
  formatY,
  markers = [],
  yZero = false,
}: {
  series: LineSeries[];
  height?: number;
  formatX: (x: number, span: number) => string;
  /** `decimals` is the precision the tick spacing needs (e.g. 3 when ticks are 0.005 apart). */
  formatY: (y: number | undefined, decimals: number) => string;
  markers?: Marker[];
  yZero?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverX, setHoverX] = useState<{ x: number; px: number; py: number } | null>(null);
  const pts = series.flatMap((s) => s.points.filter((p) => p.y !== undefined && Number.isFinite(p.y)));
  if (!pts.length) return <div className="oc-chart-empty">Not enough data to draw this chart yet.</div>;
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1] === xMin ? xMin + 1 : xs[xs.length - 1];
  let lo = Math.min(...pts.map((p) => p.y!));
  let hi = Math.max(...pts.map((p) => p.y!));
  if (yZero) lo = Math.min(0, lo);
  const padY = (hi - lo || Math.abs(hi) || 1) * 0.08;
  lo -= yZero && lo === 0 ? 0 : padY;
  hi += padY;
  const ticks = niceTicks(lo, hi);
  const yMin = Math.min(lo, ticks[0] ?? lo);
  const yMax = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const dec = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) + 1e-9)));
  const span = xMax - xMin;
  const fx = (x: number) => formatX(x, span);
  const fy = (y: number | undefined) => formatY(y, dec);
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const X = (x: number) => PAD.l + ((x - xMin) / (xMax - xMin)) * iw;
  const Y = (y: number) => PAD.t + ih - ((y - yMin) / (yMax - yMin)) * ih;
  const xTicks = xs.length <= 8 ? xs : niceTicks(xMin, xMax, Math.max(3, Math.floor(iw / 110))).filter((x) => x >= xMin && x <= xMax);
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const target = xMin + ((e.clientX - r.left - PAD.l) / iw) * (xMax - xMin);
    let best = xs[0];
    for (const x of xs) if (Math.abs(x - target) < Math.abs(best - target)) best = x;
    setHoverX({ x: best, px: e.clientX - r.left, py: e.clientY - r.top });
  };
  return (
    <div className="oc-chart" ref={ref} style={{ height }}>
      <svg width={width} height={height} onMouseMove={move} onMouseLeave={() => setHoverX(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={Y(t)} y2={Y(t)} className={t === 0 ? 'oc-axis' : 'oc-grid'} />
            <text x={PAD.l - 6} y={Y(t) + 4} textAnchor="end" className="oc-tick">
              {fy(t)}
            </text>
          </g>
        ))}
        {xTicks.map((x) => (
          <text key={x} x={X(x)} y={height - PAD.b + 16} textAnchor={X(x) > width - PAD.r - 24 ? 'end' : X(x) < PAD.l + 24 ? 'start' : 'middle'} className="oc-tick">
            {fx(x)}
          </text>
        ))}
        {markers.map((m, k) => (
          <g key={m.label}>
            <line x1={X(m.at)} x2={X(m.at)} y1={PAD.t} y2={PAD.t + ih} stroke={m.color} strokeWidth={1.3} strokeDasharray={m.dashed ? '4 3' : undefined} />
            <text x={X(m.at) + 4} y={PAD.t + 10 + k * 13} className="oc-marker" fill={m.color}>
              {m.label}
            </text>
          </g>
        ))}
        {series.map((s) => {
          const ok = s.points.filter((p) => p.y !== undefined && Number.isFinite(p.y));
          const d = ok.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y!).toFixed(1)}`).join('');
          return (
            <g key={s.label}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={1.8} strokeDasharray={s.dashed ? '5 4' : undefined} />
              {ok.length <= 60 && ok.map((p) => <circle key={p.x} cx={X(p.x)} cy={Y(p.y!)} r={2.2} fill={s.color} />)}
            </g>
          );
        })}
        {hoverX && <line x1={X(hoverX.x)} x2={X(hoverX.x)} y1={PAD.t} y2={PAD.t + ih} className="oc-cursor" />}
      </svg>
      <div className="oc-legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      {hoverX && (
        <Tooltip x={hoverX.px} y={hoverX.py} w={width}>
          <b>{fx(hoverX.x)}</b>
          {series.map((s) => (
            <div key={s.label}>
              <i style={{ background: s.color }} />
              {s.label}: {formatY(s.points.find((p) => p.x === hoverX.x)?.y, Math.max(dec, 2))}
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}
