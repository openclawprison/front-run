import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the Front Run animal-news dashboard and real source adapters", async () => {
  const [page, dashboard, layout, route, engine, blueprint, packageJson, cronScript, readme] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/dashboard.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/api/trends/route.ts", root), "utf8"),
    readFile(new URL("lib/trend-engine.ts", root), "utf8"),
    readFile(new URL("render.yaml", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("scripts/trigger-ingest.ts", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
  ]);

  assert.match(page, /readLatestStoredTrends/);
  assert.match(page, /initialPayload/);
  assert.match(dashboard, /FRONT RUN/);
  assert.match(dashboard, /Platform counts/);
  assert.match(dashboard, /News coverage and leading posts/);
  assert.match(dashboard, /Meet the animal/);
  assert.match(dashboard, /Latest animal news/);
  assert.match(dashboard, /All animals/);
  assert.doesNotMatch(dashboard, /Pump\.fun|memecoin|Technology watch/);
  assert.match(dashboard, /TREND_TAXONOMY/);
  assert.match(dashboard, /Newest detected/);
  assert.match(dashboard, /useState<SortMode>\("newest"\)/);
  assert.match(dashboard, /Latest source/);
  assert.match(dashboard, /github\.com\/openclawprison\/front-run/);
  assert.match(dashboard, /firstSeenAt/);
  assert.match(dashboard, /initialPayload \? new Date\(initialPayload\.refreshedAt\)\.getTime\(\) : 0/);
  assert.doesNotMatch(dashboard, /useState\(\(\) => Date\.now\(\)\)/);
  assert.doesNotMatch(dashboard, /Polar-bear rescue edits|Preview feed active/);
  assert.match(layout, /Front Run — Viral Animal News/);
  assert.match(route, /readLatestStoredTrends/);
  assert.doesNotMatch(route, /searchParams\.get\("refresh"\)/);
  assert.match(engine, /trends\.google\.com\/trending\/rss/);
  assert.match(engine, /api\.twitterapi\.io\/twitter\/tweet\/advanced_search/);
  assert.match(engine, /TWITTERAPI_MONTHLY_BUDGET_USD/);
  assert.match(engine, /scope: "sample"/);
  assert.doesNotMatch(engine, /api\.x\.com/);
  assert.match(engine, /Viral animals now/);
  assert.match(engine, /Zoo babies/);
  assert.match(engine, /Animal rescues/);
  assert.match(engine, /animalSubcategoryFor/);
  assert.match(engine, /filteredItems = items\.filter\(\(item\) => isAnimalCandidate/);
  assert.match(engine, /firstSeenMode: "detected"/);
  assert.match(engine, /National Wildlife Federation/);
  assert.match(engine, /San Diego Zoo Wildlife Alliance/);
  assert.match(engine, /Monterey Bay Aquarium/);
  assert.match(engine, /Houston Zoo/);
  assert.match(engine, /TOTAL_TREND_LIMIT = 180/);
  assert.match(engine, /sourcePriorityWeight/);
  assert.match(engine, /shortTrendTitle/);
  assert.match(engine, /leading-post links/);
  assert.match(engine, /const regions = \["US"\]/);
  assert.match(engine, /gd_lu702nij2f790tmv9h/);
  assert.match(engine, /Promise\.all\(\[collectGoogleTrends\(\), collectGoogleNews\(\), collectPublisherNews\(\), collectYouTube\(\)\]\)/);
  assert.match(blueprint, /healthCheckPath: \/api\/health/);
  assert.match(blueprint, /schedule: "\*\/5 \* \* \* \*"/);
  assert.match(blueprint, /TWITTERAPI_IO_KEY/);
  assert.match(blueprint, /TWITTERAPI_MONTHLY_BUDGET_USD/);
  assert.match(blueprint, /TWITTERAPI_SAMPLE_INTERVAL_MINUTES/);
  assert.doesNotMatch(blueprint, /PUMPFUN/);
  assert.match(blueprint, /type: cron[\s\S]*DATABASE_URL[\s\S]*fromDatabase/);
  assert.match(blueprint, /type: cron[\s\S]*TWITTERAPI_IO_KEY[\s\S]*OPENAI_API_KEY/);
  assert.match(packageJson, /tsx scripts\/trigger-ingest\.ts/);
  assert.match(cronScript, /readOrRefreshTrends/);
  assert.match(cronScript, /if \(process\.env\.DATABASE_URL\) await ingestDirectly/);
  assert.match(readme, /public\/front-run-og\.png/);
  assert.match(readme, /front-run\.onrender\.com/);
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
