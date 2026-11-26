/** Semi-circular bias gauge from -100 (bearish) to +100 (bullish). */
export function Gauge({ value, label }: { value: number; label: string }) {
  const v = Math.max(-100, Math.min(100, value));
  const angle = Math.PI * (1 - (v + 100) / 200); // pi (left) .. 0 (right)
  const cx = 66;
  const cy = 66;
  const r = 52;
  const nx = cx + (r - 8) * Math.cos(angle);
  const ny = cy - (r - 8) * Math.sin(angle);
  const arc = (from: number, to: number) => {
    const a0 = Math.PI * (1 - from);
    const a1 = Math.PI * (1 - to);
    return `M ${cx + r * Math.cos(a0)} ${cy - r * Math.sin(a0)} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(a1)} ${cy - r * Math.sin(a1)}`;
  };
  const color = v >= 20 ? 'var(--bull)' : v <= -20 ? 'var(--bear)' : 'var(--neutral)';
  return (
    <svg className="gauge" viewBox="0 0 132 84" role="img" aria-label={`Bias ${v}`}>
      <path d={arc(0, 0.4)} stroke="var(--bear)" strokeWidth="8" fill="none" opacity="0.55" />
      <path d={arc(0.4, 0.6)} stroke="var(--neutral)" strokeWidth="8" fill="none" opacity="0.45" />
      <path d={arc(0.6, 1)} stroke="var(--bull)" strokeWidth="8" fill="none" opacity="0.55" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="3" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="4" fill={color} />
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="13" fontWeight="700" fill={color}>
        {v > 0 ? '+' : ''}
        {v}
      </text>
      <text x={cx} y="10" textAnchor="middle" fontSize="8.5" fill="var(--muted)" letterSpacing="1">
        {label}
      </text>
    </svg>
  );
}
