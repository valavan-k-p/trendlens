/** AI usage display: one call's tokens and estimated cost, and today / this month totals. */
import { useEffect, useState } from 'react';
import { SEARCH_FREE_PER_MONTH, usd, type UsageSummary } from '@core/ai/usage';
import type { AiCallUsage } from '../../../shared/api';

const n = (v: number) => v.toLocaleString('en-IN');

/** "1,941 tokens (in 1,650 · out 90 · thinking 201) · 2 searches · ≈ $0.0021". */
export function callUsageText(u: AiCallUsage | undefined, total?: number): string {
  if (!u) return total ? `${n(total)} tokens` : '';
  const sum = total ?? u.input + u.output + u.thoughts + u.toolTokens;
  const parts = [`in ${n(u.input)}`, `out ${n(u.output)}`];
  if (u.thoughts) parts.push(`thinking ${n(u.thoughts)}`);
  if (u.toolTokens) parts.push(`search results ${n(u.toolTokens)}`);
  return `${n(sum)} tokens (${parts.join(' · ')})${u.searches ? ` · ${u.searches} search${u.searches > 1 ? 'es' : ''}` : ''}${u.cost !== undefined ? ` · ≈ ${usd(u.cost)}` : ''}`;
}

export function useUsage(refreshKey: unknown): UsageSummary | null {
  const [u, setU] = useState<UsageSummary | null>(null);
  useEffect(() => {
    void window.trendlens
      .aiUsage()
      .then(setU)
      .catch(() => setU(null));
  }, [refreshKey]);
  return u;
}

/** Today and this month at a glance, with the full breakdown in the tooltip. */
export function UsageSummaryBar({ summary, compact }: { summary: UsageSummary | null; compact?: boolean }) {
  if (!summary) return null;
  const t = summary.today;
  const m = summary.month;
  const tokens = (x: typeof t) => x.input + x.output + x.thoughts + x.toolTokens;
  const tip = [
    `Today: ${t.calls} calls · ${n(tokens(t))} tokens (in ${n(t.input)}, out ${n(t.output)}, thinking ${n(t.thoughts)}, search results ${n(t.toolTokens)}) · ${t.searches} searches · ≈ ${usd(t.cost)}`,
    `This month: ${m.calls} calls · ${n(tokens(m))} tokens · ${m.searches} searches (first ${n(SEARCH_FREE_PER_MONTH)} free) · ≈ ${usd(m.cost + summary.searchCostThisMonth)}`,
    `All time: ${summary.all.calls} calls · ≈ ${usd(summary.all.cost)}`,
    'Estimates at the paid-tier price per token; a free-tier key costs $0 but has rate limits.',
    'Counted by TrendLens on this PC; the provider does not report remaining credits to the app.',
    m.unpriced ? `${m.unpriced} calls this month used a model without a known price (not in the estimate).` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className="ai-usage" title={tip}>
      AI usage today: {t.calls} call{t.calls === 1 ? '' : 's'} · {n(tokens(t))} tokens · ≈ {usd(t.cost)}
      {!compact && ` · month ${m.calls} call${m.calls === 1 ? '' : 's'} · ≈ ${usd(m.cost + summary.searchCostThisMonth)}`}
    </span>
  );
}
