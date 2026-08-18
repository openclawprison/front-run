import { readOrRefreshTrends } from "../lib/ingest";
import { closeTrendDatabase } from "../lib/trend-store";

const publicUrl = process.env.FRONT_RUN_URL;
const secret = process.env.INGEST_SECRET;
const transientStatuses = new Set([429, 502, 503, 504]);

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function ingestDirectly() {
  try {
    const result = await readOrRefreshTrends({ force: true });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "direct",
      refreshedAt: result.payload.refreshedAt,
      trends: result.payload.trends.length,
      storage: result.storage,
    })}\n`);
  } finally {
    await closeTrendDatabase();
  }
}

async function triggerWebIngestion() {
  if (!publicUrl || !secret) {
    throw new Error("DATABASE_URL is preferred; FRONT_RUN_URL and INGEST_SECRET are required for HTTP fallback");
  }

  const endpoint = `${publicUrl.replace(/\/$/, "")}/api/ingest`;
  const delays = [0, 5_000, 15_000, 30_000];
  let lastError: unknown;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await wait(delays[attempt]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 210_000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        signal: controller.signal,
      });
      const body = await response.text();
      if (response.ok) {
        process.stdout.write(`${body}\n`);
        return;
      }

      const message = `Ingestion returned ${response.status}: ${body || "empty response"}`;
      if (!transientStatuses.has(response.status) || attempt === delays.length - 1) throw new Error(message);
      lastError = new Error(message);
      process.stderr.write(`${message}; retrying (${attempt + 2}/${delays.length})\n`);
    } catch (error) {
      lastError = error;
      if (attempt === delays.length - 1) throw error;
      process.stderr.write(`Ingestion request failed; retrying (${attempt + 2}/${delays.length})\n`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Ingestion failed after retries");
}

if (process.env.DATABASE_URL) await ingestDirectly();
else await triggerWebIngestion();
