import { readOrRefreshTrends } from "../../../lib/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";

  try {
    const result = await readOrRefreshTrends({ force });
    return Response.json(result.payload, { headers: { "Cache-Control": "no-store", "X-Front-Run-Storage": result.storage } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trend refresh failed";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
