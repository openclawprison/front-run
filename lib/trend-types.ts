export type TimeWindow = "5m" | "30m" | "60m" | "6h" | "24h";
export type Phase = "Igniting" | "Accelerating" | "Peaking" | "Cooling";
export type WindowValues = Record<TimeWindow, number>;

export const TREND_TAXONOMY = [
  {
    name: "Animals",
    subcategories: [
      "Viral animals",
      "Zoo babies",
      "Rescues",
      "Cats",
      "Dogs",
      "Bears",
      "Birds",
      "Marine life",
      "Primates",
      "Reptiles",
      "Farm animals",
      "Endangered",
      "Wildlife",
    ],
  },
] as const;

export type TrendEvidence = {
  source: string;
  title: string;
  url: string;
  detail: string;
};

export type PlatformMetric = {
  label: string;
  metric: "posts";
  scope: "exact" | "sample";
  windows: WindowValues;
  detail: string;
  observedAt?: string;
};

export type Trend = {
  id: string;
  title: string;
  url: string;
  category: string;
  subcategory: string;
  mark: string;
  phase: Phase;
  score: WindowValues;
  growth: WindowValues;
  mentions: WindowValues;
  spark: number[];
  sources: Record<string, number>;
  platforms: Record<string, PlatformMetric>;
  firstSeen: string;
  firstSeenAt?: string;
  latestSourceAt?: string;
  geography: string;
  forecast: string;
  forecastTime: string;
  confidence: number;
  summary: string;
  signals: string[];
  tags: string[];
  saturation: number;
  tone: string;
  activity: number;
  historyPoints: number;
  evidence: TrendEvidence[];
};

export type SourceState = "live" | "needs-key" | "restricted" | "error";

export type SourceStatus = {
  key: string;
  label: string;
  state: SourceState;
  detail: string;
  itemCount: number;
};

export type NewsItem = {
  title: string;
  source: string;
  age: string;
  url: string;
  trendId?: string;
};

// Kept as internal adapter shapes so older stored snapshots can still be read
// during an animal-only deployment rollover. They are no longer in TrendsPayload.
export type PumpCoinBucket = "Trending now" | "Movers";

export type PumpCoin = {
  mint: string;
  name: string;
  symbol: string;
  url: string;
  imageUrl?: string;
  description: string;
  bucket: PumpCoinBucket;
  rank: number;
  marketCapUsd: number;
  createdAt?: string;
  score: WindowValues;
  xPosts?: WindowValues;
  summary: string;
  sourceLabel: string;
  sourceUrl: string;
  relatedTrendId?: string;
  relatedTrendTitle?: string;
  evidence: TrendEvidence[];
};

export type TrendCategorySummary = {
  name: string;
  count: number;
  subcategories: Array<{ name: string; count: number }>;
};

export type TrendsPayload = {
  product: "Front Run";
  firstSeenMode?: "detected";
  refreshedAt: string;
  nextRefreshAt: string;
  analysisMode: "openai" | "heuristic";
  historyDepth: number;
  trends: Trend[];
  categories: TrendCategorySummary[];
  news: NewsItem[];
  sources: SourceStatus[];
};
