import type { HistoricalSnapshot } from "./trend-store";
import { applyHistory } from "./trend-store";
import { TREND_TAXONOMY } from "./trend-types";
import type { NewsItem, Phase, PlatformMetric, SourceStatus, Trend, TrendEvidence, TrendsPayload, WindowValues } from "./trend-types";

type RuntimeEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  X_BEARER_TOKEN?: string;
  X_WOEIDS?: string;
  X_COUNT_ENRICH_LIMIT?: string;
  X_POSTS_PER_TREND?: string;
  YOUTUBE_API_KEY?: string;
  YOUTUBE_REGIONS?: string;
  BRIGHTDATA_API_TOKEN?: string;
  TIKTOK_QUERY_LIMIT?: string;
  TIKTOK_POSTS_PER_QUERY?: string;
  TIKTOK_SEED_QUERIES?: string;
};

type SourceKey = "google" | "news" | "hackernews" | "x" | "youtube" | "tiktok";

type Candidate = {
  id: string;
  title: string;
  url: string;
  source: SourceKey;
  sourceLabel: string;
  publishedAt: string;
  activity: number;
  strength: number;
  detail: string;
  geography: string;
  platform?: { key: "x" | "tiktok"; metric: PlatformMetric };
  relatedNews?: { title: string; url: string; source: string };
  extraEvidence?: TrendEvidence[];
};

type CollectorResult = { items: Candidate[]; status: SourceStatus };

const windows = <T>(value: T): Record<"5m" | "30m" | "60m" | "6h" | "24h", T> => ({
  "5m": value,
  "30m": value,
  "60m": value,
  "6h": value,
  "24h": value,
});

const runtime = process.env as RuntimeEnv;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

async function fetchText(url: string, init?: RequestInit, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { "User-Agent": "FrontRun/1.0 trend intelligence", ...(init?.headers ?? {}) } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 12_000): Promise<T> {
  return JSON.parse(await fetchText(url, init, timeoutMs)) as T;
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .trim();
}

function tag(xml: string, name: string) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function rssItems(xml: string) {
  return xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
}

function numberFromTraffic(value: string) {
  const normalized = value.replace(/[+,\s]/g, "").toUpperCase();
  const multiplier = normalized.endsWith("M") ? 1_000_000 : normalized.endsWith("K") ? 1_000 : 1;
  return Math.max(1, Math.round(Number.parseFloat(normalized) * multiplier) || 1);
}

async function collectGoogleTrends(): Promise<CollectorResult> {
  try {
    const regions = ["US"];
    const responses = await Promise.all(regions.map((geo) => fetchText(`https://trends.google.com/trending/rss?geo=${geo}`)));
    const seen = new Set<string>();
    const items: Candidate[] = [];
    responses.forEach((xml, regionIndex) => {
      const geo = regions[regionIndex];
      rssItems(xml).slice(0, 25).forEach((entry, index) => {
        const title = tag(entry, "title");
        const key = normalize(title);
        if (!isUsefulTitle(title) || seen.has(key)) return;
        seen.add(key);
        const activity = numberFromTraffic(tag(entry, "ht:approx_traffic") || "1");
        const publishedAt = new Date(tag(entry, "pubDate") || Date.now()).toISOString();
        const articleUrl = tag(entry, "ht:news_item_url") || `https://trends.google.com/trending?geo=${geo}`;
        const relatedTitle = tag(entry, "ht:news_item_title");
        const relatedSource = tag(entry, "ht:news_item_source") || "Publisher";
        items.push({
          id: `google-${slug(title)}`,
          title,
          url: articleUrl,
          source: "google",
          sourceLabel: "Google Trends",
          publishedAt,
          activity,
          strength: clamp(42 + Math.log10(activity + 1) * 12 - index * 0.35, 30, 98),
          detail: `${tag(entry, "ht:approx_traffic") || activity.toLocaleString()} searches · ${geo}`,
          geography: geo,
          relatedNews: relatedTitle ? { title: relatedTitle, url: articleUrl, source: relatedSource } : undefined,
        });
      });
    });
    return { items, status: { key: "google", label: "Google Trends", state: "live", detail: "Live search breakouts", itemCount: items.length } };
  } catch (error) {
    return { items: [], status: { key: "google", label: "Google Trends", state: "error", detail: errorMessage(error), itemCount: 0 } };
  }
}

async function collectGoogleNews(): Promise<CollectorResult> {
  try {
    const feeds = [
      { label: "US top stories", query: "", limit: 32, strength: 68 },
      { label: "Animal watch", query: "(animal OR wildlife OR zoo OR pet OR cat OR dog OR bear OR whale OR dolphin OR rescue) when:1d", limit: 24, strength: 74 },
      { label: "Technology watch", query: "(technology OR AI OR robot OR Apple OR Google OR OpenAI OR startup OR cybersecurity OR space) when:1d", limit: 24, strength: 73 },
      { label: "Viral watch", query: "(viral OR meme OR \"caught on camera\" OR \"social media\") when:1d", limit: 18, strength: 70 },
    ];
    const responses = await Promise.all(feeds.map((feed) => {
      const base = feed.query ? "https://news.google.com/rss/search" : "https://news.google.com/rss";
      const params = new URLSearchParams({ hl: "en-US", gl: "US", ceid: "US:en" });
      if (feed.query) params.set("q", feed.query);
      return fetchText(`${base}?${params}`);
    }));
    const seen = new Set<string>();
    const items: Candidate[] = [];
    responses.forEach((xml, feedIndex) => {
      const feed = feeds[feedIndex];
      rssItems(xml).slice(0, feed.limit).forEach((entry, index) => {
        const rawTitle = tag(entry, "title");
        const split = rawTitle.lastIndexOf(" - ");
        const title = (split > 0 ? rawTitle.slice(0, split) : rawTitle).trim();
        const key = normalize(title);
        if (!isUsefulTitle(title) || seen.has(key)) return;
        seen.add(key);
        const outlet = split > 0 ? rawTitle.slice(split + 3) : "Publisher";
        items.push({
          id: `news-${slug(title)}`,
          title,
          url: tag(entry, "link") || "https://news.google.com/",
          source: "news",
          sourceLabel: outlet,
          publishedAt: new Date(tag(entry, "pubDate") || Date.now()).toISOString(),
          activity: 1,
          strength: clamp(feed.strength - index * 0.55, 36, feed.strength),
          detail: `${outlet} · ${feed.label}`,
          geography: "US",
        });
      });
    });
    return { items, status: { key: "news", label: "Google News", state: "live", detail: "US top stories plus dedicated Animals, Technology and Viral feeds", itemCount: items.length } };
  } catch (error) {
    return { items: [], status: { key: "news", label: "Google News", state: "error", detail: errorMessage(error), itemCount: 0 } };
  }
}

type HnItem = { id: number; title?: string; url?: string; time?: number; score?: number; descendants?: number; type?: string };

async function collectHackerNews(): Promise<CollectorResult> {
  try {
    const ids = await fetchJson<number[]>("https://hacker-news.firebaseio.com/v0/topstories.json");
    const stories = await Promise.all(ids.slice(0, 20).map((id) => fetchJson<HnItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));
    const items = stories.filter((story) => story.type === "story" && story.title).map((story, index) => {
      const activity = Math.max(1, (story.score ?? 0) + (story.descendants ?? 0));
      return {
        id: `hackernews-${story.id}`,
        title: story.title!,
        url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
        source: "hackernews" as const,
        sourceLabel: "Hacker News",
        publishedAt: new Date((story.time ?? Date.now() / 1000) * 1000).toISOString(),
        activity,
        strength: clamp(24 + Math.log10(activity + 1) * 12 - index * 0.3, 20, 68),
        detail: `${story.score ?? 0} points · ${story.descendants ?? 0} comments`,
        geography: "Global",
      };
    });
    return { items, status: { key: "hackernews", label: "Hacker News", state: "live", detail: "Live top-story velocity", itemCount: items.length } };
  } catch (error) {
    return { items: [], status: { key: "hackernews", label: "Hacker News", state: "error", detail: errorMessage(error), itemCount: 0 } };
  }
}

type XTrendResponse = { data?: Array<{ trend_name: string; tweet_count?: number }> };
type XCountResponse = { data?: Array<{ start: string; end: string; tweet_count: number }> };
type XPost = {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: { retweet_count?: number; reply_count?: number; like_count?: number; quote_count?: number };
};
type XSearchResponse = {
  data?: XPost[];
  includes?: { users?: Array<{ id: string; username: string; name?: string; verified?: boolean }> };
};

function platformWindowsFromBuckets(buckets: Array<{ end: string; tweet_count: number }>, now = Date.now()): WindowValues {
  const durations: Record<keyof WindowValues, number> = { "5m": 5, "30m": 30, "60m": 60, "6h": 360, "24h": 1440 };
  return Object.fromEntries(
    Object.entries(durations).map(([key, minutes]) => [
      key,
      buckets.filter((bucket) => new Date(bucket.end).getTime() >= now - minutes * 60_000).reduce((sum, bucket) => sum + bucket.tweet_count, 0),
    ]),
  ) as WindowValues;
}

function xCountQuery(trendName: string) {
  const cleaned = trendName.replace(/["\\]/g, " ").trim();
  if (cleaned.startsWith("#") && !cleaned.includes(" ")) return `${cleaned} lang:en -is:retweet`;
  const topicTerms = new Set(["ai", "airpods", "animal", "bear", "bird", "cat", "cybersecurity", "dog", "dolphin", "iphone", "kitten", "moon", "openai", "pet", "puppy", "robot", "rocket", "shark", "spacex", "starship", "tiktok", "viral", "whale", "wildlife"]);
  const genericCapitalized = new Set(["after", "analysis", "breaking", "enter", "exclusive", "how", "latest", "meet", "new", "the", "this", "time", "to", "update", "video", "watch", "what", "when", "where", "who", "why", "with", "your"]);
  const allCapsTerms = cleaned.match(/\b[A-Z]{2,}[A-Z0-9]*\b/g)?.map((word) => normalize(word)).filter(Boolean) ?? [];
  const capitalized = cleaned.match(/\b[A-Z][A-Za-z0-9’'-]+\b/g) ?? [];
  const capitalizedTerms = capitalized.map((word) => normalize(word)).filter((word) => word && !genericCapitalized.has(word));
  const domainTerms = tokens(cleaned).filter((word) => topicTerms.has(word));
  const allTerms = tokens(cleaned);
  const words = [...new Set([...domainTerms, ...allCapsTerms, ...capitalizedTerms, ...allTerms])].slice(0, 5);
  return `${words.join(" ") || normalize(cleaned)} lang:en -is:retweet`;
}

async function collectXWindowCounts(trendName: string): Promise<WindowValues> {
  const now = Date.now();
  const params = new URLSearchParams({
    query: xCountQuery(trendName),
    granularity: "minute",
    start_time: new Date(now - 24 * 60 * 60_000).toISOString(),
    end_time: new Date(now - 15_000).toISOString(),
  });
  const response = await fetchJson<XCountResponse>(`https://api.x.com/2/tweets/counts/recent?${params}`, {
    headers: { Authorization: `Bearer ${runtime.X_BEARER_TOKEN}` },
  });
  return platformWindowsFromBuckets(response.data ?? [], now);
}

function xPostEngagement(post: XPost) {
  const metrics = post.public_metrics;
  return Number(metrics?.like_count ?? 0) + Number(metrics?.retweet_count ?? 0) * 2 + Number(metrics?.quote_count ?? 0) * 2 + Number(metrics?.reply_count ?? 0);
}

async function collectXTopPosts(trendName: string): Promise<{ evidence: TrendEvidence[]; newest?: string; engagement: number }> {
  const maxResults = clamp(Number(runtime.X_POSTS_PER_TREND ?? 10) || 10, 10, 25);
  const params = new URLSearchParams({
    query: xCountQuery(trendName),
    max_results: String(maxResults),
    sort_order: "relevancy",
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username,name,verified",
  });
  const response = await fetchJson<XSearchResponse>(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${runtime.X_BEARER_TOKEN}` },
  });
  const users = new Map((response.includes?.users ?? []).map((user) => [user.id, user]));
  const ranked = [...(response.data ?? [])].sort((a, b) => xPostEngagement(b) - xPostEngagement(a)).slice(0, 3);
  const evidence = ranked.map((post) => {
    const user = post.author_id ? users.get(post.author_id) : undefined;
    const username = user?.username || "i";
    const metrics = post.public_metrics;
    return {
      source: user?.username ? `X · @${user.username}` : "X",
      title: post.text.replace(/\s+/g, " ").trim().slice(0, 160),
      url: `https://x.com/${username}/status/${post.id}`,
      detail: `${Number(metrics?.like_count ?? 0).toLocaleString()} likes · ${Number(metrics?.retweet_count ?? 0).toLocaleString()} reposts · ${Number(metrics?.reply_count ?? 0).toLocaleString()} replies`,
    };
  });
  return {
    evidence,
    newest: ranked.map((post) => post.created_at).filter((value): value is string => Boolean(value)).sort().at(-1),
    engagement: ranked.reduce((sum, post) => sum + xPostEngagement(post), 0),
  };
}

async function collectXSignal(trendName: string) {
  const [countsResult, postsResult] = await Promise.allSettled([collectXWindowCounts(trendName), collectXTopPosts(trendName)]);
  if (countsResult.status === "rejected" && postsResult.status === "rejected") throw countsResult.reason;
  return {
    counts: countsResult.status === "fulfilled" ? countsResult.value : undefined,
    posts: postsResult.status === "fulfilled" ? postsResult.value : undefined,
  };
}

function xCandidatePriority(item: Candidate) {
  const [category] = categoryFor(`${item.title} ${item.relatedNews?.title ?? ""}`, item.source === "news" || Boolean(item.relatedNews));
  const categoryBoost = category === "Animals" ? 90 : category === "Technology" ? 75 : category === "Viral events" ? 55 : 25;
  const sourceBoost = item.source === "google" ? 12 : item.source === "news" ? 8 : 0;
  return categoryBoost + sourceBoost + item.strength;
}

async function collectX(sourceCandidates: Candidate[]): Promise<CollectorResult> {
  if (!runtime.X_BEARER_TOKEN) {
    return { items: [], status: { key: "x", label: "X", state: "needs-key", detail: "Add X_BEARER_TOKEN for trend names, post counts and top-post links", itemCount: 0 } };
  }
  const nativeItems: Candidate[] = [];
  let trendsError: unknown;
  try {
    const woeids = (runtime.X_WOEIDS || "23424977").split(",").map((value) => value.trim()).filter(Boolean);
    const responses = await Promise.all(woeids.map((woeid) => fetchJson<XTrendResponse>(`https://api.x.com/2/trends/by/woeid/${woeid}?max_trends=30&trend.fields=trend_name,tweet_count`, { headers: { Authorization: `Bearer ${runtime.X_BEARER_TOKEN}` } })));
    const seen = new Set<string>();
    for (const response of responses) {
      for (const trend of response.data ?? []) {
        const key = normalize(trend.trend_name);
        if (!isUsefulTitle(trend.trend_name) || seen.has(key)) continue;
        seen.add(key);
        const activity = Math.max(1, trend.tweet_count ?? 1);
        nativeItems.push({
          id: `x-${slug(trend.trend_name)}`,
          title: trend.trend_name.replace(/^#/, ""),
          url: `https://x.com/search?q=${encodeURIComponent(trend.trend_name)}`,
          source: "x",
          sourceLabel: "X",
          publishedAt: new Date().toISOString(),
          activity,
          strength: clamp(46 + Math.log10(activity + 1) * 11, 45, 98),
          detail: trend.tweet_count ? `${trend.tweet_count.toLocaleString()} posts` : "Trending on X",
          geography: woeids.length > 1 ? "Multi-region" : "US",
        });
      }
    }
  } catch (error) {
    trendsError = error;
  }

  const totalLimit = clamp(Number(runtime.X_COUNT_ENRICH_LIMIT ?? 12) || 12, 1, 20);
  const storyLimit = Math.min(9, Math.max(1, totalLimit - 3));
  const storySeen = new Set<string>();
  const storySeeds = [...sourceCandidates]
    .filter((item) => item.source === "news" || item.source === "google" || item.source === "hackernews")
    .sort((a, b) => xCandidatePriority(b) - xCandidatePriority(a))
    .filter((item) => {
      const key = normalize(shortTrendTitle(item.title));
      if (!key || storySeen.has(key)) return false;
      storySeen.add(key);
      return true;
    })
    .slice(0, storyLimit);
  const targets = [
    ...nativeItems.slice(0, Math.max(0, totalLimit - storySeeds.length)).map((item) => ({ kind: "native" as const, item })),
    ...storySeeds.map((item) => ({ kind: "story" as const, item })),
  ];
  const enriched = await Promise.allSettled(targets.map(async (target) => ({ target, signal: await collectXSignal(target.item.title) })));
  const storyItems: Candidate[] = [];
  let countCoverage = 0;
  let postCoverage = 0;
  for (const result of enriched) {
    if (result.status !== "fulfilled") continue;
    const { target, signal } = result.value;
    if (signal.counts) countCoverage += 1;
    if (signal.posts?.evidence.length) postCoverage += 1;
    const platform = signal.counts ? {
      key: "x" as const,
      metric: { label: "X posts", metric: "posts" as const, scope: "exact" as const, windows: signal.counts, detail: "Official recent-count API; reposts excluded" },
    } : undefined;
    const evidence = signal.posts?.evidence ?? [];
    if (target.kind === "native") {
      target.item.platform = platform;
      target.item.extraEvidence = evidence;
      if (evidence[0]) target.item.url = evidence[0].url;
      continue;
    }
    const activity = Math.max(1, signal.counts?.["24h"] ?? signal.posts?.engagement ?? 1);
    if (!signal.counts && evidence.length === 0) continue;
    storyItems.push({
      id: `x-story-${slug(target.item.title)}`,
      title: target.item.title,
      url: evidence[0]?.url || `https://x.com/search?q=${encodeURIComponent(xCountQuery(target.item.title))}`,
      source: "x",
      sourceLabel: "X",
      publishedAt: signal.posts?.newest || new Date().toISOString(),
      activity,
      strength: clamp(40 + Math.log10(activity + 1) * 12 + (evidence.length ? 5 : 0), 38, 96),
      detail: signal.counts ? `${signal.counts["24h"].toLocaleString()} original posts in 24h · ${evidence.length} leading posts linked` : `${evidence.length} leading posts linked`,
      geography: "US-seeded · English X",
      platform,
      extraEvidence: evidence,
    });
  }

  const items = [...nativeItems, ...storyItems];
  const detail = countCoverage || postCoverage
    ? `${storyItems.length} news-led stories checked · exact counts for ${countCoverage} signals · top-post links for ${postCoverage}`
    : trendsError ? errorMessage(trendsError) : "X returned no matching activity this run";
  return { items, status: { key: "x", label: "X", state: items.length ? "live" : "error", detail, itemCount: items.length } };
}

type YouTubeResponse = { items?: Array<{ id: string; snippet: { title: string; publishedAt: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> };

async function collectYouTube(): Promise<CollectorResult> {
  if (!runtime.YOUTUBE_API_KEY) {
    return { items: [], status: { key: "youtube", label: "YouTube", state: "needs-key", detail: "Add YOUTUBE_API_KEY for popular video statistics", itemCount: 0 } };
  }
  try {
    const regions = (runtime.YOUTUBE_REGIONS || "US").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 4);
    const responses = await Promise.all(regions.map((region) => fetchJson<YouTubeResponse>(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${region}&maxResults=25&key=${encodeURIComponent(runtime.YOUTUBE_API_KEY!)}`)));
    const seen = new Set<string>();
    const items: Candidate[] = [];
    responses.forEach((response, regionIndex) => {
      for (const video of response.items ?? []) {
        if (seen.has(video.id)) continue;
        seen.add(video.id);
        const views = Number(video.statistics?.viewCount ?? 0);
        const ageHours = Math.max(1, (Date.now() - new Date(video.snippet.publishedAt).getTime()) / 3_600_000);
        const velocity = views / ageHours;
        items.push({
          id: `youtube-${video.id}`,
          title: video.snippet.title,
          url: `https://www.youtube.com/watch?v=${video.id}`,
          source: "youtube",
          sourceLabel: "YouTube",
          publishedAt: video.snippet.publishedAt,
          activity: views,
          strength: clamp(28 + Math.log10(velocity + 1) * 15, 25, 96),
          detail: `${views.toLocaleString()} views · ${regions[regionIndex]}`,
          geography: regions[regionIndex],
        });
      }
    });
    return { items, status: { key: "youtube", label: "YouTube", state: "live", detail: "Popular-video view velocity", itemCount: items.length } };
  } catch (error) {
    return { items: [], status: { key: "youtube", label: "YouTube", state: "error", detail: errorMessage(error), itemCount: 0 } };
  }
}

type TikTokPost = {
  post_id?: string;
  description?: string;
  create_time?: string;
  share_count?: number;
  comment_count?: number;
  play_count?: number;
  profile_username?: string;
  profile_url?: string;
};

function tiktokPostWindows(posts: TikTokPost[], now = Date.now()): WindowValues {
  const durations: Record<keyof WindowValues, number> = { "5m": 5, "30m": 30, "60m": 60, "6h": 360, "24h": 1440 };
  return Object.fromEntries(
    Object.entries(durations).map(([key, minutes]) => [
      key,
      posts.filter((post) => post.create_time && new Date(post.create_time).getTime() >= now - minutes * 60_000).length,
    ]),
  ) as WindowValues;
}

function shortSearchQuery(title: string) {
  return tokens(title).slice(0, 6).join(" ") || title.replace(/^#/, "").trim();
}

async function collectTikTok(sourceCandidates: Candidate[]): Promise<CollectorResult> {
  if (!runtime.BRIGHTDATA_API_TOKEN) {
    return { items: [], status: { key: "tiktok", label: "TikTok", state: "needs-key", detail: "Add BRIGHTDATA_API_TOKEN for compliant keyword discovery and sampled post metrics", itemCount: 0 } };
  }

  try {
    const queryLimit = clamp(Number(runtime.TIKTOK_QUERY_LIMIT ?? 6) || 6, 1, 12);
    const postsPerQuery = clamp(Number(runtime.TIKTOK_POSTS_PER_QUERY ?? 20) || 20, 5, 50);
    const automatic = sourceCandidates
      .filter((item) => item.source === "x" || item.source === "google")
      .slice(0, Math.ceil(queryLimit / 2))
      .map((item) => ({ title: item.title, query: shortSearchQuery(item.title) }));
    const manual = (runtime.TIKTOK_SEED_QUERIES || "viral,cute animal,meme,challenge")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((query) => ({ title: query.replace(/\b\w/g, (letter) => letter.toUpperCase()), query }));
    const seen = new Set<string>();
    const seeds = [...automatic, ...manual].filter((seed) => {
      const key = normalize(seed.query);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, queryLimit);

    const endpoint = new URL("https://api.brightdata.com/datasets/v3/scrape");
    endpoint.searchParams.set("dataset_id", "gd_lu702nij2f790tmv9h");
    endpoint.searchParams.set("type", "discover_new");
    endpoint.searchParams.set("discover_by", "keyword");
    endpoint.searchParams.set("format", "json");

    const results = await Promise.allSettled(seeds.map(async (seed) => {
      const response = await fetchJson<TikTokPost[] | { data?: TikTokPost[] }>(endpoint.toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.BRIGHTDATA_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: [{ search_keyword: seed.query, num_of_posts: postsPerQuery }] }),
      }, 60_000);
      const posts = Array.isArray(response) ? response : response.data ?? [];
      return { seed, posts: posts.filter((post) => post.post_id || post.description) };
    }));

    const items: Candidate[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled" || result.value.posts.length === 0) continue;
      const { seed, posts } = result.value;
      const latest = posts
        .map((post) => post.create_time)
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? new Date().toISOString();
      const plays = posts.reduce((sum, post) => sum + Number(post.play_count ?? 0), 0);
      const engagement = posts.reduce((sum, post) => sum + Number(post.share_count ?? 0) + Number(post.comment_count ?? 0), 0);
      const example = posts.find((post) => post.description)?.description?.slice(0, 120) || seed.title;
      items.push({
        id: `tiktok-${slug(seed.title)}`,
        title: seed.title,
        url: `https://www.tiktok.com/search?q=${encodeURIComponent(seed.query)}`,
        source: "tiktok",
        sourceLabel: "TikTok via Bright Data",
        publishedAt: new Date(latest).toISOString(),
        activity: Math.max(1, plays + engagement * 8),
        strength: clamp(34 + Math.log10(plays + engagement * 8 + 1) * 10, 38, 96),
        detail: `${posts.length} matched posts sampled · ${plays.toLocaleString()} plays · “${example}”`,
        geography: "Global",
        platform: {
          key: "tiktok",
          metric: { label: "TikTok matched posts", metric: "posts", scope: "sample", windows: tiktokPostWindows(posts), detail: `Sample of up to ${postsPerQuery} keyword matches via Bright Data` },
        },
      });
    }

    const failed = results.filter((result) => result.status === "rejected").length;
    return { items, status: { key: "tiktok", label: "TikTok", state: items.length ? "live" : failed ? "error" : "live", detail: items.length ? `Sampled keyword discovery across ${items.length} signals` : failed ? "Bright Data queries failed; check token and dataset access" : "No matching posts returned this run", itemCount: items.length } };
  } catch (error) {
    return { items: [], status: { key: "tiktok", label: "TikTok", state: "error", detail: errorMessage(error), itemCount: 0 } };
  }
}

const stopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with", "after", "new", "says", "say", "latest", "watch", "video", "live", "update"]);

function normalize(title: string) {
  return title.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9#]+/g, " ").trim();
}

function tokens(title: string) {
  return normalize(title).split(/\s+/).filter((token) => token.length > 1 && !stopWords.has(token));
}

function isUsefulTitle(title: string) {
  const normalized = normalize(title).replace(/#/g, "");
  if (normalized.length < 3 || !tokens(title).length) return false;
  return !new Set(["home", "news", "breaking", "latest", "update"]).has(normalized);
}

function shortTrendTitle(input: string) {
  let title = input
    .replace(/\s+/g, " ")
    .replace(/^[“”'"‘’]+|[“”'"‘’]+$/g, "")
    .replace(/^(breaking|exclusive|watch|video|analysis|explained|who is|what is)\s*[:?—-]*\s*/i, "")
    .trim();
  const ugliestDog = title.match(/^Meet\s+([^,]+),.*World'?s Ugliest Dog/i);
  if (ugliestDog) return `${ugliestDog[1]}, Ugliest Dog Winner`;
  const foodBear = title.match(/\b(bear|polar bear|black bear|brown bear)\b.*\bbroke into\b.*\b(KFC|pizza|tacos?|food)\b/i);
  if (foodBear) return `${foodBear[2].toUpperCase()}-Stealing ${foodBear[1].replace(/\b\w/g, (letter) => letter.toUpperCase())}`;
  const bearAttack = title.match(/\bmauled by (?:a |an )?((?:black|brown|polar|grizzly) bear)\b/i);
  if (bearAttack) return `${bearAttack[1].replace(/\b\w/g, (letter) => letter.toUpperCase())} ${/trail/i.test(title) ? "Trail " : ""}Attack`;
  const zooAnimals = title.match(/\b(?:at )?(?:a )?([A-Z][\w'-]+) zoo\b.*\banimals?\b/i);
  if (zooAnimals) return `${zooAnimals[1]} Zoo Animals`;
  const firstSentence = title.split(/(?<=[.!?])\s+/)[0];
  if (firstSentence.split(/\s+/).length >= 2) title = firstSentence;
  const segments = title.split(/\s+(?:—|–|\|)\s+|:\s+/).map((part) => part.trim()).filter(Boolean);
  if (segments[0] && segments[0].split(/\s+/).length >= 2) title = segments[0];
  title = title
    .replace(/^meet\s+/i, "")
    .replace(/\b(?:confirmed|explained|what we know|everything to know|see (?:it|them) in action)\b.*$/i, "")
    .replace(/[.!?;,]+$/g, "")
    .trim();
  let words = title.split(/\s+/).filter(Boolean);
  if (words.length > 8) words = words.slice(0, 8);
  while (words.join(" ").length > 58 && words.length > 2) words.pop();
  const weakEndings = new Set(["a", "an", "and", "at", "by", "for", "her", "his", "of", "the", "than", "to", "while", "with"]);
  while (words.length > 2 && weakEndings.has(normalize(words.at(-1) ?? ""))) words.pop();
  return words.join(" ").replace(/[,:;.!?]+$/g, "") || input.trim().slice(0, 58);
}

function slug(title: string) {
  return normalize(title).replace(/#/g, "").replace(/\s+/g, "-").slice(0, 72) || "signal";
}

function similar(left: string, right: string) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return false;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const shorter = Math.min(a.size, b.size);
  const union = new Set([...a, ...b]).size;
  return (shorter <= 3 && intersection === shorter) || intersection / union >= 0.42;
}

function categoryFor(title: string, hasPublisherContext = false): [string, string] {
  const text = normalize(title);
  const wordSet = new Set(text.split(/\s+/));
  const match = (values: string[]) => values.some((value) => value.includes(" ") ? text.includes(value) : wordSet.has(value));
  if (match(["cat", "cats", "kitten", "kittens", "feline", "tabby"])) return ["Animals", "Cats"];
  if (match(["dog", "dogs", "puppy", "puppies", "canine", "pup"])) return ["Animals", "Dogs"];
  if (match(["bear", "bears", "polar bear", "panda", "grizzly"])) return ["Animals", "Bears"];
  if (match(["bird", "birds", "crow", "eagle", "owl", "parrot", "penguin", "duck", "goose", "falcon"])) return ["Animals", "Birds"];
  if (match(["whale", "shark", "dolphin", "octopus", "ocean", "seal", "orca", "sea turtle", "manatee", "aquarium"])) return ["Animals", "Marine"];
  if (match(["animal", "animals", "wildlife", "zoo", "pet", "pets", "veterinarian", "animal rescue", "shelter", "capybara", "elephant", "lion", "tiger", "fox", "wolf", "monkey", "gorilla", "otter", "rabbit", "deer", "horse", "cow"])) return ["Animals", "Wildlife"];
  if (match(["football", "soccer", "goalkeeper", "quarterback", "nfl", "mls", "wolverines", "premier league", "champions league"])) return ["Sports", "Football"];
  if (match(["cricket", "ipl", "wicket"])) return ["Sports", "Cricket"];
  if (match(["basketball", "nba", "wnba", "ncaa", "lakers", "celtics", "warriors", "knicks", "bulls", "nets"])) return ["Sports", "Basketball"];
  if (match(["baseball", "mlb", "red sox", "yankees", "dodgers", "pitcher", "home run", "hockey", "nhl", "tennis", "golf", "ufc", "boxing", "nascar", "formula 1", "f1"])) return ["Sports", "Other"];
  if (match(["recipe", "restaurant", "chef", "food", "coffee", "cake", "pizza", "drink"])) return ["Food & drink", match(["recipe", "cake"]) ? "Recipes" : match(["restaurant", "chef"]) ? "Restaurants" : "Food loops"];
  if (match(["movie", "film", "trailer", "series", "episode", "finale", "netflix", "hbo"])) return ["Entertainment", "Film & TV"];
  if (match(["song", "album", "music", "singer", "concert"])) return ["Entertainment", "Music"];
  if (match(["creator", "influencer", "streamer", "youtuber", "tiktoker"])) return ["Entertainment", "Creators"];
  if (match(["challenge"])) return ["Viral events", "Challenges"];
  if (match(["reaction", "reacts", "response"])) return ["Viral events", "Reactions"];
  if (match(["format", "template", "trend format", "dance trend"])) return ["Viral events", "Formats"];
  if (match(["meme", "joke", "shitpost", "copypasta"])) return ["Internet culture", "Memes"];
  if (match(["slang", "phrase", "word", "saying"])) return ["Internet culture", "Language"];
  if (match(["creator lore", "fandom", "stan", "internet drama"])) return ["Internet culture", "Creator lore"];
  if (match(["cybersecurity", "cyberattack", "hack", "hacker", "malware", "spyware", "ransomware", "data breach"])) return ["Technology", "Cybersecurity"];
  if (match(["space", "nasa", "spacex", "rocket", "starship", "moon", "mars", "satellite", "spacecraft"])) return ["Technology", "Space"];
  if (match(["startup", "founder", "venture capital", "funding round", "seed round"])) return ["Technology", "Startups"];
  if (match(["ai", "artificial intelligence", "openai", "chatgpt", "robot", "robotics", "claude", "anthropic", "gemini", "qwen", "llm", "model"])) return ["Technology", "AI"];
  if (match(["tech", "technology", "software", "app", "iphone", "ipad", "airpods", "android", "apple", "google", "microsoft", "meta", "computer", "chip", "nvidia", "firefox", "cloudflare", "gadget"])) return ["Technology", "Consumer tech"];
  if (match(["science", "research", "study", "climate", "medicine", "health"])) return ["News", "Science"];
  if (match(["market", "company", "business", "stock", "bank", "economy"])) return ["News", "Business"];
  if (match(["war", "government", "president", "trump", "biden", "republican", "democrat", "election", "congress", "senate", "governor", "white house", "supreme court", "attorney general", "military", "commander", "troops", "court"])) return ["News", "World"];
  if (match(["culture", "art", "book", "museum", "festival", "fashion"])) return ["News", "Culture"];
  if (match(["viral", "moment", "caught on camera", "unexpected"])) return ["Viral events", "Moments"];
  if (hasPublisherContext) return ["News", "Culture"];
  return ["Viral events", "Moments"];
}

function toneFor(category: string) {
  return ({ Animals: "ice", Technology: "blue", News: "amber", "Viral events": "violet", "Internet culture": "blue", Entertainment: "rose", Sports: "green", "Food & drink": "orange" } as Record<string, string>)[category] || "sand";
}

function ageLabel(date: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Source unavailable";
  return message.length > 110 ? `${message.slice(0, 107)}…` : message;
}

function buildTrend(cluster: Candidate[]): Trend {
  const leader = [...cluster].sort((a, b) => b.strength - a.strength)[0];
  const classificationText = cluster.map((item) => `${item.title} ${item.relatedNews?.title ?? ""}`).join(" ");
  const [category, subcategory] = categoryFor(classificationText, cluster.some((item) => item.source === "news" || Boolean(item.relatedNews)));
  const firstDate = cluster.reduce((earliest, item) => new Date(item.publishedAt).getTime() < new Date(earliest).getTime() ? item.publishedAt : earliest, leader.publishedAt);
  const ageMinutes = Math.max(1, (Date.now() - new Date(firstDate).getTime()) / 60_000);
  const activity = Math.round(cluster.reduce((sum, item) => sum + item.activity, 0));
  const diversity = new Set(cluster.map((item) => item.source)).size;
  const usObservationCount = cluster.filter((item) => item.geography === "US").length;
  const marketAdjustment = usObservationCount > 0 ? Math.min(10, 6 + usObservationCount * 2) : -10;
  const baseScore = clamp(Math.round(leader.strength * 0.72 + Math.min(18, diversity * 5) + Math.min(10, cluster.length * 1.5) + marketAdjustment), 18, 99);
  const saturation = clamp(Math.round(ageMinutes / 30 + cluster.length * 4 + Math.max(0, baseScore - 75)), 6, 96);
  let phase: Phase = ageMinutes < 150 && saturation < 42 ? "Igniting" : ageMinutes < 720 && saturation < 68 ? "Accelerating" : saturation > 82 || ageMinutes > 1440 ? "Cooling" : "Peaking";
  if (baseScore < 45 && ageMinutes > 480) phase = "Cooling";
  const forecastTime = phase === "Igniting" ? "30–90 min" : phase === "Accelerating" ? "1–3 hours" : phase === "Peaking" ? "30–120 min" : "Now";
  const forecast = phase === "Igniting"
    ? "The breakout window is opening. A second independent source would materially increase the odds of a wider run."
    : phase === "Accelerating"
      ? "Attention is broadening. Watch for publisher pickup or a creator remix wave before the next check."
      : phase === "Peaking"
        ? "The first attention peak is close. A verified update or reusable format is the clearest path to a second wave."
        : "The signal is losing freshness. Residual reposts are more likely than a new creator wave.";
  const weights = new Map<string, number>();
  for (const item of cluster) weights.set(item.source, (weights.get(item.source) ?? 0) + item.strength);
  const weightTotal = [...weights.values()].reduce((sum, value) => sum + value, 0) || 1;
  const sources = Object.fromEntries([...weights.entries()].map(([key, value]) => [key, Math.max(1, Math.round(value / weightTotal * 100))]));
  const platforms: Record<string, PlatformMetric> = {};
  for (const item of cluster) {
    if (!item.platform) continue;
    const existing = platforms[item.platform.key];
    platforms[item.platform.key] = existing
      ? {
          ...existing,
          windows: Object.fromEntries(Object.keys(existing.windows).map((key) => [key, existing.windows[key as keyof WindowValues] + item.platform!.metric.windows[key as keyof WindowValues]])) as WindowValues,
        }
      : item.platform.metric;
  }
  const displayTitle = shortTrendTitle(leader.title);
  const keywords = tokens(displayTitle).slice(0, 5);
  const mark = keywords.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "FR";
  const score = windows(baseScore) as WindowValues;

  return {
    id: slug(leader.title),
    title: displayTitle,
    url: leader.url,
    category,
    subcategory,
    mark,
    phase,
    score,
    growth: windows(0) as WindowValues,
    mentions: windows(activity) as WindowValues,
    spark: Array.from({ length: 12 }, (_, index) => clamp(Math.round(baseScore * (0.46 + index * 0.045) - Math.max(0, saturation - 75) * index * 0.08), 8, 99)),
    sources,
    platforms,
    firstSeen: ageLabel(firstDate),
    geography: [...new Set(cluster.map((item) => item.geography))].slice(0, 3).join(" · "),
    forecast,
    forecastTime,
    confidence: clamp(52 + diversity * 9 + Math.min(12, cluster.length * 2), 55, 91),
    summary: `${leader.title.replace(/[.!?]+$/, "")}. ${platforms.x ? `X recorded ${platforms.x.windows["24h"].toLocaleString()} original posts in the last 24 hours` : `Front Run found ${cluster.length} recent observation${cluster.length === 1 ? "" : "s"}`} across ${diversity} measured ${diversity === 1 ? "source" : "sources"}.`,
    signals: [
      `${cluster.length} independent observations in this cluster`,
      `${diversity} measured source ${diversity === 1 ? "surface" : "surfaces"}`,
      saturation < 35 ? "Low current saturation" : saturation > 75 ? "Attention is becoming saturated" : "Audience breadth is still expanding",
    ],
    tags: keywords.map((keyword) => `#${keyword}`),
    saturation,
    tone: toneFor(category),
    activity,
    historyPoints: 0,
    evidence: [...new Map(cluster.flatMap((item) => [
      { source: item.sourceLabel, title: item.title, url: item.url, detail: item.detail },
      ...(item.extraEvidence ?? []),
    ]).map((item) => [item.url, item])).values()].slice(0, 10),
  };
}

function clusterCandidates(items: Candidate[]) {
  const clusters: Candidate[][] = [];
  for (const item of [...items].sort((a, b) => b.strength - a.strength)) {
    const existing = clusters.find((cluster) => cluster.some((candidate) => similar(candidate.title, item.title)));
    if (existing) existing.push(item);
    else clusters.push([item]);
  }
  const ranked = clusters.map(buildTrend).sort((a, b) => b.score["30m"] - a.score["30m"]);
  const reserved = [
    ...ranked.filter((trend) => trend.category === "Animals").slice(0, 8),
    ...ranked.filter((trend) => trend.category === "Technology").slice(0, 8),
  ];
  const selected = new Map(reserved.map((trend) => [trend.id, trend]));
  for (const trend of ranked) {
    if (selected.size >= 40) break;
    selected.set(trend.id, trend);
  }
  return [...selected.values()].sort((a, b) => b.score["30m"] - a.score["30m"]);
}

type ModelAnalysis = { id: string; title: string; category: string; subcategory: string; summary: string; forecast: string; forecastTime: string; signals: string[] };

async function enrichWithOpenAI(trends: Trend[]): Promise<{ trends: Trend[]; mode: "openai" | "heuristic"; status: SourceStatus }> {
  if (!runtime.OPENAI_API_KEY) {
    return { trends, mode: "heuristic", status: { key: "analysis", label: "AI forecast", state: "needs-key", detail: "Add OPENAI_API_KEY for model-written classification and forecasts", itemCount: 0 } };
  }
  try {
    const batch = trends.slice(0, 14).map((trend) => ({ id: trend.id, title: trend.title, category: trend.category, phase: trend.phase, score: trend.score["30m"], activity: trend.activity, sources: trend.sources, saturation: trend.saturation, evidence: trend.evidence.slice(0, 6).map((item) => `${item.source}: ${item.title} — ${item.detail}`) }));
    const categoryNames = TREND_TAXONOMY.map((category) => category.name);
    const subcategoryNames = TREND_TAXONOMY.flatMap((category) => [...category.subcategories]);
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        analyses: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" }, title: { type: "string", maxLength: 58 }, category: { type: "string", enum: categoryNames }, subcategory: { type: "string", enum: subcategoryNames }, summary: { type: "string", maxLength: 320 }, forecast: { type: "string", maxLength: 220 }, forecastTime: { type: "string" }, signals: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
            },
            required: ["id", "title", "category", "subcategory", "summary", "forecast", "forecastTime", "signals"],
          },
        },
      },
      required: ["analyses"],
    };
    const requestModel = () => fetchJson<{ output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }>("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: runtime.OPENAI_MODEL || "gpt-5.6-luna",
        reasoning: { effort: "none" },
        max_output_tokens: 5_000,
        input: [
          { role: "system", content: "You are Front Run's trend editor. For every signal: write a clear 2–7 word headline-style trend name (maximum 58 characters) centered on the named animal, person, product, event or memorable hook—not the full publisher headline. Write a factual one- or two-sentence summary of what happened and why attention is moving. Then classify and forecast the next likely attention event. Never invent facts, counts, sources, quotes, links, or identities; only use supplied evidence. Treat activity values from different sources as non-comparable observations." },
          { role: "user", content: JSON.stringify(batch) },
        ],
        text: { format: { type: "json_schema", name: "front_run_analysis", strict: true, schema } },
      }),
    }, 28_000);
    let response;
    try {
      response = await requestModel();
    } catch (error) {
      if (!errorMessage(error).startsWith("429")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      response = await requestModel();
    }
    const outputText = response.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
    if (!outputText) throw new Error("Model returned no structured output");
    const parsed = JSON.parse(outputText) as { analyses: ModelAnalysis[] };
    const analyses = new Map(parsed.analyses.map((analysis) => [analysis.id, analysis]));
    const enriched = trends.map((trend) => {
      const analysis = analyses.get(trend.id);
      if (!analysis) return trend;
      const taxonomyEntry = TREND_TAXONOMY.find((category) => category.name === analysis.category);
      const validClassification = taxonomyEntry?.subcategories.some((subcategory) => subcategory === analysis.subcategory);
      const category = validClassification ? analysis.category : trend.category;
      const subcategory = validClassification ? analysis.subcategory : trend.subcategory;
      return { ...trend, title: shortTrendTitle(analysis.title), category, subcategory, summary: analysis.summary.trim(), forecast: analysis.forecast.trim(), forecastTime: analysis.forecastTime, signals: analysis.signals, tone: toneFor(category) };
    });
    return { trends: enriched, mode: "openai", status: { key: "analysis", label: "AI forecast", state: "live", detail: `${runtime.OPENAI_MODEL || "gpt-5.6-luna"} short names, summaries and structured forecasts`, itemCount: Math.min(14, trends.length) } };
  } catch (error) {
    return { trends, mode: "heuristic", status: { key: "analysis", label: "AI forecast", state: "error", detail: `Heuristic fallback · ${errorMessage(error)}`, itemCount: 0 } };
  }
}

export async function buildTrendsPayload(history: Map<string, HistoricalSnapshot[]> = new Map()): Promise<TrendsPayload> {
  const publicCollectors = await Promise.all([collectGoogleTrends(), collectGoogleNews(), collectHackerNews(), collectYouTube()]);
  const x = await collectX(publicCollectors.flatMap((collector) => collector.items));
  const coreCollectors = [...publicCollectors, x];
  const tiktok = await collectTikTok(coreCollectors.flatMap((collector) => collector.items));
  const collectors = [...coreCollectors, tiktok];
  const allItems = collectors.flatMap((collector) => collector.items);
  const clustered = clusterCandidates(allItems);
  const model = await enrichWithOpenAI(clustered);
  const now = Date.now();
  const trends = model.trends.map((trend) => applyHistory(trend, history.get(trend.id) ?? [], now)).sort((a, b) => b.score["30m"] - a.score["30m"]);
  const categories = TREND_TAXONOMY.map((category) => ({
    name: category.name,
    count: trends.filter((trend) => trend.category === category.name).length,
    subcategories: category.subcategories.map((subcategory) => ({
      name: subcategory,
      count: trends.filter((trend) => trend.category === category.name && trend.subcategory === subcategory).length,
    })),
  }));
  const newsCollector = collectors.find((collector) => collector.status.key === "news");
  const googleCandidates = collectors.find((collector) => collector.status.key === "google")?.items ?? [];
  const embeddedNews: NewsItem[] = googleCandidates
    .filter((item) => item.relatedNews)
    .slice(0, 8)
    .map((item) => ({
      title: item.relatedNews!.title,
      source: item.relatedNews!.source,
      age: ageLabel(item.publishedAt).replace(" ago", ""),
      url: item.relatedNews!.url,
      trendId: trends.find((trend) => similar(trend.title, item.title))?.id,
    }));
  const news: NewsItem[] = newsCollector?.items.length
    ? newsCollector.items.slice(0, 8).map((item) => ({ title: item.title, source: item.sourceLabel, age: ageLabel(item.publishedAt).replace(" ago", ""), url: item.url, trendId: trends.find((trend) => similar(trend.title, item.title))?.id }))
    : embeddedNews;
  const sourceStatuses = collectors.map((collector) => {
    if (collector.status.key === "news" && collector.status.state === "error" && embeddedNews.length) {
      return { key: "news", label: "Trend-linked news", state: "live", detail: `Google News unavailable; using ${embeddedNews.length} publisher stories embedded in Google Trends`, itemCount: embeddedNews.length } as SourceStatus;
    }
    return collector.status;
  });
  const refreshedAt = new Date(now).toISOString();
  return {
    product: "Front Run",
    refreshedAt,
    nextRefreshAt: new Date(now + 5 * 60_000).toISOString(),
    analysisMode: model.mode,
    historyDepth: Math.max(0, ...trends.map((trend) => trend.historyPoints)),
    trends,
    categories,
    news,
    sources: [...sourceStatuses, model.status],
  };
}
