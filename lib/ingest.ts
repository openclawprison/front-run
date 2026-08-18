import { buildTrendsPayload } from "./trend-engine";
import { ensureTrendTables, getCachedPayload, getRecentHistory, getTrendDatabase, getTwitterApiMonthlyUsage, persistPayload, recordTwitterApiUsage } from "./trend-store";
import type { TrendsPayload } from "./trend-types";

const CACHE_MAX_AGE_MS = 4 * 60_000;
const MANUAL_REFRESH_FLOOR_MS = 60_000;
let refreshInFlight: Promise<TrendsPayload> | null = null;

export async function readLatestStoredTrends(): Promise<TrendsPayload | null> {
  const db = getTrendDatabase();
  if (!db) return null;
  await ensureTrendTables(db);
  return getCachedPayload(db, Number.POSITIVE_INFINITY);
}

export async function readOrRefreshTrends(options: { force?: boolean } = {}): Promise<{ payload: TrendsPayload; storage: "postgres" | "ephemeral" }> {
  const db = getTrendDatabase();
  if (!db) {
    return { payload: await buildTrendsPayload(), storage: "ephemeral" };
  }

  await ensureTrendTables(db);
  const cacheAge = options.force ? MANUAL_REFRESH_FLOOR_MS : CACHE_MAX_AGE_MS;
  const cached = await getCachedPayload(db, cacheAge);
  if (cached) return { payload: cached, storage: "postgres" };

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const [history, previousPayload, twitterApiUsage] = await Promise.all([
        getRecentHistory(db),
        getCachedPayload(db, Number.POSITIVE_INFINITY),
        getTwitterApiMonthlyUsage(db),
      ]);
      const payload = await buildTrendsPayload(history, {
        previousPayload,
        twitterApiUsage,
        recordTwitterApiUsage: (billablePosts, queryCount) => recordTwitterApiUsage(db, billablePosts, queryCount),
      });
      await persistPayload(db, payload);
      return payload;
    })().finally(() => {
      refreshInFlight = null;
    });
  }

  return { payload: await refreshInFlight, storage: "postgres" };
}
