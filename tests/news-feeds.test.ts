import { describe, expect, it } from 'vitest';
import { cleanText, googleNewsFeed, headlinesBlock, isFiller, parseRss, queryFromQuestion, rankHeadlines, topicFor, type Headline } from '@core/news/feeds';

const GOOGLE = `<?xml version="1.0"?><rss version="2.0"><channel><title>"natural gas prices when:1d" - Google News</title>
<item><title>While Asia and Europe Scramble for Natural Gas, the US Glut Has Nowhere to Go - EnergyNow.com</title><link>https://news.google.com/rss/articles/CBMi1</link><guid isPermaLink="false">CBMi1</guid><pubDate>Fri, 27 Nov 2026 18:40:00 GMT</pubDate><source url="https://energynow.com">EnergyNow.com</source></item>
<item><title>Natural gas futures fall on mild weather forecasts &amp; record storage - Reuters</title><link>https://news.google.com/rss/articles/CBMi2</link><pubDate>Fri, 27 Nov 2026 16:05:00 GMT</pubDate></item>
<item><title>No link item</title></item>
</channel></rss>`;

const ET = `<rss><channel><item><title><![CDATA[OPEC+ set to keep oil production targets steady: Report]]> </title><description><![CDATA[OPEC+ is expected to maintain...]]></description><link>https://economictimes.indiatimes.com/markets/commodities/opec/articleshow/136232084.cms</link><pubDate>Fri, 27 Nov 2026 22:10:00 +0530</pubDate></item></channel></rss>`;

describe('RSS parsing', () => {
  it('reads Google News items, taking the publisher from the title or <source>', () => {
    const items = parseRss(GOOGLE, 'Google News');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'While Asia and Europe Scramble for Natural Gas, the US Glut Has Nowhere to Go',
      link: 'https://news.google.com/rss/articles/CBMi1',
      source: 'EnergyNow.com',
      published: Date.UTC(2026, 10, 27, 18, 40) / 1000,
      feed: 'Google News',
    });
    expect(items[1]).toMatchObject({ title: 'Natural gas futures fall on mild weather forecasts & record storage', source: 'Reuters' });
  });

  it('reads CDATA titles and +0530 dates from Indian feeds', () => {
    const [h] = parseRss(ET, 'Economic Times');
    expect(h).toMatchObject({ title: 'OPEC+ set to keep oil production targets steady: Report', source: 'Economic Times', published: Date.UTC(2026, 10, 27, 16, 40) / 1000 });
  });

  it('decodes entities and strips tags', () => {
    expect(cleanText('<b>Tata &amp; Sons</b> &#8377;100 &#x2191; &quot;up&quot;')).toBe('Tata & Sons ₹100 ↑ "up"');
  });
});

describe('news topics and queries', () => {
  it('maps symbols and questions to what moves them', () => {
    expect(topicFor('MNAG')?.id).toBe('NATURALGAS');
    expect(topicFor('NIFTY#')?.id).toBe('NIFTY');
    expect(topicFor('MCRO')?.id).toBe('CRUDEOIL');
    expect(topicFor('will natgas go up this week?')?.id).toBe('NATURALGAS');
    expect(topicFor('Bank Nifty news')?.id).toBe('BANKNIFTY');
    expect(topicFor('gold outlook after central bank buying')?.id).toBe('GOLD'); // "central bank" is not Bank Nifty
    expect(topicFor('Tesla deliveries')).toBeUndefined();
    expect(topicFor('NATURALGAS')!.feeds.every((f) => f.url.startsWith('https://news.google.com/rss/search?q='))).toBe(true);
  });

  it('builds Google News search feeds for the last day', () => {
    expect(googleNewsFeed('crude oil prices', 'US').url).toBe('https://news.google.com/rss/search?q=crude+oil+prices+when%3A1d&hl=en-US&gl=US&ceid=US:en');
    expect(queryFromQuestion('What is the latest news about Reliance Industries this week?')).toBe('reliance industries');
  });
});

describe('headline ranking', () => {
  const now = Date.UTC(2026, 10, 27, 20, 0) / 1000;
  const h = (title: string, ageH: number, feed = 'Economic Times'): Headline => ({ title, link: `https://x/${encodeURIComponent(title)}`, source: feed, published: now - ageH * 3600, feed });

  it('keeps relevant recent headlines, drops stale and duplicate ones', () => {
    const out = rankHeadlines(
      [
        h('Crude oil jumps as OPEC extends cuts', 2),
        h('Crude Oil Jumps as OPEC Extends Cuts!', 3), // duplicate
        h('Brent slips on inventory build', 10),
        h('Bollywood box office weekend', 1), // irrelevant
        h('Crude falls on demand worries', 50), // stale
        h('Market wrap', 1, 'Google News'), // query-matched result
      ],
      ['crude', 'opec', 'brent', 'inventor'],
      now,
      10,
      36,
      (x) => (x.feed === 'Google News' ? 1.5 : 0),
    );
    expect(out.map((x) => x.title)).toEqual(['Crude oil jumps as OPEC extends cuts', 'Brent slips on inventory build', 'Market wrap']);
  });

  it('drops market-research and press-release filler', () => {
    expect(isFiller({ title: 'Growth in the Distributed Natural Gas-Fueled Generation Market Fueled by Evolving Industry Demand', source: 'openPR.com' })).toBe(true);
    expect(isFiller({ title: 'Natural Gas Forecast & Price Prediction for 2026, 2027, 2028–2030 and Beyond', source: 'LiteFinance' })).toBe(true);
    expect(isFiller({ title: 'LNG Market Size to Reach $200B, CAGR 6%', source: 'Yahoo' })).toBe(true);
    expect(isFiller({ title: 'US natural gas futures drop 5% as warmer weather outlook curbs heating demand', source: 'marketscreener.com' })).toBe(false);
    expect(isFiller({ title: 'US Natgas Output to Hit Record High in 2026, While Demand Declines, EIA Says', source: 'EnergyNow.com' })).toBe(false);
  });

  it('formats a compact prompt block in IST', () => {
    const block = headlinesBlock([h('Gold hits record on Fed cut bets', 1.5, 'Reuters')], 'Gold / silver');
    expect(block).toBe('HEADLINES (Gold / silver, free RSS, newest relevant first, IST):\n28 Nov 00:00 | Reuters | Gold hits record on Fed cut bets');
    expect(headlinesBlock([], 'x')).toBe('');
  });
});
