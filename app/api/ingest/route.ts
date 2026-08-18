import { timingSafeEqual } from "node:crypto";
import { readOrRefreshTrends } from "../../../lib/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(request: Request) {
  const secret = process.env.INGEST_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || secret.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(secret), Buffer.from(supplied));
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await readOrRefreshTrends({ force: true });
    return Response.json({ ok: true, refreshedAt: result.payload.refreshedAt, trends: result.payload.trends.length, storage: result.storage });
  } catch (error) {
    console.error("Protected ingestion failed", error);
    return Response.json({ error: "Ingestion failed" }, { status: 502 });
  }
}
