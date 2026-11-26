import type { Timeframe } from '../types';

export type Tone = 'bull' | 'bear' | 'neutral' | 'warn';

export interface Signal {
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
}

export interface ModuleResult {
  id: string;
  title: string;
  /** Directional contribution, -100 (bearish) .. +100 (bullish); null when not directional. */
  score: number | null;
  summary: string;
  items: Signal[];
}

export type LevelKind = 'support' | 'resistance' | 'psychological';

export interface Level {
  price: number;
  kind: LevelKind;
  /** Number of swing touches that formed the level. */
  touches: number;
  /** 0..100 */
  strength: number;
}

export type ZoneKind = 'bullish-ob' | 'bearish-ob' | 'bullish-fvg' | 'bearish-fvg';

export interface Zone {
  kind: ZoneKind;
  top: number;
  bottom: number;
  /** Bar time where the zone formed. */
  time: number;
  /** Price has traded back into the zone since it formed. */
  tested: boolean;
}

export type MarkerKind = 'HH' | 'HL' | 'LH' | 'LL' | 'BOS' | 'CHoCH' | 'SWEEP' | 'TRAP';

export interface Marker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  kind: MarkerKind;
  text: string;
  tone: Tone;
}

export type MarketCondition =
  | 'Strong Bullish'
  | 'Bullish'
  | 'Neutral'
  | 'Consolidating'
  | 'Bearish'
  | 'Strong Bearish';

export type RiskLevel = 'Low' | 'Moderate' | 'Elevated' | 'High';

export type MarketPhase = 'Markup' | 'Markdown' | 'Accumulation' | 'Distribution' | 'Range' | 'Transition';

export interface TimeframeBias {
  timeframe: Timeframe;
  score: number;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
}

export interface AnalysisReport {
  symbol: string;
  name?: string;
  currency?: string;
  timeframe: Timeframe;
  generatedAt: number;
  lastPrice: number;
  lastTime: number;
  barsAnalyzed: number;

  condition: MarketCondition;
  /** -100..100 */
  biasScore: number;
  /** 0..100 */
  confidence: number;
  /** 0..100 */
  strengthIndex: number;
  strengthLabel: string;
  phase: MarketPhase;
  risk: { level: RiskLevel; flags: string[] };
  insight: string;
  verdict: string;
  keyLevels: { support?: number; resistance?: number };

  modules: ModuleResult[];
  levels: Level[];
  zones: Zone[];
  markers: Marker[];
  mtf: TimeframeBias[];
  dataNotes: string[];
}
