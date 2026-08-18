import assert from "node:assert/strict";
import test from "node:test";

const now = new Date();
const published = new Date(now.getTime() - 20 * 60_000).toUTCString();
const end = new Date(now.getTime() - 30_000).toISOString();
const start = new Date(now.getTime() - 90_000).toISOString();
const animalTitle = "Elite runner was mauled by a brown bear on a mountain trail";
const techTitle = "Apple reveals pocket AI robot for the home";

function rss(items: Array<{ title: string; link: string; source: string; traffic?: string }>) {
  return `<?xml version="1.0"?><rss><channel>${items.map((item) => `<item><title>${item.title} - ${item.source}</title><link>${item.link}</link><pubDate>${published}</pubDate><ht:approx_traffic>${item.traffic ?? "500+"}</ht:approx_traffic><ht:news_item_title>${item.title}</ht:news_item_title><ht:news_item_url>${item.link}</ht:news_item_url><ht:news_item_source>${item.source}</ht:news_item_source></item>`).join("")}</channel></rss>`;
}

const feed = rss([
  { title: animalTitle, link: "https://news.example/bear", source: "Wildlife Daily", traffic: "5K+" },
  { title: techTitle, link: "https://news.example/robot", source: "Tech Daily", traffic: "2K+" },
]);

process.env.X_BEARER_TOKEN = "test-token";
process.env.X_COUNT_ENRICH_LIMIT = "4";
process.env.X_POSTS_PER_TREND = "10";
delete process.env.OPENAI_API_KEY;
delete process.env.YOUTUBE_API_KEY;
delete process.env.BRIGHTDATA_API_TOKEN;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("trends.google.com/trending/rss")) return new Response(feed, { status: 200 });
  if (url.includes("news.google.com/rss")) return new Response(feed, { status: 200 });
  if (url.endsWith("topstories.json")) return Response.json([]);
  if (url.includes("/trends/by/woeid/")) return Response.json({ data: [] });
  if (url.includes("/tweets/counts/recent")) return Response.json({ data: [{ start, end, tweet_count: 240 }] });
  if (url.includes("/tweets/search/recent")) {
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

  assert.ok(animal, "expected an animal trend");
  assert.ok(technology, "expected a technology trend");
  assert.equal(animal.title, "Brown Bear Trail Attack");
  assert.ok(animal.title.length <= 58);
  assert.ok(animal.summary.length > 20);
  assert.equal(animal.platforms.x.windows["24h"], 240);
  assert.ok(animal.evidence.some((item) => item.url === "https://x.com/wildlife_reporter/status/1234567890"));
  assert.ok(animal.evidence.some((item) => item.url === "https://news.example/bear"));
  assert.match(payload.sources.find((source) => source.key === "x")?.detail ?? "", /top-post links/);
});
