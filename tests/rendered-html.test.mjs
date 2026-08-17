import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the Front Run live dashboard and real source adapters", async () => {
  const [page, layout, route, engine, blueprint] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/api/trends/route.ts", root), "utf8"),
    readFile(new URL("lib/trend-engine.ts", root), "utf8"),
    readFile(new URL("render.yaml", root), "utf8"),
  ]);

  assert.match(page, /FRONT RUN/);
  assert.match(page, /Platform counts/);
  assert.match(page, /TREND_TAXONOMY/);
  assert.doesNotMatch(page, /Polar-bear rescue edits|Preview feed active/);
  assert.match(layout, /Front Run — Early Signal Intelligence/);
  assert.match(route, /readOrRefreshTrends/);
  assert.match(engine, /trends\.google\.com\/trending\/rss/);
  assert.match(engine, /api\.x\.com\/2\/tweets\/counts\/recent/);
  assert.match(engine, /23424977/);
  assert.match(engine, /const regions = \["US"\]/);
  assert.match(engine, /gd_lu702nij2f790tmv9h/);
  assert.match(blueprint, /healthCheckPath: \/api\/health/);
  assert.match(blueprint, /schedule: "\*\/5 \* \* \* \*"/);
});

test("includes Render, storage, environment, and preview assets", async () => {
  await Promise.all([
    access(new URL("render.yaml", root)),
    access(new URL("app/api/health/route.ts", root)),
    access(new URL("app/api/ingest/route.ts", root)),
    access(new URL("public/front-run-og.png", root)),
    access(new URL(".env.example", root)),
  ]);
});
