import { readLatestStoredTrends, readOrRefreshTrends } from "../../../lib/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const stored = await readLatestStoredTrends();
    if (stored) {
      return Response.json(stored, { headers: { "Cache-Control": "no-store", "X-Front-Run-Storage": "postgres" } });
    }

    if (process.env.DATABASE_URL) {
      return Response.json({ error: "Trend baseline unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    const result = await readOrRefreshTrends();
    return Response.json(result.payload, { headers: { "Cache-Control": "no-store", "X-Front-Run-Storage": result.storage } });
  } catch (error) {
    console.error("Trend feed read failed", error);
    return Response.json({ error: "Trend feed unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
