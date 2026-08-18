import assert from "node:assert/strict";
import test from "node:test";

const now = new Date();
const published = new Date(now.getTime() - 20 * 60_000).toUTCString();
const end = new Date(now.getTime() - 30_000).toISOString();
const animalTitle = "Elite runner was mauled by a brown bear on a mountain trail";
const techTitle = "Apple reveals pocket AI robot for the home";
const sportTitle = "Chicago Cubs star Pete Crow-Armstrong hits two home runs";
const officialTitle = "Bird defends state decision to submit voter data to feds";
const observedXQueries: string[] = [];
let recordedBillablePosts = 0;
let recordedQueryCount = 0;

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

const kymEntriesMarkdown = `### [Top Marketing React Native App Development Companies ![Image](https://i.kym-cdn.com/spam.png) ★ ### Spam](http://knowyourmeme.com/memes/promotional-spam)\n### [Bicep Trend ![Image](https://i.kym-cdn.com/bicep.png) ★ ### Bicep Trend](http://knowyourmeme.com/memes/bicep-trend)`;
const kymTrendingMarkdown = `#### [Cursed Pam Beesly Meme](https://trending.knowyourmeme.com/editorials/cursed-pam "Cursed Pam Beesly Meme")\n\n_August 18th, 2026 10:15 AM_\nA reaction image is spreading.\n\n* * *\n\n#### [Top 25 Memes of the Decade](https://trending.knowyourmeme.com/editorials/top-memes "Top 25 Memes of the Decade")\n\n_August 17th, 2026 10:15 AM_\nA generic historical roundup.`;
const kymUpdatedMarkdown = `#### [Corn Dog Cat Meme Returns](http://knowyourmeme.com/memes/corn-dog-cat "Corn Dog Cat Meme Returns")\n\n_August 18th, 2026 9:15 AM_\nAn older meme is resurging.`;
const kymResearchingMarkdown = `#### [Three Layer Dip Stack](http://knowyourmeme.com/memes/three-layer-dip-stack "Three Layer Dip Stack")\n\n_August 18th, 2026 8:15 AM_\nA new format is being documented.`;

process.env.TWITTERAPI_IO_KEY = "test-key";
process.env.TWITTERAPI_MONTHLY_BUDGET_USD = "5";
process.env.TWITTERAPI_SAMPLE_INTERVAL_MINUTES = "30";
process.env.TWITTERAPI_QUERY_LIMIT = "5";
process.env.TWITTERAPI_CACHE_HOURS = "6";
process.env.PUMPFUN_LIMIT = "4";
process.env.PUMPFUN_ENRICH_LIMIT = "1";
delete process.env.OPENAI_API_KEY;
delete process.env.YOUTUBE_API_KEY;
delete process.env.BRIGHTDATA_API_TOKEN;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (/https:\/\/(?:origin\.)?knowyourmeme\.com\/categories\/meme/.test(url)) return new Response("blocked", { status: 503 });
  if (/https:\/\/(?:origin|trending)\.knowyourmeme\.com\/newsfeed\/(?:trending|updated|researching)/.test(url)) return new Response("blocked", { status: 503 });
  if (url.startsWith("https://r.jina.ai/http://knowyourmeme.com/categories/meme")) return new Response(kymEntriesMarkdown, { status: 200 });
  if (url.endsWith("/newsfeed/trending")) return new Response(kymTrendingMarkdown, { status: 200 });
  if (url.endsWith("/newsfeed/updated")) return new Response(kymUpdatedMarkdown, { status: 200 });
  if (url.endsWith("/newsfeed/researching")) return new Response(kymResearchingMarkdown, { status: 200 });
  if (url.includes("trends.google.com/trending/rss")) return new Response(feed, { status: 200 });
  if (url.includes("news.google.com/rss")) return new Response(feed, { status: 200 });
  if (/feeds\.npr\.org|cbsnews\.com|rss\.nytimes\.com|theverge\.com|techcrunch\.com|wired\.com|mongabay\.com|catster\.com|smithsonianmag\.com|audubon\.org|blog\.nwf\.org|houstonzoo\.org|blog\.zoo\.org|zooatlanta\.org|denverzoo\.org|lpzoo\.org|phoenixzoo\.org/.test(url)) return new Response(feed, { status: 200 });
  if (url === "https://pump.fun/explore") return new Response(pumpHtml, { status: 200, headers: { "content-type": "text/html" } });
  if (url.includes("frontend-api-v3.pump.fun/coins/")) return Response.json(pumpCoin);
  if (url.endsWith("topstories.json")) return Response.json([]);
  if (url.includes("api.twitterapi.io/twitter/tweet/advanced_search")) {
    observedXQueries.push(new URL(url).searchParams.get("query") ?? "");
    const query = new URL(url).searchParams.get("query") ?? "";
    if (/bear/i.test(query)) return Response.json({ tweets: [{ id: "1234567890", url: "https://x.com/wildlife_reporter/status/1234567890", text: "This brown bear trail encounter is everywhere today.", createdAt: end, likeCount: 4200, retweetCount: 680, replyCount: 95, quoteCount: 120, author: { userName: "wildlife_reporter", name: "Wildlife Reporter", isBlueVerified: true } }] });
    return Response.json({
      tweets: [{ id: `meme-${observedXQueries.length}`, url: `https://x.com/meme_reporter/status/${observedXQueries.length}`, text: "This new meme format is spreading across timelines.", createdAt: end, likeCount: 900, retweetCount: 120, replyCount: 30, quoteCount: 25, author: { userName: "meme_reporter", name: "Meme Reporter" } }],
    });
  }
  throw new Error(`Unexpected URL in test: ${url}`);
}) as typeof fetch;

const { buildTrendsPayload } = await import("../lib/trend-engine");

test("discovers category-specific news and enriches selected stories with budgeted X samples", async () => {
  const payload = await buildTrendsPayload(new Map(), {
    twitterApiUsage: { billablePosts: 0, queryCount: 0 },
    recordTwitterApiUsage: async (billablePosts, queryCount) => {
      recordedBillablePosts += billablePosts;
      recordedQueryCount += queryCount;
    },
  });
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
  assert.ok(payload.trends.every((trend) => !/top 25 memes|memes of the decade/i.test(trend.title)));
  assert.ok(payload.trends.every((trend) => trend.firstSeenAt && Number.isFinite(new Date(trend.firstSeenAt).getTime())));
  assert.equal(payload.firstSeenMode, "detected");
  assert.ok(payload.trends.every((trend) => Date.now() - new Date(trend.firstSeenAt!).getTime() < 2 * 60_000), "new signals should use tracker detection time, not source publication time");
  assert.ok(payload.trends.every((trend) => trend.latestSourceAt && Number.isFinite(new Date(trend.latestSourceAt).getTime())));
  assert.ok(animal.summary.length > 20);
  assert.equal(animal.platforms.x.scope, "sample");
  assert.equal(animal.platforms.x.windows["24h"], 1);
  assert.match(animal.platforms.x.detail, /TwitterAPI\.io/);
  assert.ok(animal.evidence.some((item) => item.url === "https://x.com/wildlife_reporter/status/1234567890"));
  assert.ok(animal.evidence.some((item) => item.url === "https://news.example/bear"));
  assert.ok(observedXQueries.length >= 2 && observedXQueries.length <= 5);
  assert.ok(observedXQueries.some((query) => query.includes("bear") && !query.includes("runner was the person")));
  assert.ok(observedXQueries.some((query) => /bicep|pam|corn dog|dip stack/i.test(query)));
  assert.ok(meme.evidence.some((item) => item.url.includes("knowyourmeme.com")));
  assert.ok(meme.evidence.some((item) => item.source === "X search" && item.url.startsWith("https://x.com/search?")));
  assert.ok(payload.trends.some((trend) => trend.category === "Memes" && trend.subcategory === "New entries"));
  assert.ok(payload.trends.every((trend) => !/marketing react native app development/i.test(trend.title)));
  assert.equal(payload.sources.find((source) => source.key === "kym")?.state, "live");
  assert.match(payload.sources.find((source) => source.key === "kym")?.detail ?? "", /reader fallback/);
  assert.match(payload.sources.find((source) => source.key === "x")?.detail ?? "", /live sample/);
  assert.equal(recordedBillablePosts, observedXQueries.length);
  assert.equal(recordedQueryCount, observedXQueries.length);
  assert.equal(payload.pumpCoins[0]?.name, "Jimothy The Raccoon");
  assert.equal(payload.pumpCoins[0]?.bucket, "Trending now");
  assert.equal(payload.pumpCoins[0]?.xPosts, undefined);
  assert.equal(payload.sources.find((source) => source.key === "pumpfun")?.state, "live");
  assert.match(payload.sources.find((source) => source.key === "publisher")?.detail ?? "", /11 dedicated animal/);

  const queriesBeforeCacheCheck = observedXQueries.length;
  const cachedPayload = await buildTrendsPayload(new Map(), {
    previousPayload: payload,
    twitterApiUsage: { billablePosts: recordedBillablePosts, queryCount: recordedQueryCount, lastUsedAt: new Date().toISOString() },
  });
  assert.equal(observedXQueries.length, queriesBeforeCacheCheck, "the 30-minute cadence should prevent another paid query");
  assert.equal(cachedPayload.trends.find((trend) => trend.id === animal.id)?.firstSeenAt, animal.firstSeenAt, "detected-at time should survive later refreshes");
  assert.ok(cachedPayload.trends.some((trend) => trend.platforms.x?.scope === "sample"), "cached X samples should remain visible between query slots");
  assert.match(cachedPayload.sources.find((source) => source.key === "x")?.detail ?? "", /cached samples/);

  const cappedPayload = await buildTrendsPayload(new Map(), {
    previousPayload: payload,
    twitterApiUsage: { billablePosts: 33_320, queryCount: 2_000 },
  });
  assert.equal(observedXQueries.length, queriesBeforeCacheCheck, "the monthly budget guard should block paid queries");
  assert.equal(cappedPayload.sources.find((source) => source.key === "x")?.state, "restricted");
  assert.match(cappedPayload.sources.find((source) => source.key === "x")?.detail ?? "", /monthly TwitterAPI\.io cap reached/);
});
