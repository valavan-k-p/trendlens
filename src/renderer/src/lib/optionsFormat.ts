/** Display formatting for the Option Chain page (Indian digit grouping, lakh/crore abbreviations). */

const grouped = new Map<number, Intl.NumberFormat>();
const fmt = (d: number) => {
  let f = grouped.get(d);
  if (!f) grouped.set(d, (f = new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })));
  return f;
};

/** 1234567.8 → "12,34,567.80" (fixed decimals). */
export function num(v: number | undefined, decimals = 0): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return fmt(decimals).format(v);
}

/** Signed version for changes: "+1,250", "−3.40". */
export function signed(v: number | undefined, decimals = 0): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const s = fmt(decimals).format(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

/** Compact Indian units: 12.4K, 3.21L (lakh), 1.05Cr (crore). */
export function compact(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(a >= 1e10 ? 0 : a >= 1e9 ? 1 : 2)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${a.toFixed(a < 10 && a % 1 ? 2 : 0)}`;
}

export function signedCompact(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v > 0 ? `+${compact(v)}` : compact(v);
}

export function pct(v: number | undefined, decimals = 2): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(decimals)}%`;
}

export function ratio(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2);
}

/** Strike formatting without needless decimals (MCX/stock strikes can be fractional). */
export function strike(v: number): string {
  return Number.isInteger(v) ? fmt(0).format(v) : fmt(2).format(v);
}

/** "26 Nov 2026, 14:05:12 IST". */
export function istTime(unixSec: number | undefined, withDate = true): string {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  if (withDate) Object.assign(opts, { day: '2-digit', month: 'short', year: 'numeric' });
  return `${d.toLocaleString('en-GB', opts)} IST`;
}

export function expiryLabel(e: string): string {
  const d = new Date(`${e}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function age(sec: number): string {
  if (sec < 5) return 'just now';
  if (sec < 90) return `${Math.round(sec)} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

/** Time-axis label: clock time for spans under two days, otherwise the date. */
export function timeTick(unixSec: number, spanSec: number): string {
  const d = new Date(unixSec * 1000);
  return spanSec < 2 * 86400
    ? d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
}

/** Fixed decimals, at least `min`. */
export const fixed = (v: number | undefined, decimals: number, min = 0, suffix = '') => (v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(Math.max(min, decimals))}${suffix}`);

export const toneOf = (v: number | undefined) => (v === undefined || v === 0 || !Number.isFinite(v) ? '' : v > 0 ? 'up' : 'down');
