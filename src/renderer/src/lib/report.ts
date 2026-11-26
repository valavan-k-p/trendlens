import type { AnalysisReport, Tone } from '@core/analysis/types';
import { formatPrice } from '@core/format';
import { timeframeLabel } from '@core/types';

export function toneClass(t: Tone): string {
  return `tone-${t}`;
}

export function conditionTone(c: AnalysisReport['condition']): Tone {
  if (c.includes('Bullish')) return 'bull';
  if (c.includes('Bearish')) return 'bear';
  if (c === 'Consolidating') return 'warn';
  return 'neutral';
}

export function riskTone(r: AnalysisReport['risk']['level']): Tone {
  return r === 'Low' ? 'bull' : r === 'Moderate' ? 'neutral' : 'warn';
}

/** Compact plain-text summary, used as context for the AI chart review. */
export function reportContext(r: AnalysisReport): string {
  return [
    `${r.symbol} ${timeframeLabel(r.timeframe)} — last ${formatPrice(r.lastPrice)}`,
    `Condition ${r.condition} (bias ${r.biasScore}), confidence ${r.confidence}%, strength ${r.strengthIndex}/100, phase ${r.phase}, risk ${r.risk.level}`,
    `Support ${formatPrice(r.keyLevels.support)}, resistance ${formatPrice(r.keyLevels.resistance)}`,
    ...r.modules.map((m) => `${m.title}: ${m.summary}`),
  ].join('\n');
}

export function reportToMarkdown(r: AnalysisReport): string {
  const lines: string[] = [];
  lines.push(`# ${r.name ?? r.symbol} (${r.symbol}) — ${timeframeLabel(r.timeframe)}`);
  lines.push('');
  lines.push(`Generated ${new Date(r.generatedAt).toLocaleString()} · last price ${formatPrice(r.lastPrice)}${r.currency ? ` ${r.currency}` : ''} · ${r.barsAnalyzed} bars`);
  lines.push('');
  lines.push('| Output | Value |', '| --- | --- |');
  lines.push(`| Market condition | ${r.condition} (bias ${r.biasScore > 0 ? '+' : ''}${r.biasScore}) |`);
  lines.push(`| Confidence | ${r.confidence}% |`);
  lines.push(`| Strength index | ${r.strengthIndex}/100 — ${r.strengthLabel} |`);
  lines.push(`| Market phase | ${r.phase} |`);
  lines.push(`| Risk environment | ${r.risk.level} |`);
  lines.push(`| Support / resistance | ${formatPrice(r.keyLevels.support)} / ${formatPrice(r.keyLevels.resistance)} |`);
  lines.push('');
  lines.push('## Insight summary', '', r.insight, '');
  lines.push('## Bottom line', '', r.verdict, '');
  if (r.risk.flags.length) {
    lines.push('## Risk flags', '');
    for (const f of r.risk.flags) lines.push(`- ${f}`);
    lines.push('');
  }
  for (const m of r.modules) {
    lines.push(`## ${m.title}${m.score !== null ? ` (score ${m.score > 0 ? '+' : ''}${m.score})` : ''}`, '', m.summary, '');
    for (const s of m.items) lines.push(`- **${s.label}:** ${s.value}${s.detail ? ` — ${s.detail}` : ''}`);
    lines.push('');
  }
  if (r.dataNotes.length) {
    lines.push('## Data notes', '');
    for (const n of r.dataNotes) lines.push(`- ${n}`);
    lines.push('');
  }
  lines.push('_Educational and informational output only — not investment advice._');
  return lines.join('\n');
}
