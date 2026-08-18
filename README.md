# Front Run

Front Run is a live early-signal dashboard for finding internet trends before they saturate. It ranks clustered observations across 5-minute, 30-minute, 60-minute, 6-hour, and 24-hour windows, stores each collection run in Postgres, and estimates whether a signal is igniting, accelerating, peaking, or cooling.

Front Run's main ranking tracks internet trends. A separate Pump.fun attention radar shows what that platform is surfacing and attempts to trace each listing back to X, news, or an existing Front Run narrative. Coin activity is never mixed into the main trend score and is not a recommendation to buy.

Each ingestion keeps up to 250 ranked signals, reserving at least 40 and capping around 50 places for Animals, 18 for current individual Memes, and 20 for Technology. Animal coverage is balanced across cats, dogs, bears, birds, marine life, wildlife, and zoo stories. Meme roundup and listicle pages are excluded so the meme section stays focused on specific formats and characters moving now.

## What is real data

Front Run never invents platform counts. Each connector reports its own metric and availability:

- Google Trends RSS: breakout searches and approximate search traffic
- Google News RSS: US top stories plus dedicated Animals, Technology, and Viral searches
- Know Your Meme: newest encyclopedia entries plus Trending, Updated, and Researching surfaces; the highest-priority names are cross-checked on X
- Direct publisher feeds: NPR, CBS News, The New York Times, The Verge, TechCrunch, WIRED, Mongabay, Catster, Smithsonian Science & Nature, Audubon, the National Wildlife Federation, Houston Zoo, Woodland Park Zoo, Zoo Atlanta, Denver Zoo, Lincoln Park Zoo, and Phoenix Zoo
- Hacker News API: points and discussion activity
- X API v2: Trends by WOEID, news-led exact post counts, and direct links to leading public posts
- YouTube Data API: popular-video views and view velocity
- TikTok through Bright Data: sampled keyword-matched posts, plays, shares, and comments
- Pump.fun: featured coins and leading Movers from the public Explore surface, plus creator-linked source metadata
- OpenAI Responses API: classification and trajectory copy only; the model cannot alter source counts

TikTok values are explicitly marked as a sample because keyword discovery does not expose the total TikTok firehose. X values from the recent-count endpoint are marked as official counts. If a key is missing or a provider fails, the source is shown as unavailable instead of being simulated.

## Render architecture

- Next.js Node web service
- Render Postgres for cached payloads and rolling trend snapshots
- Render Cron Job that calls the protected ingestion endpoint every five minutes
- `render.yaml` Blueprint for the web service, database, health check, secret wiring, and cron schedule

The public dashboard server-renders the latest stored payload, so trends remain visible during reloads and while the next collection is running. The client checks for an updated payload every five minutes. Collection is single-flight inside each server instance, and manual refreshes have a one-minute floor to prevent API-cost abuse.

## Environment variables

Copy `.env.example` to `.env.local` for local development. Never commit real keys.

Required for persistent production history:

- `DATABASE_URL`
- `INGEST_SECRET`

Optional data providers:

- `X_BEARER_TOKEN`, `X_WOEIDS`, `X_COUNT_ENRICH_LIMIT`, `X_POSTS_PER_TREND`
- `PUMPFUN_LIMIT`, `PUMPFUN_ENRICH_LIMIT`, `PUMPFUN_X_ENRICH_LIMIT` (no Pump.fun key required)
- `YOUTUBE_API_KEY`, `YOUTUBE_REGIONS`
- `BRIGHTDATA_API_TOKEN`, `TIKTOK_QUERY_LIMIT`, `TIKTOK_POSTS_PER_QUERY`, `TIKTOK_SEED_QUERIES`
- `OPENAI_API_KEY`, `OPENAI_MODEL`

The free public Google and Hacker News feeds work without credentials.

## Pump.fun radar

The Pump.fun connector reads the platform's public Explore page, follows the public coin metadata for the leading listings, and then uses the configured X API key to measure exact recent-post windows for a limited number of those coins. It labels creator-provided X and website links as unverified metadata. A stronger source label appears only when the narrative matches independent Front Run news/trend evidence.

The Pump attention score combines the platform's displayed position, X discussion, external-source availability, and independent narrative crossover. It does not measure token safety, liquidity quality, holder concentration, or expected return.

## Local development

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. Without `DATABASE_URL`, the API runs in explicit ephemeral mode. With Postgres configured, tables are created automatically.

Checks:

```bash
npm run lint
npm test
```

Health endpoint: `/api/health`

Normalized trend feed: `/api/trends`

Protected scheduled ingestion: `POST /api/ingest` with `Authorization: Bearer <INGEST_SECRET>`

## Deploy with Render Blueprint

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and connect the repository.
3. Render detects `render.yaml` and creates `front-run`, `front-run-db`, and `front-run-ingest`.
4. Enter the optional provider secrets when prompted. Leave out providers you do not use.
5. Apply the Blueprint and wait for the web health check to pass.
6. Open the cron job and choose **Trigger Run** once so the first stored baseline exists immediately.

The Blueprint uses a free web service and free Postgres for initial testing. Render's free Postgres instances expire after 30 days; switch the database plan before using Front Run as a durable production tracker. Render Cron Jobs have a small minimum monthly charge.

## TikTok configuration

Front Run uses Bright Data's TikTok “Discover posts by keyword” dataset (`gd_lu702nij2f790tmv9h`). Each run searches half of the query budget against current Google/X leaders and uses the remainder for configurable native TikTok seed phrases. This gives cross-platform confirmation and a limited native-discovery lane without pretending to have complete TikTok volume.

Set:

```bash
BRIGHTDATA_API_TOKEN=...
TIKTOK_QUERY_LIMIT=6
TIKTOK_POSTS_PER_QUERY=20
TIKTOK_SEED_QUERIES=america viral,usa meme,usa challenge
```

Keep the query and post limits conservative until you understand your provider billing.

## Scoring

1. Connectors emit normalized observations with source-native metrics and timestamps.
2. Related titles are clustered using token overlap.
3. The base viral score combines relative strength, freshness, source diversity, and saturation. Source priority is X first, Know Your Meme for meme discovery, direct publishers/news next, and Google Trends as the lowest-weight early-search hint.
4. Postgres snapshots supply observed velocity for all five time windows.
5. Stored velocity adjusts lifecycle phase and confidence.
6. If OpenAI is configured, structured output improves the written classification and forecast. Deterministic heuristics remain the fallback.

Zero velocity means Front Run has its first snapshot but not yet an older comparison point for that window.
