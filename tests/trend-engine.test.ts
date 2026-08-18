import assert from "node:assert/strict";
import test from "node:test";

const now = new Date();
const published = new Date(now.getTime() - 20 * 60_000).toUTCString();
const end = new Date(now.getTime() - 30_000).toISOString();
const start = new Date(now.getTime() - 90_000).toISOString();
const animalTitle = "Elite runner was mauled by a brown bear on a mountain trail";
const techTitle = "Apple reveals pocket AI robot for the home";
const sportTitle = "Chicago Cubs star Pete Crow-Armstrong hits two home runs";
const officialTitle = "Bird defends state decision to submit voter data to feds";
const observedXQueries: string[] = [];

function flightFrame(id: string, props: Record<string, unknown>) {
  const chunk = `${id}:${JSON.stringify(["$", "$Ltest", null, props])}`;
  return `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`;
}

const pumpCoin = {
  mint: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
  name: "Jimothy The Raccoon",
  symbol: "Jimothy",
  description: "The internet raccoon story",
  twitter: "https://x.com/jimothy/status/999",
  website: "https://example.com/jimothy",
  usd_market_cap: 6_500_000,
  created_timestamp: now.getTime() - 2 * 24 * 60 * 60_000,
};
const pumpHtml = `<!doctype html>${flightFrame("64", { runners: [{ coin: pumpCoin, description: "The Internet Isn't Done With Jimothy Yet" }] })}${flightFrame("ee", { initialSearchParams: {}, initialCoins: [pumpCoin] })}`;

function rss(items: Array<{ title: string; link: string; source: string; traffic?: string }>) {
  return `<?xml version="1.0"?><rss><channel>${items.map((item) => `<item><title>${item.title} - ${item.source}</title><link>${item.link}</link><pubDate>${published}</pubDate><ht:approx_traffic>${item.traffic ?? "500+"}</ht:approx_traffic><ht:news_item_title>${item.title}</ht:news_item_title><ht:news_item_url>${item.link}</ht:news_item_url><ht:news_item_source>${item.source}</ht:news_item_source></item>`).join("")}</channel></rss>`;
}

const feed = rss([
  { title: animalTitle, link: "https://news.example/bear", source: "Wildlife Daily", traffic: "5K+" },
  { title: techTitle, link: "https://news.example/robot", source: "Tech Daily", traffic: "2K+" },
  { title: sportTitle, link: "https://news.example/baseball", source: "Sports Daily", traffic: "4K+" },
  { title: officialTitle, link: "https://news.example/government", source: "State News", traffic: "3K+" },
]);

const kymEntriesHtml = `<a class="item" data-title="Bicep Trend" href="/memes/bicep-trend"><h3>Bicep Trend</h3></a>`;
const kymTrendingHtml = `<article data-title="Cursed Pam Beesly Meme" data-type="Editorial"><a href="https://trending.knowyourmeme.com/editorials/cursed-pam" class="newsfeed-title">Cursed Pam Beesly Meme</a><a class="newsfeed-stamp">Trending</a><small class="text-muted"><em></em></small><div><p>A reaction image is spreading.</p></div></article>`;
const kymUpdatedHtml = `<article data-title="Corn Dog Cat Meme Returns" data-type="Editorial"><a href="/memes/corn-dog-cat" class="newsfeed-title">Corn Dog Cat Meme Returns</a><a class="newsfeed-stamp">Updated</a><small class="text-muted"><em></em></small><div><p>An older meme is resurging.</p></div></article>`;
const kymResearchingHtml = `<article data-title="Three Layer Dip Stack" data-type="Editorial"><a href="/memes/three-layer-dip-stack" class="newsfeed-title">Three Layer Dip Stack</a><a class="newsfeed-stamp">Researching</a><small class="text-muted"><em></em></small><div><p>A new format is being documented.</p></div></article>`;

process.env.X_BEARER_TOKEN = "test-token";
process.env.X_COUNT_ENRICH_LIMIT = "8";
process.env.X_POSTS_PER_TREND = "10";
process.env.PUMPFUN_LIMIT = "4";
process.env.PUMPFUN_ENRICH_LIMIT = "1";
process.env.PUMPFUN_X_ENRICH_LIMIT = "1";
delete process.env.OPENAI_API_KEY;
delete process.env.YOUTUBE_API_KEY;
delete process.env.BRIGHTDATA_API_TOKEN;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("origin.knowyourmeme.com/categories/meme")) return new Response(kymEntriesHtml, { status: 200 });
  if (url.includes("origin.knowyourmeme.com/newsfeed/trending")) return new Response(kymTrendingHtml, { status: 200 });
  if (url.includes("origin.knowyourmeme.com/newsfeed/updated")) return new Response(kymUpdatedHtml, { status: 200 });
  if (url.includes("origin.knowyourmeme.com/newsfeed/researching")) return new Response(kymResearchingHtml, { status: 200 });
  if (url.includes("trends.google.com/trending/rss")) return new Response(feed, { status: 200 });
  if (url.includes("news.google.com/rss")) return new Response(feed, { status: 200 });
  if (/feeds\.npr\.org|cbsnews\.com|rss\.nytimes\.com|theverge\.com|techcrunch\.com|wired\.com|mongabay\.com|catster\.com|smithsonianmag\.com|audubon\.org|blog\.nwf\.org|houstonzoo\.org|blog\.zoo\.org|zooatlanta\.org|denverzoo\.org|lpzoo\.org|phoenixzoo\.org/.test(url)) return new Response(feed, { status: 200 });
  if (url === "https://pump.fun/explore") return new Response(pumpHtml, { status: 200, headers: { "content-type": "text/html" } });
  if (url.includes("frontend-api-v3.pump.fun/coins/")) return Response.json(pumpCoin);
  if (url.endsWith("topstories.json")) return Response.json([]);
  if (url.includes("/trends/by/woeid/")) return Response.json({ data: [] });
  if (url.includes("/tweets/counts/recent")) {
    observedXQueries.push(new URL(url).searchParams.get("query") ?? "");
    return Response.json({ data: [{ start, end, tweet_count: 240 }] });
  }
  if (url.includes("/tweets/search/recent")) {
    const query = new URL(url).searchParams.get("query") ?? "";
    observedXQueries.push(query);
    if (query.includes("Jimothy")) return Response.json({
      data: [{ id: "987654321", text: "Jimothy the raccoon is taking over timelines.", author_id: "77", created_at: end, public_metrics: { like_count: 900, retweet_count: 120, reply_count: 30, quote_count: 25 } }],
      includes: { users: [{ id: "77", username: "meme_reporter", name: "Meme Reporter" }] },
    });
    return Response.json({
      data: [{ id: "1234567890", text: "This brown bear trail encounter is everywhere today.", author_id: "42", created_at: end, public_metrics: { like_count: 4200, retweet_count: 680, reply_count: 95, quote_count: 120 } }],
      includes: { users: [{ id: "42", username: "wildlife_reporter", name: "Wildlife Reporter", verified: true }] },
    });
  }
  throw new Error(`Unexpected URL in test: ${url}`);
}) as typeof fetch;

const { buildTrendsPayload } = await import("../lib/trend-engine");

test("discovers category-specific news and enriches a story with X counts and leading posts", async () => {
  const payload = await buildTrendsPayload();
  const animal = payload.trends.find((trend) => trend.category === "Animals");
  const technology = payload.trends.find((trend) => trend.category === "Technology");
  const baseball = payload.trends.find((trend) => trend.title.includes("Crow-Armstrong"));
  const government = payload.trends.find((trend) => trend.title.includes("Bird defends"));
  const meme = payload.trends.find((trend) => trend.category === "Memes");

  assert.ok(animal, "expected an animal trend");
  assert.ok(technology, "expected a technology trend");
  assert.ok(baseball, "expected the Pete Crow-Armstrong story");
  assert.ok(government, "expected the government official story");
  assert.ok(meme, "expected a Know Your Meme signal");
  assert.equal(baseball.category, "Sports");
  assert.equal(government.category, "News");
  assert.equal(animal.title, "Brown Bear Trail Attack");
  assert.ok(payload.trends.every((trend) => trend.title.length <= 42 && trend.title.split(/\s+/).length <= 5));
  assert.ok(animal.summary.length > 20);
  assert.equal(animal.platforms.x.windows["24h"], 240);
  assert.ok(animal.evidence.some((item) => item.url === "https://x.com/wildlife_reporter/status/1234567890"));
  assert.ok(animal.evidence.some((item) => item.url === "https://news.example/bear"));
  assert.ok(observedXQueries.length >= 2);
  assert.ok(observedXQueries.some((query) => query.includes("bear") && !query.includes("runner was the person")));
  assert.ok(observedXQueries.some((query) => /bicep|pam|corn dog|dip stack/i.test(query)));
  assert.ok(meme.evidence.some((item) => item.url.includes("knowyourmeme.com")));
  assert.equal(payload.sources.find((source) => source.key === "kym")?.state, "live");
  assert.match(payload.sources.find((source) => source.key === "x")?.detail ?? "", /top-post links/);
  assert.equal(payload.pumpCoins[0]?.name, "Jimothy The Raccoon");
  assert.equal(payload.pumpCoins[0]?.bucket, "Trending now");
  assert.equal(payload.pumpCoins[0]?.xPosts?.["24h"], 240);
  assert.ok(payload.pumpCoins[0]?.evidence.some((item) => item.url === "https://x.com/meme_reporter/status/987654321"));
  assert.equal(payload.sources.find((source) => source.key === "pumpfun")?.state, "live");
  assert.match(payload.sources.find((source) => source.key === "publisher")?.detail ?? "", /11 dedicated animal/);
});
