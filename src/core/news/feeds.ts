/**
 * Free news headlines from public RSS feeds (no key): Google News search RSS (personal,
 * non-commercial use per its terms), Economic Times / Livemint / Business Standard market feeds
 * and RBI press releases. Pure parsing, topic queries and ranking; fetching is in the main process.
 */

export interface Headline {
  title: string;
  link: string;
  /** Publisher, e.g. "Reuters". */
  source: string;
  /** Unix seconds; 0 when the feed gives no date. */
  published: number;
  /** Feed it came from, e.g. "Google News", "Economic Times". */
  feed: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes XML entities and strips CDATA and tags. */
export function cleanText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const tag = (item: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(item)?.[1];

/** Parses RSS 2.0 items. Google News titles end with " - Publisher"; that becomes the source. */
export function parseRss(xml: string, feed: string): Headline[] {
  const out: Headline[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    let title = cleanText(tag(item, 'title') ?? '');
    const link = cleanText(tag(item, 'link') ?? tag(item, 'guid') ?? '');
    let source = cleanText(tag(item, 'source') ?? '');
    if (!source && feed === 'Google News') {
      const i = title.lastIndexOf(' - ');
      if (i > 0) source = title.slice(i + 3);
    }
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const date = Date.parse(cleanText(tag(item, 'pubDate') ?? tag(item, 'dc:date') ?? ''));
    if (!title || !/^https?:\/\//.test(link)) continue;
    out.push({ title, link, source: source || feed, published: Number.isFinite(date) ? Math.floor(date / 1000) : 0, feed });
  }
  return out;
}

export interface FeedSpec {
  name: string;
  url: string;
}

/** Google News search RSS for the last day. India edition for Indian markets, US for global commodities. */
export function googleNewsFeed(query: string, region: 'IN' | 'US' = 'IN'): FeedSpec {
  const q = encodeURIComponent(`${query} when:1d`).replace(/%20/g, '+');
  const loc = region === 'IN' ? 'hl=en-IN&gl=IN&ceid=IN:en' : 'hl=en-US&gl=US&ceid=US:en';
  return { name: 'Google News', url: `https://news.google.com/rss/search?q=${q}&${loc}` };
}

export const INDIA_FEEDS: FeedSpec[] = [
  { name: 'Economic Times', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'Livemint', url: 'https://www.livemint.com/rss/markets' },
  { name: 'Business Standard', url: 'https://www.business-standard.com/rss/markets-106.rss' },
];
export const RBI_FEED: FeedSpec = { name: 'RBI', url: 'https://www.rbi.org.in/pressreleases_rss.xml' };

export interface NewsTopic {
  id: string;
  label: string;
  /** Words that make a headline relevant (lower case). */
  keywords: string[];
  feeds: FeedSpec[];
}

const IN = (q: string) => googleNewsFeed(q, 'IN');
const US = (q: string) => googleNewsFeed(q, 'US');
const MARKET_WORDS = ['nifty', 'sensex', 'stock market', 'stocks', 'fii', 'dii', 'rbi', 'fed', 'rupee', 'gift nifty', 'market'];

/** What moves each instrument, as feeds to read and words to rank headlines by. */
export const TOPICS: Record<string, NewsTopic> = {
  NIFTY: {
    id: 'NIFTY',
    label: 'NIFTY / Indian market',
    keywords: [...MARKET_WORDS, 'india', 'earnings', 'inflation', 'gdp', 'crude', 'us markets'],
    feeds: [IN('nifty OR sensex stock market'), IN('FII DII flows India'), ...INDIA_FEEDS, RBI_FEED],
  },
  BANKNIFTY: {
    id: 'BANKNIFTY',
    label: 'BANK NIFTY / banks',
    keywords: [...MARKET_WORDS, 'bank', 'banking', 'hdfc', 'icici', 'sbi', 'kotak', 'axis', 'npa', 'credit', 'repo'],
    feeds: [IN('bank nifty OR banking stocks'), IN('RBI policy repo rate'), ...INDIA_FEEDS, RBI_FEED],
  },
  CRUDEOIL: {
    id: 'CRUDEOIL',
    label: 'Crude oil',
    keywords: ['crude', 'oil', 'brent', 'wti', 'opec', 'inventor', 'barrel', 'refin', 'iran', 'russia', 'middle east', 'saudi'],
    feeds: [US('crude oil prices'), US('OPEC oil supply'), IN('MCX crude oil'), INDIA_FEEDS[0]],
  },
  NATURALGAS: {
    id: 'NATURALGAS',
    label: 'Natural gas',
    keywords: ['natural gas', 'gas', 'lng', 'henry hub', 'storage', 'eia', 'weather', 'winter', 'heating', 'ttf', 'freeport'],
    feeds: [US('natural gas prices'), US('natural gas storage EIA'), US('LNG exports weather forecast natural gas')],
  },
  GOLD: {
    id: 'GOLD',
    label: 'Gold / silver',
    keywords: ['gold', 'silver', 'bullion', 'fed', 'dollar', 'yield', 'inflation', 'central bank', 'etf', 'safe haven'],
    feeds: [US('gold prices'), US('silver prices'), US('Federal Reserve dollar yields'), IN('MCX gold')],
  },
  COPPER: {
    id: 'COPPER',
    label: 'Base metals',
    keywords: ['copper', 'zinc', 'aluminium', 'aluminum', 'metal', 'china', 'lme', 'demand'],
    feeds: [US('copper prices'), US('China metals demand')],
  },
};

// Most specific first ("central bank" in a gold question must not read as Bank Nifty).
const ALIASES: [RegExp, string][] = [
  [/natural ?gas|nat ?gas|natgas|naturalgas|\blng\b|henry hub/i, 'NATURALGAS'],
  [/crude|brent|\bwti\b|\boil\b|opec/i, 'CRUDEOIL'],
  [/\bgold|silver|bullion/i, 'GOLD'],
  [/copper|zinc|alumin|base metal/i, 'COPPER'],
  [/bank ?nifty|banknifty|bank(ing)? stocks/i, 'BANKNIFTY'],
  [/nifty|sensex|stock market|indian market/i, 'NIFTY'],
];

/** Topic for a question or a symbol ("will natgas rise?", "MNAG", "NIFTY#"), or undefined. */
export function topicFor(text: string): NewsTopic | undefined {
  const t = text.replace(/#$/, '');
  const sym = t.toUpperCase();
  const symbolMap: Record<string, string> = { MNAG: 'NATURALGAS', MCRO: 'CRUDEOIL', MCRUDEOIL: 'CRUDEOIL', CRUDEOILM: 'CRUDEOIL', MGLD: 'GOLD', GLMM: 'GOLD', GOLDM: 'GOLD', SILVER: 'GOLD', SILVERM: 'GOLD', MSLV: 'GOLD', SENSEX: 'NIFTY', FINNIFTY: 'NIFTY', XAUUSD: 'GOLD', XAGUSD: 'GOLD', USOIL: 'CRUDEOIL' };
  if (TOPICS[sym]) return TOPICS[sym];
  if (symbolMap[sym]) return TOPICS[symbolMap[sym]];
  for (const [re, id] of ALIASES) if (re.test(t)) return TOPICS[id];
  return undefined;
}

/** A Google News query from a free-form question when no known topic matches. */
export function queryFromQuestion(q: string): string {
  const stop = new Set(['what', 'is', 'the', 'a', 'an', 'about', 'news', 'give', 'me', 'will', 'go', 'up', 'down', 'today', 'this', 'week', 'for', 'of', 'on', 'and', 'or', 'any', 'latest', 'please', 'tell', 'how', 'why', 'price', 'prices']);
  const words = q
    .toLowerCase()
    .replace(/[^a-z0-9& ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w));
  return words.slice(0, 6).join(' ') || q.slice(0, 60);
}

/** Market-research and press-release filler that is not news (saves tokens for real headlines). */
export function isFiller(h: Pick<Headline, 'title' | 'source'>): boolean {
  return (
    /market (size|share|growth|report|research|outlook 20\d\d)|cagr|industry (demand|analysis|report)|price prediction|forecast .*20\d\d.*20\d\d|20\d\d[–-]20\d\d|press release|sponsored/i.test(h.title) ||
    /openpr|ein presswire|globe ?newswire|pr newswire|accesswire|newsfile|marketresearch|market\.us|researchandmarkets/i.test(h.source)
  );
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * The most relevant recent headlines: drops older than `maxAgeH`, de-duplicates near-identical
 * titles, scores keyword hits plus recency, and keeps `max` (newest first among equals).
 */
export function rankHeadlines(items: Headline[], keywords: string[], now: number, max = 18, maxAgeH = 36, boost: (h: Headline) => number = () => 0): Headline[] {
  const seen = new Set<string>();
  const scored: { h: Headline; score: number }[] = [];
  for (const h of items) {
    if (h.published && now - h.published > maxAgeH * 3600) continue;
    if (isFiller(h)) continue;
    const key = norm(h.title).slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const t = h.title.toLowerCase();
    const hits = keywords.filter((k) => k && t.includes(k)).length;
    const bonus = boost(h);
    // Recency only orders relevant items; an unrelated headline is never kept for being new.
    if (!hits && !bonus) continue;
    const ageH = h.published ? (now - h.published) / 3600 : maxAgeH;
    scored.push({ h, score: hits * 2 + bonus + Math.max(0, 1 - ageH / maxAgeH) });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.h.published - a.h.published)
    .slice(0, max)
    .map((x) => x.h);
}

/** Compact block for the prompt: "27 Nov 18:40 IST | Reuters | Title". */
export function headlinesBlock(items: Headline[], label: string): string {
  if (!items.length) return '';
  const when = (t: number) => {
    if (!t) return '?';
    const d = new Date((t + 19800) * 1000);
    return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].at(d.getUTCMonth())} ${d.toISOString().slice(11, 16)}`;
  };
  return [`HEADLINES (${label}, free RSS, newest relevant first, IST):`, ...items.map((h) => `${when(h.published)} | ${h.source} | ${h.title.slice(0, 160)}`)].join('\n');
}
