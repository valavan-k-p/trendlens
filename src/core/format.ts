/** Decimal places appropriate for a price's magnitude. */
export function priceDecimals(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 2;
  if (p >= 10) return 2;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 8;
}

export function formatPrice(price: number | undefined, decimals?: number): string {
  if (price === undefined || !Number.isFinite(price)) return '—';
  const d = decimals ?? priceDecimals(price);
  return price.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function formatPct(v: number | undefined, digits = 2): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function formatNum(v: number | undefined, digits = 1): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function formatVolume(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
