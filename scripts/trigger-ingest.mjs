const hostport = process.env.FRONT_RUN_HOSTPORT;
const publicUrl = process.env.FRONT_RUN_URL;
const secret = process.env.INGEST_SECRET;

if ((!hostport && !publicUrl) || !secret) {
  throw new Error("FRONT_RUN_HOSTPORT (or FRONT_RUN_URL) and INGEST_SECRET are required");
}

const baseUrl = publicUrl || `http://${hostport}`;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120_000);

try {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal: controller.signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Ingestion returned ${response.status}: ${body}`);
  process.stdout.write(`${body}\n`);
} finally {
  clearTimeout(timeout);
}
