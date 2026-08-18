import Dashboard from "./dashboard";
import { readLatestStoredTrends } from "../lib/ingest";
import type { TrendsPayload } from "../lib/trend-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Page() {
  let initialPayload: TrendsPayload | null = null;
  try {
    initialPayload = await readLatestStoredTrends();
  } catch {
    // The client can still connect directly if storage is temporarily unavailable.
  }
  return <Dashboard initialPayload={initialPayload} />;
}
