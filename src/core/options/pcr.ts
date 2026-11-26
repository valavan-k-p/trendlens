/** Put-call ratios. Undefined when the call side is zero (the ratio is not defined). */

export function ratio(put: number, call: number): number | undefined {
  return call > 0 && Number.isFinite(put) ? put / call : undefined;
}

export interface PcrSet {
  /** Total put OI / total call OI. */
  oi?: number;
  /** Total put volume / total call volume. */
  volume?: number;
  /** Total put OI change / total call OI change; only when both changes are positive additions. */
  oiChange?: number;
}

export function pcrSet(t: { callOi: number; putOi: number; callVolume: number; putVolume: number; callOiChange: number; putOiChange: number }): PcrSet {
  return {
    oi: ratio(t.putOi, t.callOi),
    volume: ratio(t.putVolume, t.callVolume),
    oiChange: t.callOiChange > 0 && t.putOiChange > 0 ? t.putOiChange / t.callOiChange : undefined,
  };
}

/** Plain-language reading of OI PCR, a contrarian-leaning convention; labelled as interpretation in the UI. */
export function pcrReading(pcr: number | undefined): string {
  if (pcr === undefined) return 'Not available';
  if (pcr >= 1.3) return 'Put-heavy (often read as strong put writing / support)';
  if (pcr >= 1) return 'Mildly put-heavy';
  if (pcr >= 0.7) return 'Mildly call-heavy';
  return 'Call-heavy (often read as strong call writing / resistance)';
}
