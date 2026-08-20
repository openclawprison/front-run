import type { HistoricalSnapshot, TwitterApiMonthlyUsage } from "./trend-store";
import { applyHistory } from "./trend-store";
import { TREND_TAXONOMY } from "./trend-types";
import type { NewsItem, Phase, PlatformMetric, PumpCoin, PumpCoinBucket, SourceStatus, Trend, TrendEvidence, TrendsPayload, WindowValues } from "./trend-types";

type RuntimeEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  TWITTERAPI_IO_KEY?: string;
  TWITTERAPI_MONTHLY_BUDGET_USD?: string;
  TWITTERAPI_SAMPLE_INTERVAL_MINUTES?: string;
  TWITTERAPI_QUERY_LIMIT?: string;
  TWITTERAPI_CACHE_HOURS?: string;
  YOUTUBE_API_KEY?: string;
  YOUTUBE_REGIONS?: string;
  BRIGHTDATA_API_TOKEN?: string;
  TIKTOK_QUERY_LIMIT?: string;
  TIKTOK_POSTS_PER_QUERY?: string;
  TIKTOK_SEED_QUERIES?: string;
  PUMPFUN_LIMIT?: string;
  PUMPFUN_ENRICH_LIMIT?: string;
};

export type BuildTrendsOptions = {
  previousPayload?: TrendsPayload | null;
  twitterApiUsage?: TwitterApiMonthlyUsage;
  recordTwitterApiUsage?: (billablePosts: number, queryCount: number) => Promise<void>;
};

type SourceKey = "google" | "news" | "publisher" | "kym" | "hackernews" | "x" | "youtube" | "tiktok";

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
  categoryHint?: { category: string; subcategory: string };
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
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
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

function feedEntries(xml: string) {
  const items = rssItems(xml);
  return items.length ? items : xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
}

function feedLink(entry: string) {
  const elementText = tag(entry, "link");
  if (elementText) return elementText;
  const href = entry.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
  return decodeXml(href);
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
        if (!isUsefulTitle(title) || !isAnimalCandidate(`${title} ${tag(entry, "ht:news_item_title")}`) || seen.has(key)) return;
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
          strength: clamp(30 + Math.log10(activity + 1) * 7 - index * 0.35, 24, 62),
          detail: `${tag(entry, "ht:approx_traffic") || activity.toLocaleString()} searches · ${geo}`,
          geography: geo,
          categoryHint: { category: "Animals", subcategory: animalSubcategoryFor(`${title} ${relatedTitle}`) },
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
      { label: "Viral animals now", query: "(animal OR pet OR wildlife OR zoo) (viral OR trending OR \"social media\" OR TikTok OR Instagram OR video) when:1d", limit: 40, strength: 72 },
      { label: "Animal breaking news", query: "(animal OR wildlife OR zoo OR pet) (breaking OR latest OR today OR rescue OR escaped) when:1d", limit: 40, strength: 68 },
      { label: "Viral pets", query: "(cat OR kitten OR dog OR puppy OR pet) (viral OR famous OR video OR internet OR rescued OR adopted) when:2d", limit: 40, strength: 69 },
      { label: "Zoo babies", query: "(zoo OR aquarium) (baby OR newborn OR born OR birth OR cub OR calf OR chick OR hatch) when:7d", limit: 40, strength: 70 },
      { label: "Zoo arrivals", query: "(zoo OR aquarium) (arrival OR arrives OR rescue OR escaped OR debut OR named) when:7d", limit: 32, strength: 67 },
      { label: "Major US zoos", query: "(\"San Diego Zoo\" OR \"Bronx Zoo\" OR \"Smithsonian National Zoo\" OR \"Cincinnati Zoo\" OR \"Houston Zoo\" OR \"Columbus Zoo\") when:7d", limit: 36, strength: 69 },
      { label: "More US zoos", query: "(\"Oregon Zoo\" OR \"Woodland Park Zoo\" OR \"Lincoln Park Zoo\" OR \"Phoenix Zoo\" OR \"Zoo Atlanta\" OR \"Denver Zoo\") when:7d", limit: 36, strength: 68 },
      { label: "Aquarium watch", query: "(\"Monterey Bay Aquarium\" OR \"Georgia Aquarium\" OR \"Shedd Aquarium\" OR \"New England Aquarium\") when:7d", limit: 32, strength: 68 },
      { label: "Moo Deng watch", query: "(\"Moo Deng\" OR \"Khao Kheow Open Zoo\" OR \"pygmy hippo\" OR \"baby hippo\") when:14d", limit: 24, strength: 70 },
      { label: "Animal rescues", query: "(animal OR wildlife OR cat OR dog OR horse) (rescued OR rescue OR rehabilitation OR released OR adopted) when:2d", limit: 36, strength: 67 },
      { label: "Cats", query: "(cat OR kitten OR feline) (viral OR rescue OR video OR unusual OR record) when:2d", limit: 30, strength: 66 },
      { label: "Dogs", query: "(dog OR puppy OR canine) (viral OR rescue OR video OR unusual OR record) when:2d", limit: 30, strength: 66 },
      { label: "Bears", query: "(bear OR panda OR polar bear OR grizzly) (wildlife OR zoo OR rescue OR video) when:3d", limit: 30, strength: 66 },
      { label: "Birds", query: "(bird OR penguin OR owl OR eagle OR parrot OR flamingo) (wildlife OR zoo OR rescue OR viral) when:2d", limit: 30, strength: 65 },
      { label: "Marine life", query: "(whale OR dolphin OR orca OR shark OR seal OR otter OR sea turtle) when:2d", limit: 34, strength: 66 },
      { label: "Primates", query: "(gorilla OR chimpanzee OR orangutan OR monkey OR lemur) (zoo OR wildlife OR rescue OR viral) when:3d", limit: 28, strength: 65 },
      { label: "Reptiles", query: "(snake OR alligator OR crocodile OR turtle OR lizard OR reptile) (wildlife OR zoo OR rescue OR viral) when:3d", limit: 28, strength: 64 },
      { label: "Endangered species", query: "(endangered OR threatened OR conservation) (animal OR species OR wildlife) when:3d", limit: 32, strength: 67 },
      { label: "Farm animals", query: "(horse OR cow OR goat OR pig OR sheep OR donkey) (animal OR rescue OR viral OR unusual) when:2d", limit: 28, strength: 63 },
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
        if (!isUsefulTitle(title) || !isAnimalCandidate(title) || seen.has(key)) return;
        const outlet = split > 0 ? rawTitle.slice(split + 3) : "Publisher";
        if (/^(facebook\.com|instagram|youtube|tiktok)$/i.test(outlet.trim())) return;
        const publishedAt = new Date(tag(entry, "pubDate") || Date.now());
        const ageHours = Math.max(0, (Date.now() - publishedAt.getTime()) / 3_600_000);
        const maxAgeHours = /Zoo|Aquarium|Moo Deng/.test(feed.label) ? 7 * 24 : 3 * 24;
        if (!Number.isFinite(publishedAt.getTime()) || ageHours > maxAgeHours) return;
        seen.add(key);
        items.push({
          id: `news-${slug(title)}`,
          title,
          url: tag(entry, "link") || "https://news.google.com/",
          source: "news",
          sourceLabel: outlet,
          publishedAt: publishedAt.toISOString(),
          activity: 1,
          strength: clamp(feed.strength - index * 0.55, 36, feed.strength),
          detail: `${outlet} · ${feed.label}`,
          geography: "US",
          categoryHint: { category: "Animals", subcategory: animalSubcategoryFor(title) },
        });
      });
    });
    return { items, status: { key: "news", label: "Animal news search", state: "live", detail: `${feeds.length} live US-focused animal, zoo, rescue and species discovery feeds`, itemCount: items.length } };
  } catch (error) {
    return { items: [], status: { key: "news", label: "Google News", state: "error", detail: errorMessage(error), itemCount: 0 } };
  }
}

function htmlAttribute(fragment: string, name: string) {
  const match = fragment.match(new RegExp(`${name}=(['"])([\\s\\S]*?)\\1`, "i"));
  return match ? decodeXml(match[2]) : "";
}

function publicKymUrl(value: string) {
  try {
    const url = new URL(value, "https://knowyourmeme.com");
    if (url.hostname === "origin.knowyourmeme.com") url.hostname = "knowyourmeme.com";
    return url.toString();
  } catch {
    return "https://knowyourmeme.com/";
  }
}

function kymDate(value: string, fallback: number) {
  const timestamp = new Date(value.replace(/(\d)(st|nd|rd|th)\b/gi, "$1")).getTime();
  return new Date(Number.isFinite(timestamp) ? timestamp : fallback).toISOString();
}

function memeXSearchEvidence(title: string): TrendEvidence {
  return {
    source: "X search",
    title: `Search X for “${shortTrendTitle(title)}”`,
    url: `https://x.com/search?q=${encodeURIComponent(`"${shortTrendTitle(title)}" lang:en`)}`,
    detail: "Direct X discovery link · sampled leading posts appear when the cost-controlled X check runs",
  };
}

function kymNewEntries(html: string, observedAt: number): Candidate[] {
  const items: Candidate[] = [];
  const anchors = html.matchAll(/<a\s+class=["']item["']([\s\S]*?)>/gi);
  for (const match of anchors) {
    const title = htmlAttribute(match[1], "data-title");
    const href = htmlAttribute(match[1], "href");
    if (!isUsefulTitle(title) || !/^\/memes\/[a-z0-9]/i.test(href) || isPromotionalMemeEntry(title)) continue;
    const rank = items.length + 1;
    items.push({
      id: `kym-new-${slug(title)}`,
      title,
      url: publicKymUrl(href),
      source: "kym",
      sourceLabel: "Know Your Meme · New entry",
      publishedAt: new Date(observedAt - (rank - 1) * 5 * 60_000).toISOString(),
      activity: Math.max(1, 22 - rank),
      strength: clamp(78 - (rank - 1) * 1.25, 56, 78),
      detail: `Fresh encyclopedia entry · newest rank #${rank} at detection`,
      geography: "US internet culture",
      categoryHint: { category: "Memes", subcategory: "New entries" },
      extraEvidence: [memeXSearchEvidence(title)],
    });
    if (items.length >= 18) break;
  }
  return items;
}

function kymReaderNewEntries(markdown: string, observedAt: number): Candidate[] {
  const items: Candidate[] = [];
  const entries = markdown.matchAll(/### \[([^\n[]+?)\s+!\[[\s\S]*?\]\((https?:\/\/(?:www\.)?knowyourmeme\.com\/memes\/[a-z0-9][^)\s"]*)\)/gi);
  for (const match of entries) {
    const title = decodeXml(match[1]).replace(/\s+/g, " ").trim();
    if (!isUsefulTitle(title) || isPromotionalMemeEntry(title)) continue;
    const rank = items.length + 1;
    items.push({
      id: `kym-new-${slug(title)}`,
      title,
      url: publicKymUrl(match[2]),
      source: "kym",
      sourceLabel: "Know Your Meme · New entry",
      publishedAt: new Date(observedAt - (rank - 1) * 5 * 60_000).toISOString(),
      activity: Math.max(1, 22 - rank),
      strength: clamp(78 - (rank - 1) * 1.25, 56, 78),
      detail: `Fresh encyclopedia entry · newest rank #${rank} at detection`,
      geography: "US internet culture",
      categoryHint: { category: "Memes", subcategory: "New entries" },
      extraEvidence: [memeXSearchEvidence(title)],
    });
    if (items.length >= 18) break;
  }
  return items;
}

function kymEditorials(html: string, subcategory: "Trending" | "New entries" | "Resurgences", observedAt: number, limit: number): Candidate[] {
  const items: Candidate[] = [];
  const articles = html.matchAll(/<article\s+data-title=(['"])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/article>/gi);
  for (const match of articles) {
    const title = decodeXml(match[2]);
    const body = match[3];
    const linkMatch = body.match(/<a\s+[^>]*class=["'][^"']*newsfeed-title[^"']*["'][^>]*>/i)?.[0] ?? "";
    const href = htmlAttribute(linkMatch, "href");
    if (!isUsefulTitle(title) || !href) continue;
    const rank = items.length + 1;
    const labelBlock = body.match(/<a\s+[^>]*class=["'][^"']*newsfeed-stamp[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? subcategory;
    const label = decodeXml(labelBlock) || subcategory;
    const dateText = decodeXml(body.match(/<small[^>]*text-muted[^>]*>[\s\S]*?<em>([\s\S]*?)<\/em>/i)?.[1] ?? "");
    const summary = decodeXml(body.match(/<div>\s*<p>([\s\S]*?)<\/p>\s*<\/div>/i)?.[1] ?? "");
    items.push({
      id: `kym-${slug(subcategory)}-${slug(title)}`,
      title,
      url: publicKymUrl(href),
      source: "kym",
      sourceLabel: `Know Your Meme · ${subcategory}`,
      publishedAt: kymDate(dateText, observedAt - (rank - 1) * 15 * 60_000),
      activity: Math.max(1, 18 - rank),
      strength: clamp((subcategory === "Trending" ? 84 : 77) - (rank - 1) * 1.3, 58, 84),
      detail: `${label} · KYM ${subcategory.toLowerCase()} surface${summary ? ` · ${summary.slice(0, 120)}` : ""}`,
      geography: "US internet culture",
      categoryHint: { category: "Memes", subcategory },
      extraEvidence: [memeXSearchEvidence(title)],
    });
    if (items.length >= limit) break;
  }
  return items;
}

function kymReaderEditorials(markdown: string, subcategory: "Trending" | "New entries" | "Resurgences", observedAt: number, limit: number): Candidate[] {
  const items: Candidate[] = [];
  const articles = markdown.matchAll(/#### \[([^\]\n]+)\]\((https?:\/\/[^)\s"]+)(?:\s+"[^"]*")?\)\s*\r?\n+\s*_([^_\n]+)_\s*\r?\n+([\s\S]*?)(?=\r?\n\* \* \*|\r?\n#### |\r?\n## |$)/gi);
  for (const match of articles) {
    const title = decodeXml(match[1]).replace(/\s+/g, " ").trim();
    if (!isUsefulTitle(title)) continue;
    const rank = items.length + 1;
    const summary = decodeXml(match[4]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_#]/g, " ")
      .replace(/\s+/g, " ")
      .trim());
    items.push({
      id: `kym-${slug(subcategory)}-${slug(title)}`,
      title,
      url: publicKymUrl(match[2]),
      source: "kym",
      sourceLabel: `Know Your Meme · ${subcategory}`,
      publishedAt: kymDate(match[3], observedAt - (rank - 1) * 15 * 60_000),
      activity: Math.max(1, 18 - rank),
      strength: clamp((subcategory === "Trending" ? 84 : 77) - (rank - 1) * 1.3, 58, 84),
      detail: `KYM ${subcategory.toLowerCase()} surface${summary ? ` · ${summary.slice(0, 120)}` : ""}`,
      geography: "US internet culture",
      categoryHint: { category: "Memes", subcategory },
      extraEvidence: [memeXSearchEvidence(title)],
    });
    if (items.length >= limit) break;
  }
  return items;
}

// Legacy adapter retained so older stored payload fixtures remain parse-compatible; animal-only builds never invoke it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function collectKnowYourMeme(): Promise<CollectorResult> {
  const observedAt = Date.now();
  const surfaces = [
    { urls: ["https://knowyourmeme.com/categories/meme?sort=newest&status=all", "https://origin.knowyourmeme.com/categories/meme?sort=newest&status=all"], readerUrl: "https://r.jina.ai/http://knowyourmeme.com/categories/meme?sort=newest&status=all", kind: "entries" as const },
    { urls: ["https://trending.knowyourmeme.com/newsfeed/trending", "https://origin.knowyourmeme.com/newsfeed/trending"], readerUrl: "https://r.jina.ai/http://trending.knowyourmeme.com/newsfeed/trending", kind: "editorial" as const, subcategory: "Trending" as const, limit: 8 },
    { urls: ["https://trending.knowyourmeme.com/newsfeed/updated", "https://origin.knowyourmeme.com/newsfeed/updated"], readerUrl: "https://r.jina.ai/http://trending.knowyourmeme.com/newsfeed/updated", kind: "editorial" as const, subcategory: "Resurgences" as const, limit: 6 },
    { urls: ["https://trending.knowyourmeme.com/newsfeed/researching", "https://origin.knowyourmeme.com/newsfeed/researching"], readerUrl: "https://r.jina.ai/http://trending.knowyourmeme.com/newsfeed/researching", kind: "editorial" as const, subcategory: "New entries" as const, limit: 6 },
  ];
  const fetchSurface = async (surface: (typeof surfaces)[number]) => {
    let lastError: unknown;
    for (const url of surface.urls) {
      try {
        return { content: await fetchText(url, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; FrontRun/1.0; +https://front-run.onrender.com/)" } }, 10_000), viaReader: false };
      } catch (error) {
        lastError = error;
      }
    }
    try {
      return { content: await fetchText(surface.readerUrl, { headers: { Accept: "text/plain", "User-Agent": "FrontRun/1.0" } }, 24_000), viaReader: true };
    } catch (error) {
      throw error ?? lastError ?? new Error("KYM surface unavailable");
    }
  };
  const results = await Promise.allSettled(surfaces.map((surface) => fetchSurface(surface)));
  const seen = new Set<string>();
  const items: Candidate[] = [];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const surface = surfaces[index];
    const candidates = surface.kind === "entries"
      ? result.value.viaReader ? kymReaderNewEntries(result.value.content, observedAt) : kymNewEntries(result.value.content, observedAt)
      : result.value.viaReader ? kymReaderEditorials(result.value.content, surface.subcategory, observedAt, surface.limit) : kymEditorials(result.value.content, surface.subcategory, observedAt, surface.limit);
    for (const candidate of candidates) {
      const key = normalize(candidate.title);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(candidate);
    }
  });
  if (!items.length) {
    try {
      const params = new URLSearchParams({ q: "site:knowyourmeme.com (meme OR trend OR viral) when:7d", hl: "en-US", gl: "US", ceid: "US:en" });
      const xml = await fetchText(`https://news.google.com/rss/search?${params}`);
      rssItems(xml).slice(0, 12).forEach((entry, index) => {
        const rawTitle = tag(entry, "title");
        const title = rawTitle.replace(/\s+-\s+Know Your Meme$/i, "").trim();
        if (!isUsefulTitle(title) || isLowSignalMemeCollection(title) || !/\b(meme|memes|trend|viral|reaction|format|template|redraw)\b/i.test(title)) return;
        items.push({
          id: `kym-fallback-${slug(title)}`,
          title,
          url: tag(entry, "link") || "https://knowyourmeme.com/",
          source: "kym",
          sourceLabel: "Know Your Meme · indexed coverage",
          publishedAt: new Date(tag(entry, "pubDate") || observedAt).toISOString(),
          activity: Math.max(1, 12 - index),
          strength: clamp(69 - index, 54, 69),
          detail: "KYM coverage discovered through Google News fallback",
          geography: "US internet culture",
          categoryHint: { category: "Memes", subcategory: "Trending" },
          extraEvidence: [memeXSearchEvidence(title)],
        });
      });
    } catch {
      // The status below reports the direct-surface failures when both paths are unavailable.
    }
  }
  const newCount = items.filter((item) => item.categoryHint?.subcategory === "New entries").length;
  const trendingCount = items.filter((item) => item.categoryHint?.subcategory === "Trending").length;
  const resurgenceCount = items.filter((item) => item.categoryHint?.subcategory === "Resurgences").length;
  const liveSurfaces = results.filter((result) => result.status === "fulfilled").length;
  const readerSurfaces = results.filter((result) => result.status === "fulfilled" && result.value.viaReader).length;
  return {
    items,
    status: {
      key: "kym",
      label: "Know Your Meme",
      state: items.length ? "live" : "error",
      detail: items.length ? `${newCount} fresh/researching · ${trendingCount} trending · ${resurgenceCount} updated · ${liveSurfaces}/4 surfaces live${readerSurfaces ? ` · ${readerSurfaces} via reader fallback` : ""}` : "KYM direct, reader and indexed surfaces did not respond",
      itemCount: items.length,
    },
  };
}

type HnItem = { id: number; title?: string; url?: string; time?: number; score?: number; descendants?: number; type?: string };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

type TwitterApiPost = {
  id: string;
  url?: string;
  text: string;
  createdAt?: string;
  retweetCount?: number;
  replyCount?: number;
  likeCount?: number;
  quoteCount?: number;
  viewCount?: number;
  author?: { userName?: string; name?: string; followers?: number; isBlueVerified?: boolean };
};
type TwitterApiSearchResponse = { tweets?: TwitterApiPost[]; has_next_page?: boolean; next_cursor?: string };

function twitterApiSampleWindows(posts: TwitterApiPost[], now = Date.now()): WindowValues {
  const durations: Record<keyof WindowValues, number> = { "5m": 5, "30m": 30, "60m": 60, "6h": 360, "24h": 1440 };
  return Object.fromEntries(
    Object.entries(durations).map(([key, minutes]) => [
      key,
      posts.filter((post) => {
        const createdAt = new Date(post.createdAt ?? "").getTime();
        return Number.isFinite(createdAt) && createdAt >= now - minutes * 60_000;
      }).length,
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
  return `${words.join(" ") || normalize(cleaned)} lang:en -filter:retweets`;
}

async function collectPublisherNews(): Promise<CollectorResult> {
  const feeds = [
    { label: "Mongabay", url: "https://news.mongabay.com/feed/", limit: 14, strength: 72 },
    { label: "Catster", url: "https://www.catster.com/feed/", limit: 10, strength: 69 },
    { label: "Dogster", url: "https://www.dogster.com/feed/", limit: 10, strength: 69 },
    { label: "American Kennel Club", url: "https://www.akc.org/feed/", limit: 12, strength: 70 },
    { label: "The Dodo", url: "https://www.thedodo.com/rss.xml", limit: 14, strength: 71 },
    { label: "Smithsonian Science & Nature", url: "https://www.smithsonianmag.com/rss/science-nature/", limit: 12, strength: 71 },
    { label: "Audubon", url: "https://www.audubon.org/rss.xml", limit: 10, strength: 70 },
    { label: "National Wildlife Federation", url: "https://blog.nwf.org/feed/", limit: 10, strength: 68 },
    { label: "World Wildlife Fund", url: "https://www.worldwildlife.org/stories/rss.xml", limit: 10, strength: 70 },
    { label: "Defenders of Wildlife", url: "https://defenders.org/blog/feed", limit: 10, strength: 68 },
    { label: "International Bird Rescue", url: "https://www.birdrescue.org/feed/", limit: 10, strength: 69 },
    { label: "Marine Mammal Center", url: "https://www.marinemammalcenter.org/news/feed", limit: 10, strength: 70 },
    { label: "San Diego Zoo Wildlife Alliance", url: "https://sandiegozoowildlifealliance.org/pressroom/rss.xml", limit: 12, strength: 74 },
    { label: "Cincinnati Zoo", url: "https://cincinnatizoo.org/feed/", limit: 12, strength: 73 },
    { label: "Oregon Zoo", url: "https://www.oregonzoo.org/news/feed", limit: 12, strength: 73 },
    { label: "Point Defiance Zoo", url: "https://www.pdza.org/feed/", limit: 12, strength: 72 },
    { label: "Houston Zoo", url: "https://www.houstonzoo.org/feed/", limit: 12, strength: 72 },
    { label: "Woodland Park Zoo", url: "https://blog.zoo.org/feeds/posts/default?alt=rss", limit: 12, strength: 72 },
    { label: "Zoo Atlanta", url: "https://zooatlanta.org/feed/", limit: 12, strength: 72 },
    { label: "Denver Zoo Conservation Alliance", url: "https://denverzoo.org/feed/", limit: 12, strength: 72 },
    { label: "Lincoln Park Zoo", url: "https://www.lpzoo.org/feed/", limit: 12, strength: 72 },
    { label: "Phoenix Zoo", url: "https://www.phoenixzoo.org/feed/", limit: 12, strength: 72 },
    { label: "Monterey Bay Aquarium", url: "https://www.montereybayaquarium.org/stories/feed", limit: 12, strength: 73 },
    { label: "Georgia Aquarium", url: "https://www.georgiaaquarium.org/feed/", limit: 12, strength: 72 },
    { label: "Shedd Aquarium", url: "https://www.sheddaquarium.org/stories/feed", limit: 12, strength: 72 },
    { label: "New England Aquarium", url: "https://www.neaq.org/feed/", limit: 12, strength: 72 },
    { label: "Smithsonian National Zoo", url: "https://nationalzoo.si.edu/rss.xml", limit: 12, strength: 74 },
    { label: "San Antonio Zoo", url: "https://sazoo.org/feed/", limit: 12, strength: 72 },
    { label: "Memphis Zoo", url: "https://www.memphiszoo.org/feed/", limit: 12, strength: 72 },
    { label: "Maryland Zoo", url: "https://www.marylandzoo.org/feed/", limit: 12, strength: 72 },
    { label: "Indianapolis Zoo", url: "https://www.indianapoliszoo.com/feed/", limit: 12, strength: 72 },
  ];
  const results = await Promise.allSettled(feeds.map((feed) => fetchText(feed.url, { headers: { Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" } }, 15_000)));
  const seen = new Set<string>();
  const items: Candidate[] = [];
  results.forEach((result, feedIndex) => {
    if (result.status !== "fulfilled") return;
    const feed = feeds[feedIndex];
    feedEntries(result.value).slice(0, feed.limit).forEach((entry, index) => {
      const title = tag(entry, "title");
      const key = normalize(title);
      if (!isUsefulTitle(title) || !isAnimalCandidate(`${title} ${feed.label}`) || seen.has(key)) return;
      const publishedText = tag(entry, "pubDate") || tag(entry, "published") || tag(entry, "updated");
      const publishedTime = new Date(publishedText || Date.now()).getTime();
      if (!Number.isFinite(publishedTime)) return;
      const ageHours = Math.max(0, (Date.now() - publishedTime) / 3_600_000);
      if (ageHours > 96) return;
      seen.add(key);
      items.push({
        id: `publisher-${slug(feed.label)}-${slug(title)}`,
        title,
        url: feedLink(entry) || feed.url,
        source: "publisher",
        sourceLabel: feed.label,
        publishedAt: new Date(publishedTime).toISOString(),
        activity: 1,
        strength: clamp(feed.strength - index * 0.55 - Math.min(9, ageHours / 10), 42, feed.strength),
        detail: `${feed.label} · direct publisher feed`,
        geography: "US-led publishers",
        categoryHint: { category: "Animals", subcategory: animalSubcategoryFor(`${title} ${feed.label}`) },
      });
    });
  });
  const failed = results.filter((result) => result.status === "rejected").length;
  return {
    items,
    status: {
      key: "publisher",
      label: "Direct publishers",
      state: items.length ? "live" : "error",
      detail: items.length ? `${feeds.length - failed}/${feeds.length} animal, wildlife, rescue, zoo and aquarium feeds live` : "Direct animal publisher feeds did not respond",
      itemCount: items.length,
    },
  };
}

function twitterApiPostEngagement(post: TwitterApiPost) {
  return Number(post.likeCount ?? 0) + Number(post.retweetCount ?? 0) * 2 + Number(post.quoteCount ?? 0) * 2 + Number(post.replyCount ?? 0);
}

async function collectTwitterApiSample(trendName: string) {
  const now = Date.now();
  const query = `${xCountQuery(trendName)} since_time:${Math.floor((now - 24 * 60 * 60_000) / 1000)} until_time:${Math.floor((now - 15_000) / 1000)}`;
  const params = new URLSearchParams({ query, queryType: "Top" });
  const response = await fetchJson<TwitterApiSearchResponse>(`https://api.twitterapi.io/twitter/tweet/advanced_search?${params}`, {
    headers: { "X-API-Key": runtime.TWITTERAPI_IO_KEY! },
  }, 18_000);
  const unique = [...new Map((response.tweets ?? []).filter((post) => post.id && post.text).map((post) => [post.id, post])).values()].slice(0, 20);
  const ranked = [...unique].sort((a, b) => twitterApiPostEngagement(b) - twitterApiPostEngagement(a));
  const evidence = ranked.slice(0, 3).map((post) => {
    const username = post.author?.userName || "i";
    return {
      source: post.author?.userName ? `X · @${post.author.userName}` : "X",
      title: post.text.replace(/\s+/g, " ").trim().slice(0, 160),
      url: safeExternalUrl(post.url) || `https://x.com/${username}/status/${post.id}`,
      detail: `${Number(post.likeCount ?? 0).toLocaleString()} likes · ${Number(post.retweetCount ?? 0).toLocaleString()} reposts · ${Number(post.replyCount ?? 0).toLocaleString()} replies`,
    } satisfies TrendEvidence;
  });
  const authors = new Set(unique.map((post) => post.author?.userName).filter(Boolean));
  return {
    windows: twitterApiSampleWindows(unique, now),
    evidence,
    newest: unique.map((post) => post.createdAt).filter((value): value is string => Boolean(value)).sort().at(-1),
    engagement: unique.reduce((sum, post) => sum + twitterApiPostEngagement(post), 0),
    authorCount: authors.size,
    postCount: unique.length,
    billablePosts: Math.max(1, unique.length),
    observedAt: new Date(now).toISOString(),
  };
}

type PumpApiCoin = {
  mint?: string;
  name?: string;
  symbol?: string;
  description?: string;
  image_uri?: string;
  twitter?: string;
  website?: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  market_cap_usd?: number;
  market_cap?: number;
  is_banned?: boolean;
  nsfw?: boolean;
};

type PumpSeed = PumpApiCoin & {
  mint: string;
  name: string;
  symbol: string;
  bucket: PumpCoinBucket;
  rank: number;
  featureDescription?: string;
};

type PumpCollectorResult = { coins: PumpSeed[]; status: SourceStatus };

function flightProps<T>(html: string, property: string): T | undefined {
  const scripts = html.matchAll(/<script>self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g);
  for (const match of scripts) {
    try {
      const frame = JSON.parse(match[1]) as unknown[];
      const chunk = typeof frame[1] === "string" ? frame[1] : "";
      if (!chunk.includes(`"${property}"`)) continue;
      const separator = chunk.indexOf(":");
      if (separator < 1) continue;
      const component = JSON.parse(chunk.slice(separator + 1)) as unknown[];
      const props = component[3] as Record<string, T> | undefined;
      if (props?.[property] !== undefined) return props[property];
    } catch {
      // Flight responses contain many unrelated frames; only structured component frames are relevant here.
    }
  }
  return undefined;
}

function safeExternalUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function collectPumpFun(): Promise<PumpCollectorResult> {
  try {
    const html = await fetchText("https://pump.fun/explore", { headers: { Accept: "text/html,application/xhtml+xml" } }, 18_000);
    const runners = flightProps<Array<{ coin?: PumpApiCoin; description?: string }>>(html, "runners") ?? [];
    const movers = flightProps<PumpApiCoin[]>(html, "initialCoins") ?? [];
    const limit = clamp(Number(runtime.PUMPFUN_LIMIT ?? 12) || 12, 4, 20);
    const seen = new Set<string>();
    const seeds: PumpSeed[] = [];
    const add = (coin: PumpApiCoin | undefined, bucket: PumpCoinBucket, rank: number, featureDescription?: string) => {
      const mint = coin?.mint?.trim();
      const name = coin?.name?.trim();
      if (!mint || !name || coin?.is_banned || coin?.nsfw || seen.has(mint)) return;
      seen.add(mint);
      seeds.push({ ...coin, mint, name, symbol: coin?.symbol?.trim() || "—", bucket, rank, featureDescription });
    };
    runners.forEach((runner, index) => add(runner.coin, "Trending now", index + 1, runner.description));
    movers.forEach((coin, index) => add(coin, "Movers", index + 1));
    const selected = seeds.slice(0, limit);
    const enrichLimit = clamp(Number(runtime.PUMPFUN_ENRICH_LIMIT ?? 10) || 10, 0, limit);
    const enriched = await Promise.allSettled(selected.slice(0, enrichLimit).map((coin) => fetchJson<PumpApiCoin>(`https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(coin.mint)}`, {
      headers: { Origin: "https://pump.fun", Referer: "https://pump.fun/" },
    })));
    enriched.forEach((result, index) => {
      if (result.status === "fulfilled") selected[index] = { ...selected[index], ...result.value, mint: selected[index].mint, name: result.value.name?.trim() || selected[index].name, symbol: result.value.symbol?.trim() || selected[index].symbol };
    });
    return {
      coins: selected,
      status: {
        key: "pumpfun",
        label: "Pump.fun",
        state: selected.length ? "live" : "error",
        detail: selected.length ? `${runners.length} featured coins and ${Math.max(0, selected.length - runners.length)} leading Movers read from the official Explore surface` : "The Explore page returned no readable coin data",
        itemCount: selected.length,
      },
    };
  } catch (error) {
    return { coins: [], status: { key: "pumpfun", label: "Pump.fun", state: "error", detail: errorMessage(error), itemCount: 0 } };
  }
}

function pumpTrendMatch(coin: PumpSeed, trends: Trend[]) {
  const generic = new Set(["coin", "official", "token", "pump", "pumpfun", "cat", "dog", "bear", "bull", "meme", "the"]);
  const nameTokens = new Set(tokens(coin.name).filter((token) => !generic.has(token)));
  const coinTokens = new Set(tokens(`${coin.name} ${coin.featureDescription ?? ""}`).filter((token) => !generic.has(token)));
  let best: { trend: Trend; score: number } | undefined;
  for (const trend of trends) {
    const trendTokens = new Set(tokens(`${trend.title} ${trend.summary}`));
    const shared = [...coinTokens].filter((token) => trendTokens.has(token));
    const distinctiveSingle = shared.length === 1 && shared[0].length >= 6 && nameTokens.has(shared[0]);
    if (shared.length < 2 && !distinctiveSingle) continue;
    const score = shared.length / Math.max(1, Math.min(coinTokens.size, trendTokens.size)) + (trend.evidence.some((item) => /X/.test(item.source)) ? 0.08 : 0);
    if (!best || score > best.score) best = { trend, score };
  }
  return best?.trend;
}

function pumpAttentionWindows(base: number, counts?: WindowValues): WindowValues {
  return Object.fromEntries(Object.entries(windows(base)).map(([window, value]) => {
    const count = counts?.[window as keyof WindowValues] ?? 0;
    return [window, clamp(Math.round(value + Math.min(24, Math.log10(count + 1) * 7)), 10, 99)];
  })) as WindowValues;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function enrichPumpCoins(seeds: PumpSeed[], trends: Trend[]): Promise<{ coins: PumpCoin[]; xCoverage: number }> {
  const coins = seeds.map((coin): PumpCoin => {
    const relatedTrend = pumpTrendMatch(coin, trends);
    const pumpUrl = `https://pump.fun/coin/${coin.mint}`;
    const twitter = safeExternalUrl(coin.twitter);
    const website = safeExternalUrl(coin.website);
    const metadataSource = twitter || website;
    const metadataLabel = twitter ? "Creator-linked X source" : website ? `Creator-linked ${new URL(website).hostname.replace(/^www\./, "")}` : "Pump.fun listing only";
    const marketCapUsd = Math.max(0, Number(coin.usd_market_cap ?? coin.market_cap_usd ?? coin.market_cap ?? 0) || 0);
    const bucketBase = coin.bucket === "Trending now" ? 68 - (coin.rank - 1) * 4 : 48 - Math.min(18, (coin.rank - 1) * 1.4);
    const base = clamp(Math.round(bucketBase + Math.min(12, Math.log10(marketCapUsd + 1) * 2) + (metadataSource ? 4 : 0) + (relatedTrend ? 9 : 0)), 20, 88);
    const evidence: TrendEvidence[] = [{ source: "Pump.fun", title: `${coin.name} is #${coin.rank} in ${coin.bucket}`, url: pumpUrl, detail: marketCapUsd ? `$${Math.round(marketCapUsd).toLocaleString()} market cap shown at ingestion` : "Official coin page" }];
    if (twitter) evidence.push({ source: "Coin metadata · X", title: "Source post attached to the coin listing", url: twitter, detail: "Creator-supplied link; not independently verified" });
    if (website && website !== twitter) evidence.push({ source: "Coin metadata · Website", title: "Website attached to the coin listing", url: website, detail: "Creator-supplied link; not independently verified" });
    if (relatedTrend) evidence.push(...relatedTrend.evidence.slice(0, 2));
    const uniqueEvidence = [...new Map(evidence.map((item) => [item.url, item])).values()].slice(0, 7);
    const summary = relatedTrend
      ? `This listing appears to reference “${relatedTrend.title},” which Front Run is also seeing in independent trend evidence. Pump rank measures platform attention, not token quality.`
      : metadataSource
        ? `Pump.fun is surfacing ${coin.name}, and its listing points to ${metadataLabel.toLowerCase()}. No independent news/trend match is confirmed yet.`
        : `Pump.fun is surfacing ${coin.name}, but the listing does not provide a confirmed external origin. Treat it as platform attention only.`;
    return {
      mint: coin.mint,
      name: coin.name,
      symbol: coin.symbol,
      url: pumpUrl,
      imageUrl: safeExternalUrl(coin.image_uri),
      description: coin.featureDescription || coin.description?.trim() || "No creator description provided.",
      bucket: coin.bucket,
      rank: coin.rank,
      marketCapUsd,
      createdAt: coin.created_timestamp ? new Date(coin.created_timestamp).toISOString() : undefined,
      score: pumpAttentionWindows(base),
      summary,
      sourceLabel: relatedTrend ? `Matched trend · ${relatedTrend.title}` : metadataLabel,
      sourceUrl: relatedTrend ? relatedTrend.url : metadataSource || pumpUrl,
      relatedTrendId: relatedTrend?.id,
      relatedTrendTitle: relatedTrend?.title,
      evidence: uniqueEvidence,
    };
  });
  return { coins: coins.sort((a, b) => b.score["30m"] - a.score["30m"]), xCoverage: 0 };
}

function xCandidatePriority(item: Candidate) {
  const freshnessHours = Math.max(0, (Date.now() - new Date(item.publishedAt).getTime()) / 3_600_000);
  const freshnessBoost = Math.max(0, 24 - freshnessHours);
  const viralBoost = animalSubcategoryFor(`${item.title} ${item.relatedNews?.title ?? ""}`) === "Viral animals" ? 28 : 0;
  const sourceBoost = item.source === "publisher" ? 18 : item.source === "news" ? 14 : item.source === "google" ? 3 : 0;
  return 100 + viralBoost + sourceBoost + freshnessBoost + item.strength;
}

let ephemeralTwitterApiUsage: TwitterApiMonthlyUsage & { month: string } = { month: "", billablePosts: 0, queryCount: 0 };

function cachedTwitterApiItems(previousPayload: TrendsPayload | null | undefined, now: number, cacheHours: number) {
  if (!previousPayload) return [];
  const maxAgeMs = cacheHours * 60 * 60_000;
  return previousPayload.trends.flatMap((trend): Candidate[] => {
    if (trend.category !== "Animals" || !isAnimalCandidate(`${trend.title} ${trend.evidence.map((item) => item.title).join(" ")}`)) return [];
    const metric = trend.platforms.x;
    const observedAt = new Date(metric?.observedAt ?? "").getTime();
    if (!metric || metric.scope !== "sample" || !Number.isFinite(observedAt) || now - observedAt > maxAgeMs) return [];
    const evidence = trend.evidence.filter((item) => item.source === "X" || item.source.startsWith("X ·"));
    const sourceAnchor = trend.evidence.find((item) => item.source !== "X search" && item.source !== "X" && !item.source.startsWith("X ·"));
    return [{
      id: `x-cache-${trend.id}`,
      title: sourceAnchor?.title || trend.title,
      url: evidence[0]?.url || trend.url,
      source: "x",
      sourceLabel: "X sample · cached",
      publishedAt: metric.observedAt!,
      activity: Math.max(1, metric.windows["24h"]),
      strength: clamp(Math.round(trend.score["30m"] * 0.78), 38, 78),
      detail: `Cached TwitterAPI.io sample · observed ${ageLabel(metric.observedAt!)}`,
      geography: trend.geography,
      categoryHint: { category: trend.category, subcategory: trend.subcategory },
      platform: { key: "x", metric },
      extraEvidence: evidence,
    }];
  });
}

async function collectX(sourceCandidates: Candidate[], options: BuildTrendsOptions = {}): Promise<CollectorResult> {
  const now = Date.now();
  const month = new Date(now).toISOString().slice(0, 7);
  if (ephemeralTwitterApiUsage.month !== month) ephemeralTwitterApiUsage = { month, billablePosts: 0, queryCount: 0 };
  const cacheHoursValue = Number(runtime.TWITTERAPI_CACHE_HOURS ?? 6);
  const cacheHours = Number.isFinite(cacheHoursValue) ? clamp(cacheHoursValue, 1, 24) : 6;
  const cachedItems = cachedTwitterApiItems(options.previousPayload, now, cacheHours);
  if (!runtime.TWITTERAPI_IO_KEY) {
    return { items: cachedItems, status: { key: "x", label: "X sample", state: "needs-key", detail: "Add TWITTERAPI_IO_KEY for cost-controlled X samples and leading-post links", itemCount: cachedItems.length } };
  }

  const usage = options.twitterApiUsage ?? ephemeralTwitterApiUsage;
  const budgetValue = Number(runtime.TWITTERAPI_MONTHLY_BUDGET_USD ?? 5);
  const budgetUsd = Number.isFinite(budgetValue) ? clamp(budgetValue, 0, 1_000) : 5;
  const maxBillablePosts = Math.floor(budgetUsd / 0.00015);
  const remainingPosts = Math.max(0, maxBillablePosts - usage.billablePosts);
  if (remainingPosts < 20) {
    return { items: cachedItems, status: { key: "x", label: "X sample", state: "restricted", detail: `$${budgetUsd.toFixed(2)} monthly TwitterAPI.io cap reached · cached samples remain visible`, itemCount: cachedItems.length } };
  }

  const intervalValue = Number(runtime.TWITTERAPI_SAMPLE_INTERVAL_MINUTES ?? 30);
  const intervalMinutes = Number.isFinite(intervalValue) ? clamp(intervalValue, 5, 360) : 30;
  const lastUsedAt = new Date(usage.lastUsedAt ?? "").getTime();
  const cadenceOpen = !Number.isFinite(lastUsedAt) || now - lastUsedAt >= intervalMinutes * 60_000;
  const queryLimitValue = Number(runtime.TWITTERAPI_QUERY_LIMIT ?? 1);
  const queryLimit = Number.isFinite(queryLimitValue) ? clamp(Math.floor(queryLimitValue), 0, 5) : 1;
  const runLimit = cadenceOpen ? Math.min(queryLimit, Math.floor(remainingPosts / 20)) : 0;
  if (!runLimit) {
    const spend = usage.billablePosts * 0.00015;
    return { items: cachedItems, status: { key: "x", label: "X sample", state: "live", detail: `${cachedItems.length} cached samples · next query slot every ${intervalMinutes}m · about $${spend.toFixed(2)} of $${budgetUsd.toFixed(2)} cap`, itemCount: cachedItems.length } };
  }

  const priorTrends = options.previousPayload?.trends ?? [];
  const seen = new Set<string>();
  const rankedSeeds = [...sourceCandidates]
    .filter((item) => item.source === "publisher" || item.source === "news" || item.source === "google")
    .filter((item) => isAnimalCandidate(`${item.title} ${item.relatedNews?.title ?? ""}`))
    .filter((item) => {
      const key = normalize(shortTrendTitle(item.title));
      if (!key || seen.has(key)) return false;
      seen.add(key);
      const prior = priorTrends.find((trend) => trend.id === slug(item.title) || similar(trend.title, item.title));
      const observedAt = new Date(prior?.platforms.x?.observedAt ?? "").getTime();
      if (prior?.phase === "Cooling" && Number.isFinite(observedAt)) return false;
      return !Number.isFinite(observedAt) || now - observedAt >= cacheHours * 60 * 60_000;
    })
    .sort((a, b) => {
      const aPrior = priorTrends.some((trend) => trend.id === slug(a.title) || similar(trend.title, a.title));
      const bPrior = priorTrends.some((trend) => trend.id === slug(b.title) || similar(trend.title, b.title));
      return Number(aPrior) - Number(bPrior) || xCandidatePriority(b) - xCandidatePriority(a);
    });

  const categoryCycle = ["Viral animals", "Zoo babies", "Rescues", "Cats", "Dogs", "Wildlife"];
  const slot = Math.floor(now / (intervalMinutes * 60_000));
  const targets: Candidate[] = [];
  for (let index = 0; index < runLimit; index += 1) {
    const preferred = categoryCycle[(slot + index) % categoryCycle.length];
    const candidate = rankedSeeds.find((item) => !targets.includes(item) && animalSubcategoryFor(`${item.title} ${item.relatedNews?.title ?? ""}`) === preferred)
      ?? rankedSeeds.find((item) => !targets.includes(item));
    if (!candidate) break;
    targets.push(candidate);
  }

  const results = await Promise.allSettled(targets.map(async (target) => ({ target, sample: await collectTwitterApiSample(target.title) })));
  const liveItems: Candidate[] = [];
  let billablePosts = 0;
  let queryCount = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { target, sample } = result.value;
    billablePosts += sample.billablePosts;
    queryCount += 1;
    if (!sample.postCount) continue;
    liveItems.push({
      id: `x-sample-${slug(target.title)}`,
      title: target.title,
      url: sample.evidence[0]?.url || `https://x.com/search?q=${encodeURIComponent(xCountQuery(target.title))}`,
      source: "x",
      sourceLabel: "X sample · TwitterAPI.io",
      publishedAt: sample.newest || sample.observedAt,
      activity: Math.max(1, sample.engagement),
      strength: clamp(Math.round(42 + Math.log10(sample.engagement + 1) * 10 + Math.min(10, sample.authorCount)), 40, 94),
      detail: `${sample.postCount} matched posts · ${sample.authorCount} authors · sample, not platform-wide count`,
      geography: "US-seeded · English X",
      categoryHint: { category: "Animals", subcategory: animalSubcategoryFor(target.title) },
      platform: {
        key: "x",
        metric: { label: "X sampled posts", metric: "posts", scope: "sample", windows: sample.windows, detail: "Up to 20 public posts from a 24-hour TwitterAPI.io search; not a platform-wide count", observedAt: sample.observedAt },
      },
      extraEvidence: sample.evidence,
    });
  }

  let usageRecordFailed = false;
  if (billablePosts && queryCount) {
    ephemeralTwitterApiUsage.billablePosts += billablePosts;
    ephemeralTwitterApiUsage.queryCount += queryCount;
    ephemeralTwitterApiUsage.lastUsedAt = new Date(now).toISOString();
    try {
      await options.recordTwitterApiUsage?.(billablePosts, queryCount);
    } catch {
      usageRecordFailed = true;
    }
  }
  const carriedItems = cachedItems.filter((cached) => !liveItems.some((live) => similar(live.title, cached.title)));
  const items = [...liveItems, ...carriedItems];
  const failures = results.filter((result) => result.status === "rejected");
  const usedAfter = usage.billablePosts + billablePosts;
  const spend = usedAfter * 0.00015;
  const detail = liveItems.length || carriedItems.length
    ? `${liveItems.length} live sample${liveItems.length === 1 ? "" : "s"} · ${carriedItems.length} cached · about $${spend.toFixed(2)} of $${budgetUsd.toFixed(2)} cap${usageRecordFailed ? " · usage ledger write failed" : ""}`
    : failures.length ? errorMessage(failures[0].reason) : "No matching X posts returned in this sample slot";
  return { items, status: { key: "x", label: "X sample", state: items.length ? "live" : failures.length ? "error" : "live", detail, itemCount: items.length } };
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
        if (!isAnimalCandidate(video.snippet.title)) continue;
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
          categoryHint: { category: "Animals", subcategory: animalSubcategoryFor(video.snippet.title) },
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
      .filter((item) => (item.source === "x" || item.source === "google" || item.source === "news") && isAnimalCandidate(item.title))
      .slice(0, Math.ceil(queryLimit / 2))
      .map((item) => ({ title: item.title, query: shortSearchQuery(item.title) }));
    const manual = (runtime.TIKTOK_SEED_QUERIES || "viral animal usa,viral pet usa,zoo baby viral,animal rescue viral,cute animals usa,wildlife caught on camera")
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
        geography: "US-seeded",
        categoryHint: { category: "Animals", subcategory: animalSubcategoryFor(`${seed.title} ${example}`) },
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
  return !new Set(["home", "news", "breaking", "latest", "update", "detroit free press", "associated press", "new york times", "cbs news", "fox news"]).has(normalized);
}

function isLowSignalMemeCollection(title: string) {
  const normalized = title.replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
  return /\b(?:top|best|funniest|hilarious|greatest|favorite|favourite|iconic|classic|popular|relatable|random|wholesome|wild)\s+(?:\d+\s+)?memes?\b/i.test(normalized)
    || /(?:^|\b)\d+\s+(?:(?:hilarious|funny|stunning|bizarre|confusing|wholesome|random|relatable|iconic|classic|wild|internet)\s+){0,3}memes?\b/i.test(normalized)
    || /\bmemes?\s+(?:of|from)\s+(?:the\s+)?(?:day|week|month|year|decade|2010s|2020s|internet)\b/i.test(normalized)
    || /\b(?:daily|weekly|monthly)\s+memes?\b|\b(?:meme roundup|meme dump|meme compilation|meme collection|collection of memes|meme list|memes to make you|memes that will)\b/i.test(normalized)
    || /\b(?:these|here are|enjoy)\s+(?:the\s+|a\s+)?(?:\d+\s+)?memes?\b/i.test(normalized);
}

function isPromotionalMemeEntry(title: string) {
  return /\b(?:app|web|website|software|react native|mobile) development (?:agency|agencies|company|companies|services?)\b/i.test(title)
    || /\b(?:advertising|marketing|seo|casino|betting|loan|insurance|essay|assignment|homework) (?:agency|agencies|company|companies|services?)\b/i.test(title)
    || /\b(?:buy|download)\s+(?:followers|likes|views|apk|software)\b/i.test(title);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isSpecificMemeHeadline(title: string) {
  const normalized = normalize(title);
  if (normalized === "meme" || normalized === "memes" || isLowSignalMemeCollection(title) || isPromotionalMemeEntry(title)) return false;
  if (/\b(?:meme ?coin|memecoin|meme stock|stock price|price prediction|crypto(?:currency)?|token|lawsuit|shares?)\b/i.test(title)) return false;
  return /\b(?:what|who)\s+is\b[\s\S]*\b(?:meme|trend|format|catchphrase)\b/i.test(title)
    || /\b(?:meme|trend|format|template|catchphrase)\b[\s\S]*\b(?:explained|origin|meaning|takes over|goes viral|going viral|spreads?|resurfaces?|revival)\b/i.test(title)
    || /\b(?:meme|trend)\s+(?:returns?|resurfaces?)\b/i.test(title)
    || /\b(?:becomes?|became|turns?|turned)\s+into\s+(?:a\s+)?(?:viral\s+)?meme\b/i.test(title)
    || /\bviral\s+(?:meme|trend|format|reaction)\b/i.test(title)
    || /\b(?:reaction image|image macro|meme format|meme template|redraw trend)\b/i.test(title);
}

function compactTrendTitle(value: string) {
  let words = value.split(/\s+/).filter(Boolean);
  if (words.length > 5) words = words.slice(0, 5);
  while (words.join(" ").length > 42 && words.length > 2) words.pop();
  const weakEndings = new Set(["a", "an", "and", "are", "as", "at", "by", "drive", "drives", "for", "from", "her", "his", "in", "is", "next", "of", "on", "reach", "reaches", "the", "than", "to", "while", "with"]);
  while (words.length > 2 && weakEndings.has(normalize(words.at(-1) ?? ""))) words.pop();
  return words.join(" ").replace(/[,:;.!?]+$/g, "");
}

function shortTrendTitle(input: string) {
  let title = input
    .replace(/\s+/g, " ")
    .replace(/^[“”'"‘’]+|[“”'"‘’]+$/g, "")
    .replace(/^(breaking|exclusive|watch|video|analysis|explained|who is|what is)\s*[:?—-]*\s*/i, "")
    .trim();
  const quotedQuestion = input.match(/^(?:Who|What)\s+Is\s+(?:The\s+)?['“]([^'”]{2,60})['”]/i)
    ?? input.match(/^(?:Who|What)\s+Is\s+(?:The\s+)?([^?]{2,60})\?/i);
  if (quotedQuestion) return compactTrendTitle(quotedQuestion[1].replace(/[?!]+$/g, ""));
  const quotedMeme = input.match(/['“]([^'”]{2,80})['”]\s+(?:meme|memes|trend)\b/i);
  if (quotedMeme) return compactTrendTitle(quotedMeme[1].replace(/[?!]+$/g, ""));
  const catchphrase = input.match(/\bcatchphrase\s+['“]([^'”]{2,80})['”]/i);
  if (catchphrase) return compactTrendTitle(catchphrase[1].replace(/[?!]+$/g, ""));
  if (/\bFitGirl Repacks\b/i.test(input)) return compactTrendTitle("FitGirl Repacks");
  const documentary = input.match(/\b([A-Z]{2,}\d*\s+Documentary)\b/);
  if (documentary) return compactTrendTitle(documentary[1]);
  if (/^Cursed Pam Beesly and Stanley Hudson Screenshot$/i.test(input)) return compactTrendTitle("Cursed Pam & Stanley");
  const ugliestDog = title.match(/^Meet\s+([^,]+),.*World'?s Ugliest Dog/i);
  if (ugliestDog) return compactTrendTitle(`${ugliestDog[1]}, Ugliest Dog Winner`);
  const foodBear = title.match(/\b(bear|polar bear|black bear|brown bear)\b.*\bbroke into\b.*\b(KFC|pizza|tacos?|food)\b/i);
  if (foodBear) return compactTrendTitle(`${foodBear[2].toUpperCase()}-Stealing ${foodBear[1].replace(/\b\w/g, (letter) => letter.toUpperCase())}`);
  const zooBaby = title.match(/\b((?:baby|newborn|endangered)\s+[a-z-]+(?:\s+(?!born\b|birth\b|hatched\b|hatches\b|arrives?\b)[a-z-]+)?)\b.*\b(?:born|birth|hatched|hatches|arrives?)\b.*\b(?:at|from)\s+(?:the\s+)?([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,3}\s+Zoo)\b/i);
  if (zooBaby) return compactTrendTitle(`${zooBaby[2]}’s ${zooBaby[1].replace(/\b\w/g, (letter) => letter.toUpperCase())}`);
  const zooAgreement = title.match(/^(.+?\bZoo)\b.*\b(?:reach|reaches|sign|signs)\b.*\bagreement\b/i);
  if (zooAgreement) return compactTrendTitle(`${zooAgreement[1]} Agreement`);
  const zooSubject = title.match(/^(.+?\bZoo)\b.*?\b(sea turtle|pygmy hippo|hippo|gorilla|giraffe|elephant|panda|bear|beluga|whale|dolphin|porpoise|penguin|otter|capybara|rhino|tiger|lion|leopard|fox|wolf|monkey|ape|bird|kagu|turtle|snake|lizard|frog)\b/i);
  if (zooSubject) {
    const action = /\b(?:born|birth|newborn|welcomes?|arrival|arrives?)\b/i.test(title) ? "New" : /\btreats?\b/i.test(title) ? "Treats" : /\brescu(?:e|es|ed)\b/i.test(title) ? "Rescues" : "";
    return compactTrendTitle(`${zooSubject[1]} ${action} ${zooSubject[2].replace(/\b\w/g, (letter) => letter.toUpperCase())}`);
  }
  if (/\bblack bear\b/i.test(title) && /\balert\b/i.test(title)) return compactTrendTitle("Black Bear Alert");
  if (/\bblack bear\b/i.test(title) && /\bencounter\b/i.test(title)) return compactTrendTitle("Black Bear Encounter");
  if (/\brescued? beluga whales?\b/i.test(title)) return compactTrendTitle("Rescued Beluga Whales");
  if (/\brescued? sea turtle\b/i.test(title)) return compactTrendTitle("Rescued Sea Turtle");
  if (/^Meet\s+Rhossi\b/i.test(title) && /\bsea turtle\b/i.test(title)) return compactTrendTitle("Rhossi the Sea Turtle");
  if (/\bcat sanctuary\b/i.test(title) && /\bteam up\b/i.test(title)) return compactTrendTitle("Cat Rescue Team-Up");
  const fireDogRescue = title.match(/\bdog rescue by\s+(.+?)(?:\s*$|[.!?])/i);
  if (fireDogRescue) return compactTrendTitle(`${fireDogRescue[1]} Rescues Dog`);
  if (/\bEugene-Springfield\b/i.test(title) && /\bcat colonies\b/i.test(title)) return compactTrendTitle("Eugene Cat Colonies");
  if (/\bdog-bite death\b/i.test(title) && /\bWakefield\b/i.test(title)) return compactTrendTitle("Wakefield Dog-Bite Death");
  const pandaVote = title.match(/^([A-Z][\w'-]+)\b.*\bvote to name baby panda\b/i);
  if (pandaVote) return compactTrendTitle(`${pandaVote[1]}’s Baby Panda`);
  if (/\bKagu bird dancing\b/i.test(title) && /\bSan Diego\b/i.test(title)) return compactTrendTitle("San Diego’s Dancing Kagu");
  if (/\b5,?000 little penguins\b/i.test(title) && /\b(?:vaxxed|vaccinated)\b/i.test(title)) return compactTrendTitle("5,000 Penguins Get Vaccinated");
  const bearAttack = title.match(/\bmauled by (?:a |an )?((?:black|brown|polar|grizzly) bear)\b/i);
  if (bearAttack) return compactTrendTitle(`${bearAttack[1].replace(/\b\w/g, (letter) => letter.toUpperCase())} ${/trail/i.test(title) ? "Trail " : ""}Attack`);
  const zooAnimals = title.match(/\b(?:at )?(?:a )?([A-Z][\w'-]+) zoo\b.*\banimals?\b/i);
  if (zooAnimals) return compactTrendTitle(`${zooAnimals[1]} Zoo Animals`);
  const narratedStory = title.match(/^In\s+['“]([^'”]+)['”],?\s+(?:a|an|the)\s+((?:canine|feline|animal|dog|cat)(?:\s+narrator)?)/i);
  if (narratedStory) return compactTrendTitle(`${narratedStory[1].replace(/[,:;.!?]+$/g, "")}, the ${narratedStory[2].replace(/\b\w/g, (letter) => letter.toUpperCase())}`);
  if (/FOSCA/i.test(title) && /rescue pet/i.test(title)) return compactTrendTitle("FOSCA Rescue Pet Calendar");
  const zooHero = title.match(/\b(HeroRATs)\b.*\b([A-Z][a-z]+) Zoo\b/);
  if (zooHero) return compactTrendTitle(`${zooHero[2]} Zoo’s ${zooHero[1]}`);
  if (/marine biologists/i.test(title) && /harbor porpoise/i.test(title) && /wildlife mystery/i.test(title)) return compactTrendTitle("Harbor Porpoise Mating Mystery");
  const firstSentence = title.split(/(?<=[.!?])\s+/)[0];
  if (firstSentence.split(/\s+/).length >= 2) title = firstSentence;
  const segments = title.split(/\s+(?:—|–|\|)\s+|:\s+/).map((part) => part.trim()).filter(Boolean);
  if (segments[0] && segments[0].split(/\s+/).length >= 2) title = segments[0];
  title = title
    .replace(/^meet\s+/i, "")
    .replace(/\b(?:confirmed|explained|what we know|everything to know|see (?:it|them) in action)\b.*$/i, "")
    .replace(/[.!?;,]+$/g, "")
    .trim();
  return compactTrendTitle(title) || input.trim().slice(0, 42);
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

const animalTerms = /\b(?:animal|animals|wildlife|zoo|aquarium|pet|pets|veterinarian|veterinary|shelter|catster|dogster|canine|feline|cat|cats|kitten|kittens|dog|dogs|puppy|puppies|bear|bears|panda|grizzly|polar bear|bird|birds|avian|crow|eagle|owl|parrot|penguin|flamingo|duck|goose|falcon|kagu|whale|shark|dolphin|porpoise|octopus|seal|orca|manatee|sea turtle|otter|hippo|capybara|elephant|lion|tiger|leopard|cheetah|jaguar|fox|wolf|coyote|monkey|gorilla|chimpanzee|orangutan|lemur|primate|rabbit|hare|deer|moose|elk|bison|horse|pony|donkey|cow|cattle|goat|sheep|pig|piglet|snake|alligator|crocodile|turtle|tortoise|lizard|iguana|reptile|frog|toad|rhino|rhinoceros|giraffe|zebra|koala|kangaroo|wombat|platypus|sloth|anteater|armadillo|raccoon|skunk|badger|beaver|squirrel|hamster|guinea pig|mouse|mice|rat|ferret|hedgehog|bat|butterfly|bee|insect)\b/i;
const animalContext = /\b(?:born|birth|newborn|baby|cub|calf|chick|hatch|hatched|nest|herd|flock|pack|paws?|fur|feathers?|wings?|habitat|species|endangered|conservation|rescue|rescued|rehabilitat|adopted|adoption|released|sanctuary|keeper|keepers|veterinar|migration|breeding|wild)\b/i;
const nonAnimalContext = /\b(?:mlb|nba|nfl|nhl|ncaa|baseball|football|basketball|hockey|soccer|pitcher|outfielder|shortstop|home run|touchdown|election|voter|congress|senate|governor|federal|government|stock|stocks|market|shares|earnings|crypto|token|car|vehicle|software|browser|network|commander)\b/i;

function isAnimalCandidate(title: string) {
  if (!animalTerms.test(title)) return false;
  if (/\b(?:fox news|bear market|bull market|pete crow[- ]armstrong|chicago cubs|detroit tigers|jacksonville jaguars|miami dolphins|philadelphia eagles|memphis grizzlies|toronto raptors|arizona cardinals)\b/i.test(title)) return false;
  if (nonAnimalContext.test(title) && !animalContext.test(title) && !/\b(?:zoo|aquarium|wildlife|animal|animals|pet|pets)\b/i.test(title)) return false;
  return true;
}

function animalSubcategoryFor(title: string) {
  if (/\b(?:viral|goes viral|going viral|internet sensation|internet star|social media|tiktok|instagram|caught on camera|wins the internet|moo deng)\b/i.test(title)) return "Viral animals";
  if (/\b(?:zoo|aquarium|wildlife park)\b/i.test(title) && /\b(?:baby|newborn|born|birth|cub|calf|chick|hatch|hatched)\b/i.test(title)) return "Zoo babies";
  if (/\b(?:rescue|rescued|rehabilitat|adopted|adoption|shelter|sanctuary|released back|saved)\b/i.test(title)) return "Rescues";
  if (/\b(?:endangered|threatened|extinct|extinction|conservation|population decline|habitat loss)\b/i.test(title)) return "Endangered";
  if (/\b(?:cat|cats|kitten|kittens|feline|tabby|catster)\b/i.test(title)) return "Cats";
  if (/\b(?:dog|dogs|puppy|puppies|canine|pup|dogster|kennel club)\b/i.test(title)) return "Dogs";
  if (/\b(?:bear|bears|polar bear|panda|grizzly)\b/i.test(title)) return "Bears";
  if (/\b(?:bird|birds|avian|crow|eagle|owl|parrot|penguin|flamingo|duck|goose|falcon|kagu)\b/i.test(title)) return "Birds";
  if (/\b(?:whale|shark|dolphin|porpoise|octopus|seal|orca|manatee|sea turtle|otter|aquarium|marine)\b/i.test(title)) return "Marine life";
  if (/\b(?:monkey|gorilla|chimpanzee|orangutan|lemur|primate|ape)\b/i.test(title)) return "Primates";
  if (/\b(?:snake|alligator|crocodile|turtle|tortoise|lizard|iguana|reptile|frog|toad)\b/i.test(title)) return "Reptiles";
  if (/\b(?:horse|pony|donkey|cow|cattle|goat|sheep|pig|piglet|farm animal)\b/i.test(title)) return "Farm animals";
  return "Wildlife";
}

function categoryFor(title: string, hasPublisherContext = false): [string, string] {
  if (isAnimalCandidate(title)) return ["Animals", animalSubcategoryFor(title)];
  const text = normalize(title);
  const wordSet = new Set(text.split(/\s+/));
  const match = (values: string[]) => values.some((value) => value.includes(" ") ? text.includes(value) : wordSet.has(value));
  if (match(["bear market", "bull market", "fox news"])) return ["News", match(["bear market", "bull market"]) ? "Business" : "World"];
  if (text.includes("pete crow armstrong") || match(["baseball", "mlb", "cubs", "yankees", "dodgers", "red sox", "pitcher", "outfielder", "shortstop", "home run"])) return ["Sports", "Other"];
  if (match(["football", "soccer", "goalkeeper", "quarterback", "nfl", "mls", "wolverines", "premier league", "champions league"])) return ["Sports", "Football"];
  if (match(["cricket", "ipl", "wicket"])) return ["Sports", "Cricket"];
  if (match(["basketball", "nba", "wnba", "ncaa", "lakers", "celtics", "warriors", "knicks", "bulls", "nets"])) return ["Sports", "Basketball"];
  if (match(["hockey", "nhl", "tennis", "golf", "ufc", "boxing", "nascar", "formula 1", "f1"])) return ["Sports", "Other"];
  const politicalContext = match(["government", "voter", "voters", "election", "congress", "senate", "governor", "state decision", "feds", "federal"]);
  const explicitBirdContext = match(["birds", "bird flu", "avian", "wildlife", "zoo", "nest", "wing", "wings", "feather", "feathers", "flock", "penguin", "eagle", "owl", "parrot", "duck", "goose", "falcon", "kagu"]);
  if (wordSet.has("bird") && politicalContext && !explicitBirdContext) return ["News", "World"];
  if (match(["meme", "memes", "image macro", "reaction image", "shitpost", "copypasta"])) {
    if (match(["resurgence", "resurges", "returns", "revival", "back again"])) return ["Memes", "Resurgences"];
    if (match(["format", "template", "exploitable", "image macro", "reaction image"])) return ["Memes", "Formats"];
    return ["Memes", "Trending"];
  }
  if (match(["bear", "bears", "polar bear", "panda", "grizzly"])) return ["Animals", "Bears"];
  if (match(["whale", "shark", "dolphin", "octopus", "ocean", "seal", "orca", "sea turtle", "manatee", "aquarium"])) return ["Animals", "Marine"];
  if (match(["bird", "birds", "crow", "eagle", "owl", "parrot", "penguin", "duck", "goose", "falcon"])) return ["Animals", "Birds"];
  if (match(["cat", "cats", "kitten", "kittens", "feline", "tabby"])) return ["Animals", "Cats"];
  if (match(["dog", "dogs", "puppy", "puppies", "canine", "pup"])) return ["Animals", "Dogs"];
  if (match(["animal", "animals", "wildlife", "zoo", "pet", "pets", "veterinarian", "animal rescue", "shelter", "capybara", "elephant", "lion", "tiger", "fox", "wolf", "monkey", "gorilla", "otter", "rabbit", "deer", "horse", "cow"])) return ["Animals", "Wildlife"];
  if (match(["recipe", "restaurant", "chef", "food", "coffee", "cake", "pizza", "drink"])) return ["Food & drink", match(["recipe", "cake"]) ? "Recipes" : match(["restaurant", "chef"]) ? "Restaurants" : "Food loops"];
  if (match(["movie", "film", "trailer", "series", "episode", "finale", "netflix", "hbo"])) return ["Entertainment", "Film & TV"];
  if (match(["song", "album", "music", "singer", "concert"])) return ["Entertainment", "Music"];
  if (match(["creator", "influencer", "streamer", "youtuber", "tiktoker"])) return ["Entertainment", "Creators"];
  if (match(["challenge"])) return ["Viral events", "Challenges"];
  if (match(["reaction", "reacts", "response"])) return ["Viral events", "Reactions"];
  if (match(["format", "template", "trend format", "dance trend"])) return ["Viral events", "Formats"];
  if (match(["joke"])) return ["Internet culture", "Creator lore"];
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
  return ({ Memes: "violet", Animals: "ice", Technology: "blue", News: "amber", "Viral events": "violet", "Internet culture": "blue", Entertainment: "rose", Sports: "green", "Food & drink": "orange" } as Record<string, string>)[category] || "sand";
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

function sourcePriorityWeight(source: SourceKey) {
  return ({ x: 1, kym: 0.94, publisher: 0.9, news: 0.82, tiktok: 0.8, youtube: 0.78, hackernews: 0.7, google: 0.55 } as Record<SourceKey, number>)[source];
}

function buildTrend(cluster: Candidate[]): Trend {
  const detectedAt = new Date().toISOString();
  const leader = [...cluster].sort((a, b) => b.strength * sourcePriorityWeight(b.source) - a.strength * sourcePriorityWeight(a.source))[0];
  const classificationText = cluster.map((item) => `${item.title} ${item.relatedNews?.title ?? ""}`).join(" ");
  const categoryHint = [...cluster].sort((a, b) => b.strength - a.strength).find((item) => item.categoryHint)?.categoryHint;
  const [category, subcategory] = categoryHint ? [categoryHint.category, categoryHint.subcategory] : categoryFor(classificationText, cluster.some((item) => item.source === "publisher" || item.source === "news" || Boolean(item.relatedNews)));
  const latestSourceAt = cluster.reduce((latest, item) => new Date(item.publishedAt).getTime() > new Date(latest).getTime() ? item.publishedAt : latest, leader.publishedAt);
  const ageMinutes = Math.max(1, (Date.now() - new Date(latestSourceAt).getTime()) / 60_000);
  const activity = Math.round(cluster.reduce((sum, item) => sum + item.activity, 0));
  const diversity = new Set(cluster.map((item) => item.source === "publisher" || item.source === "news" ? `${item.source}:${item.sourceLabel}` : item.source)).size;
  const usObservationCount = cluster.filter((item) => item.geography.startsWith("US")).length;
  const marketAdjustment = usObservationCount > 0 ? Math.min(10, 6 + usObservationCount * 2) : -10;
  const leaderStrength = leader.strength * sourcePriorityWeight(leader.source);
  const freshnessBoost = ageMinutes <= 60 ? 12 : ageMinutes <= 360 ? 8 : ageMinutes <= 1440 ? 3 : -5;
  const socialBoost = cluster.some((item) => item.source === "x" || item.source === "tiktok") ? 9 : 0;
  const viralAnimalBoost = subcategory === "Viral animals" ? 7 : 0;
  const baseScore = clamp(Math.round(leaderStrength * 0.68 + Math.min(18, diversity * 5) + Math.min(10, cluster.length * 1.5) + marketAdjustment + freshnessBoost + socialBoost + viralAnimalBoost), 18, 99);
  const saturation = clamp(Math.round(ageMinutes / 30 + cluster.length * 4 + Math.max(0, baseScore - 75)), 6, 96);
  let phase: Phase = ageMinutes < 150 && saturation < 42 ? "Igniting" : ageMinutes < 720 && saturation < 68 ? "Accelerating" : saturation > 82 || ageMinutes > 1440 ? "Cooling" : "Peaking";
  if (baseScore < 45 && ageMinutes > 480) phase = "Cooling";
  const forecastTime = phase === "Igniting" ? "30–90 min" : phase === "Accelerating" ? "1–3 hours" : phase === "Peaking" ? "30–120 min" : "Now";
  const forecast = phase === "Igniting"
    ? "The animal story is entering its breakout window. A second large account, fresh video angle or publisher pickup would materially increase its reach."
    : phase === "Accelerating"
      ? "Attention is broadening. Watch for a named-animal hook, follow-up clip or major publisher pickup before the next check."
      : phase === "Peaking"
        ? "The first attention peak is close. A verified update, new footage or keeper/rescuer follow-up is the clearest path to a second wave."
        : "The story is losing freshness. Residual reposts are more likely than a new animal-news wave.";
  const weights = new Map<string, number>();
  for (const item of cluster) weights.set(item.source, (weights.get(item.source) ?? 0) + item.strength * sourcePriorityWeight(item.source));
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
    firstSeen: "just now",
    firstSeenAt: detectedAt,
    latestSourceAt: new Date(latestSourceAt).toISOString(),
    geography: [...new Set(cluster.map((item) => item.geography))].slice(0, 3).join(" · "),
    forecast,
    forecastTime,
    confidence: clamp(52 + diversity * 9 + Math.min(12, cluster.length * 2), 55, 91),
    summary: `${leader.title.replace(/[.!?]+$/, "")}. ${platforms.x ? `The latest X sample found ${platforms.x.windows["24h"].toLocaleString()} matching posts in the last 24 hours` : `Front Run found ${cluster.length} recent animal-news observation${cluster.length === 1 ? "" : "s"}`} across ${diversity} measured ${diversity === 1 ? "source" : "sources"}.`,
    signals: [
      `${cluster.length} animal-news observations in this cluster`,
      `${diversity} measured animal source ${diversity === 1 ? "surface" : "surfaces"}`,
      saturation < 35 ? "Low current saturation" : saturation > 75 ? "Attention is becoming saturated" : "Audience breadth is still expanding",
    ],
    tags: keywords.map((keyword) => `#${keyword}`),
    saturation,
    tone: toneFor(category),
    activity,
    historyPoints: 0,
    evidence: [...new Map(cluster.flatMap((item) => [
      { source: item.sourceLabel, title: item.title, url: item.url, detail: `${item.detail} · source ${ageLabel(item.publishedAt)}` },
      ...(item.extraEvidence ?? []),
    ]).map((item) => [item.url, item])).values()].slice(0, 10),
  };
}

const TOTAL_TREND_LIMIT = 180;
const PER_ANIMAL_CATEGORY_RESERVE = 8;

function clusterCandidates(items: Candidate[]) {
  const clusters: Candidate[][] = [];
  const filteredItems = items.filter((item) => isAnimalCandidate(`${item.title} ${item.relatedNews?.title ?? ""}`));
  for (const item of [...filteredItems].sort((a, b) => b.strength - a.strength)) {
    const existing = clusters.find((cluster) => cluster.some((candidate) => similar(candidate.title, item.title)));
    if (existing) existing.push(item);
    else clusters.push([item]);
  }
  const ranked = clusters
    .map(buildTrend)
    .filter((trend) => trend.category === "Animals")
    .sort((a, b) => {
      const freshnessA = new Date(a.latestSourceAt ?? 0).getTime();
      const freshnessB = new Date(b.latestSourceAt ?? 0).getTime();
      return b.score["30m"] - a.score["30m"] || freshnessB - freshnessA;
    });
  const selected = new Map<string, Trend>();
  for (const taxonomy of TREND_TAXONOMY[0].subcategories) {
    for (const trend of ranked.filter((candidate) => candidate.subcategory === taxonomy).slice(0, PER_ANIMAL_CATEGORY_RESERVE)) {
      selected.set(trend.id, trend);
    }
  }
  for (const trend of ranked) {
    if (selected.size >= TOTAL_TREND_LIMIT) break;
    if (selected.has(trend.id)) continue;
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
    const batch = trends.slice(0, 18).map((trend) => ({ id: trend.id, title: trend.title, category: trend.category, subcategory: trend.subcategory, phase: trend.phase, score: trend.score["30m"], activity: trend.activity, sources: trend.sources, saturation: trend.saturation, evidence: trend.evidence.slice(0, 6).map((item) => `${item.source}: ${item.title} — ${item.detail}`) }));
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
              id: { type: "string" }, title: { type: "string", maxLength: 42 }, category: { type: "string", enum: categoryNames }, subcategory: { type: "string", enum: subcategoryNames }, summary: { type: "string", maxLength: 320 }, forecast: { type: "string", maxLength: 220 }, forecastTime: { type: "string" }, signals: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
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
          { role: "system", content: "You are Front Run's animal-news editor. Every supplied signal is an animal story. Write a punchy 2–5 word trend name (maximum 42 characters) centered on the named animal, species, zoo baby, rescue or memorable hook—not the full publisher headline. Prefer names like ‘Moo Deng’s New Moment’ or ‘Jimothy the Raccoon,’ never sentence fragments. Write a factual one- or two-sentence summary explaining what happened and why the animal is drawing attention. Keep category Animals and choose only the best supplied animal subcategory. Forecast the next likely attention event: a follow-up clip, official update, news pickup, remix wave or fade. Never invent facts, counts, sources, quotes, links or identities; only use supplied evidence. Treat source activity values as non-comparable observations." },
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
      const validSubcategory = TREND_TAXONOMY[0].subcategories.some((subcategory) => subcategory === analysis.subcategory);
      const subcategory = validSubcategory ? analysis.subcategory : trend.subcategory;
      return { ...trend, title: shortTrendTitle(analysis.title), category: "Animals", subcategory, summary: analysis.summary.trim(), forecast: analysis.forecast.trim(), forecastTime: analysis.forecastTime, signals: analysis.signals, tone: toneFor("Animals") };
    });
    return { trends: enriched, mode: "openai", status: { key: "analysis", label: "Animal forecast", state: "live", detail: `${runtime.OPENAI_MODEL || "gpt-5.6-luna"} animal names, summaries and structured forecasts`, itemCount: Math.min(18, trends.length) } };
  } catch (error) {
    return { trends, mode: "heuristic", status: { key: "analysis", label: "AI forecast", state: "error", detail: `Heuristic fallback · ${errorMessage(error)}`, itemCount: 0 } };
  }
}

export async function buildTrendsPayload(history: Map<string, HistoricalSnapshot[]> = new Map(), options: BuildTrendsOptions = {}): Promise<TrendsPayload> {
  const publicCollectors = await Promise.all([collectGoogleTrends(), collectGoogleNews(), collectPublisherNews(), collectYouTube()]);
  const x = await collectX(publicCollectors.flatMap((collector) => collector.items), options);
  const coreCollectors = [...publicCollectors, x];
  const tiktok = await collectTikTok(coreCollectors.flatMap((collector) => collector.items));
  const collectors = [...coreCollectors, tiktok];
  const allItems = collectors.flatMap((collector) => collector.items);
  const clustered = clusterCandidates(allItems);
  const model = await enrichWithOpenAI(clustered);
  const now = Date.now();
  const previousFirstSeen = options.previousPayload?.firstSeenMode === "detected"
    ? new Map(options.previousPayload.trends.map((trend) => [trend.id, trend.firstSeenAt]))
    : new Map<string, string | undefined>();
  const trends = model.trends.map((trend) => applyHistory(trend, history.get(trend.id) ?? [], now, previousFirstSeen.get(trend.id))).sort((a, b) => b.score["30m"] - a.score["30m"]);
  const categories = TREND_TAXONOMY.map((category) => ({
    name: category.name,
    count: trends.filter((trend) => trend.category === category.name).length,
    subcategories: category.subcategories.map((subcategory) => ({
      name: subcategory,
      count: trends.filter((trend) => trend.category === category.name && trend.subcategory === subcategory).length,
    })),
  }));
  const newsCollector = collectors.find((collector) => collector.status.key === "news");
  const publisherCollector = collectors.find((collector) => collector.status.key === "publisher");
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
  const publisherNews = [...(publisherCollector?.items ?? []), ...(newsCollector?.items ?? [])]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const newsSeen = new Set<string>();
  const uniquePublisherNews = publisherNews.filter((item) => {
    const key = normalize(item.title);
    if (newsSeen.has(key)) return false;
    newsSeen.add(key);
    return true;
  });
  const selectedNews = new Map<string, Candidate>();
  for (const item of uniquePublisherNews) {
    if (selectedNews.size >= 12) break;
    selectedNews.set(normalize(item.title), item);
  }
  const news: NewsItem[] = publisherNews.length
    ? [...selectedNews.values()].map((item) => ({ title: item.title, source: item.sourceLabel, age: ageLabel(item.publishedAt).replace(" ago", ""), url: item.url, trendId: trends.find((trend) => similar(trend.title, item.title))?.id }))
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
    firstSeenMode: "detected",
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
