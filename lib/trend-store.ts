import postgres, { type Sql } from "postgres";
import type { Trend, TrendsPayload, TimeWindow, WindowValues } from "./trend-types";

export type HistoricalSnapshot = {
  trendId: string;
  observedAt: string;
  activity: number;
  score: number;
};

export type TwitterApiMonthlyUsage = {
  billablePosts: number;
  queryCount: number;
  lastUsedAt?: string;
};

let client: Sql | null = null;

export function getTrendDatabase(): Sql | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (!client) {
    client = postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
    });
  }

  return client;
}

export async function closeTrendDatabase() {
  if (!client) return;
  await client.end({ timeout: 5 });
  client = null;
}

export async function ensureTrendTables(db: Sql) {
  await db.begin(async (sql) => {
    const tx = sql as unknown as Sql;
    await tx`CREATE TABLE IF NOT EXISTS ingestion_runs (
      id BIGSERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      payload_json JSONB,
      error TEXT
    )`;
    await tx`CREATE TABLE IF NOT EXISTS trend_snapshots (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
      trend_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      activity BIGINT NOT NULL,
      score INTEGER NOT NULL,
      phase TEXT NOT NULL,
      category TEXT NOT NULL,
      payload_json JSONB NOT NULL
    )`;
    await tx`CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status_completed ON ingestion_runs(status, completed_at DESC)`;
    await tx`CREATE INDEX IF NOT EXISTS idx_trend_snapshots_trend_time ON trend_snapshots(trend_id, observed_at DESC)`;
    await tx`CREATE INDEX IF NOT EXISTS idx_trend_snapshots_time ON trend_snapshots(observed_at DESC)`;
    await tx`CREATE TABLE IF NOT EXISTS twitterapi_usage (
      id BIGSERIAL PRIMARY KEY,
      observed_at TIMESTAMPTZ NOT NULL,
      query_count INTEGER NOT NULL,
      billable_posts INTEGER NOT NULL
    )`;
    await tx`CREATE INDEX IF NOT EXISTS idx_twitterapi_usage_time ON twitterapi_usage(observed_at DESC)`;
  });
}

export async function getTwitterApiMonthlyUsage(db: Sql, now = new Date()): Promise<TwitterApiMonthlyUsage> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db<{ billable_posts: string | number; query_count: string | number; last_used_at: string | null }[]>`
    SELECT
      COALESCE(SUM(billable_posts), 0) AS billable_posts,
      COALESCE(SUM(query_count), 0) AS query_count,
      MAX(observed_at) AS last_used_at
    FROM twitterapi_usage
    WHERE observed_at >= ${monthStart}
  `;
  const row = rows[0];
  return {
    billablePosts: Number(row?.billable_posts ?? 0),
    queryCount: Number(row?.query_count ?? 0),
    lastUsedAt: row?.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
  };
}

export async function recordTwitterApiUsage(db: Sql, billablePosts: number, queryCount: number, observedAt = new Date()) {
  if (billablePosts <= 0 || queryCount <= 0) return;
  await db`
    INSERT INTO twitterapi_usage (observed_at, query_count, billable_posts)
    VALUES (${observedAt}, ${queryCount}, ${billablePosts})
  `;
}

export async function getCachedPayload(db: Sql, maxAgeMs: number): Promise<TrendsPayload | null> {
  const rows = await db<{ completed_at: string; payload_json: TrendsPayload }[]>`
    SELECT completed_at, payload_json
    FROM ingestion_runs
    WHERE status = 'success' AND payload_json IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || Date.now() - new Date(row.completed_at).getTime() > maxAgeMs) return null;
  return row.payload_json;
}

export async function getRecentHistory(db: Sql): Promise<Map<string, HistoricalSnapshot[]>> {
  const since = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const rows = await db<{ trend_id: string; observed_at: string; activity: string | number; score: number }[]>`
    SELECT trend_id, observed_at, activity, score
    FROM trend_snapshots
    WHERE observed_at >= ${since}
    ORDER BY observed_at DESC
    LIMIT 80000
  `;

  const grouped = new Map<string, HistoricalSnapshot[]>();
  for (const row of rows) {
    const entries = grouped.get(row.trend_id) ?? [];
    entries.push({ trendId: row.trend_id, observedAt: new Date(row.observed_at).toISOString(), activity: Number(row.activity), score: row.score });
    grouped.set(row.trend_id, entries);
  }
  return grouped;
}

export function applyHistory(trend: Trend, history: HistoricalSnapshot[], now = Date.now()): Trend {
  const windows: Record<TimeWindow, number> = { "5m": 5, "30m": 30, "60m": 60, "6h": 360, "24h": 1440 };
  const growth = {} as WindowValues;
  const mentions = {} as WindowValues;
  const score = {} as WindowValues;

  for (const [windowKey, minutes] of Object.entries(windows) as [TimeWindow, number][]) {
    const target = now - minutes * 60_000;
    const eligible = history.filter((point) => new Date(point.observedAt).getTime() <= target + Math.min(150_000, minutes * 15_000));
    const prior = eligible.sort((a, b) => Math.abs(new Date(a.observedAt).getTime() - target) - Math.abs(new Date(b.observedAt).getTime() - target))[0];

    if (!prior) {
      growth[windowKey] = 0;
      mentions[windowKey] = trend.activity;
      score[windowKey] = trend.score["30m"];
      continue;
    }

    const change = prior.activity > 0 ? ((trend.activity - prior.activity) / prior.activity) * 100 : 0;
    growth[windowKey] = Math.max(-100, Math.min(999, Math.round(change)));
    mentions[windowKey] = Math.max(0, trend.activity - prior.activity) || trend.activity;
    score[windowKey] = Math.max(1, Math.min(99, Math.round(trend.score["30m"] + change * 0.08)));
  }

  const historyPoints = history.length;
  const recentGrowth = growth["30m"];
  let phase = trend.phase;
  if (historyPoints > 0) {
    if (recentGrowth < -12) phase = "Cooling";
    else if (recentGrowth > 35 && trend.saturation < 45) phase = "Igniting";
    else if (recentGrowth > 8) phase = "Accelerating";
    else if (trend.saturation > 68) phase = "Peaking";
  }

  const confidence = Math.min(97, trend.confidence + Math.min(12, historyPoints * 2));
  const firstSeenTimes = [trend.firstSeenAt, ...history.map((point) => point.observedAt)]
    .map((value) => new Date(value ?? "").getTime())
    .filter(Number.isFinite);
  const firstSeenTime = firstSeenTimes.length ? Math.min(...firstSeenTimes) : now;
  const firstSeenMinutes = Math.max(0, Math.round((now - firstSeenTime) / 60_000));
  const firstSeen = firstSeenMinutes < 2
    ? "just now"
    : firstSeenMinutes < 60
      ? `${firstSeenMinutes}m ago`
      : firstSeenMinutes < 1440
        ? `${Math.floor(firstSeenMinutes / 60)}h ${firstSeenMinutes % 60}m ago`
        : `${Math.floor(firstSeenMinutes / 1440)}d ago`;
  return { ...trend, phase, growth, mentions, score, historyPoints, confidence, firstSeen, firstSeenAt: new Date(firstSeenTime).toISOString() };
}

export async function persistPayload(db: Sql, payload: TrendsPayload) {
  await db.begin(async (sql) => {
    const tx = sql as unknown as Sql;
    const rows = await tx<{ id: string | number }[]>`
      INSERT INTO ingestion_runs (started_at, completed_at, status, item_count, payload_json)
      VALUES (${payload.refreshedAt}, ${payload.refreshedAt}, 'success', ${payload.trends.length}, ${tx.json(payload)})
      RETURNING id
    `;
    const runId = Number(rows[0].id);

    for (const trend of payload.trends) {
      await tx`
        INSERT INTO trend_snapshots (run_id, trend_id, observed_at, activity, score, phase, category, payload_json)
        VALUES (${runId}, ${trend.id}, ${payload.refreshedAt}, ${trend.activity}, ${trend.score["30m"]}, ${trend.phase}, ${trend.category}, ${tx.json(trend)})
      `;
    }

    const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await tx`DELETE FROM ingestion_runs WHERE started_at < ${cutoff}`;
  });
}
