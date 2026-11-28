/**
 * Fetches free RSS headlines for a topic (main process), with a 5-minute cache per feed so
 * repeated AI calls do not refetch. Failing feeds are skipped; the rest are still used.
 */
import { googleNewsFeed, headlinesBlock, parseRss, queryFromQuestion, rankHeadlines, topicFor, type FeedSpec, type Headline } from '@core/news/feeds';

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; items: Headline[] }>();

async function fetchFeed(f: FeedSpec): Promise<Headline[]> {
  const hit = cache.get(f.url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  const res = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TrendLens/1.2 personal news reader', Accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${f.name} HTTP ${res.status}`);
  const items = parseRss(await res.text(), f.name);
  cache.set(f.url, { at: Date.now(), items });
  return items;
}

export interface NewsPack {
  /** Prompt block ("HEADLINES (...): ..."), empty when nothing relevant was found. */
  block: string;
  items: Headline[];
  label: string;
  failed: string[];
}

/** Headlines for an instrument symbol or a free-form question (the question wins when it names a topic). */
export async function newsFor(o: { symbol?: string; question?: string; max?: number }): Promise<NewsPack> {
  const topic = (o.question && topicFor(o.question)) || (o.symbol && topicFor(o.symbol)) || undefined;
  const feeds: FeedSpec[] = topic ? topic.feeds : [googleNewsFeed(queryFromQuestion(o.question ?? o.symbol ?? 'Indian stock market'), 'IN')];
  const keywords = topic ? topic.keywords : queryFromQuestion(o.question ?? o.symbol ?? '').split(' ').filter((w) => w.length > 2);
  const label = topic?.label ?? (o.question ? queryFromQuestion(o.question) : o.symbol ?? 'market');
  const failed: string[] = [];
  const all = (
    await Promise.all(
      feeds.map((f) =>
        fetchFeed(f).catch(() => {
          failed.push(f.name);
          return [] as Headline[];
        }),
      ),
    )
  ).flat();
  // Google News results already match the search query, so they get a bonus over unmatched feed items.
  const chosen = rankHeadlines(all, keywords, Date.now() / 1000, o.max ?? 18, 36, (h) => (h.feed === 'Google News' ? 1.5 : 0));
  return { block: headlinesBlock(chosen, label), items: chosen, label, failed: [...new Set(failed)] };
}
