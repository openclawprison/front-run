import { getTrendDatabase } from "../../../lib/trend-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = getTrendDatabase();
  if (!db) return Response.json({ status: "ok", storage: "ephemeral" });

  try {
    await db`SELECT 1`;
    return Response.json({ status: "ok", storage: "postgres" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database unavailable";
    return Response.json({ status: "degraded", storage: "postgres", error: message }, { status: 503 });
  }
}
