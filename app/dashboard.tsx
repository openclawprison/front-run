"use client";

import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Coins,
  Cpu,
  ExternalLink,
  Flame,
  Gauge,
  Globe2,
  LayoutGrid,
  Laugh,
  LoaderCircle,
  Newspaper,
  PawPrint,
  RefreshCw,
  Search,
  Sparkles,
  Telescope,
  TrendingDown,
  TrendingUp,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TREND_TAXONOMY } from "../lib/trend-types";
import type { Phase, PumpCoin, TimeWindow, Trend, TrendsPayload } from "../lib/trend-types";

const timeWindows: { key: TimeWindow; label: string }[] = [
  { key: "5m", label: "5 min" },
  { key: "30m", label: "30 min" },
  { key: "60m", label: "60 min" },
  { key: "6h", label: "6 hours" },
  { key: "24h", label: "24 hours" },
];

type SortMode = "viral" | "newest" | "oldest";

const firstSeenValue = (trend: Trend, fallback: number) => {
  const timestamp = new Date(trend.firstSeenAt ?? "").getTime();
  if (Number.isFinite(timestamp)) return timestamp;
  const minutes = Number(trend.firstSeen.match(/^(\d+)m/)?.[1] ?? 0);
  const hours = Number(trend.firstSeen.match(/^(\d+)h/)?.[1] ?? 0);
  const days = Number(trend.firstSeen.match(/^(\d+)d/)?.[1] ?? 0);
  return fallback - (days * 1440 + hours * 60 + minutes) * 60_000;
};

const categoryIcons = { Memes: Laugh, Animals: PawPrint, Technology: Cpu, News: Newspaper, "Viral events": Zap, "Internet culture": Sparkles, Entertainment: CircleDot, Sports: Activity, "Food & drink": Waves };
const categories = [
  { name: "All trends", icon: LayoutGrid, subs: [] as string[] },
  ...TREND_TAXONOMY.map((category) => ({ name: category.name, icon: categoryIcons[category.name], subs: [...category.subcategories] })),
];

const formatNumber = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString();
};

const platformActivityLabel = (trend: Trend, window: TimeWindow) => {
  const values = Object.entries(trend.platforms ?? {});
  if (!values.length) return formatNumber(trend.mentions[window]);
  return values.map(([key, metric]) => `${key === "x" ? "X" : "TT"} ${formatNumber(metric.windows[window])}${metric.scope === "sample" ? "*" : ""}`).join(" / ");
};

const coinAge = (coin: PumpCoin, now: number) => {
  if (!coin.createdAt) return "Age unavailable";
  const minutes = Math.max(0, Math.floor((now - new Date(coin.createdAt).getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m old`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h old`;
  return `${Math.floor(minutes / 1440)}d old`;
};

function SparkBars({ values, phase, large = false }: { values: number[]; phase: Phase; large?: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div className={`spark-bars ${large ? "spark-bars-large" : ""}`} aria-label={`Momentum chart: ${phase}`}>
      {values.map((value, index) => (
        <span key={`${value}-${index}`} className={index === values.length - 1 ? "spark-current" : ""} style={{ height: `${Math.max(10, value / max * 100)}%` }} />
      ))}
    </div>
  );
}

function PhasePill({ phase }: { phase: Phase }) {
  const Icon = phase === "Cooling" ? TrendingDown : phase === "Peaking" ? Gauge : TrendingUp;
  return <span className={`phase-pill phase-${phase.toLowerCase()}`}><Icon size={13} strokeWidth={2.2} />{phase}</span>;
}

function ScoreRing({ value, compact = false }: { value: number; compact?: boolean }) {
  return (
    <div className={`score-ring ${compact ? "score-ring-compact" : ""}`} style={{ "--score": `${value * 3.6}deg` } as React.CSSProperties}>
      <span>{value}</span>
    </div>
  );
}

export default function Dashboard({ initialPayload }: { initialPayload: TrendsPayload | null }) {
  const [payload, setPayload] = useState<TrendsPayload | null>(initialPayload);
  const [activeWindow, setActiveWindow] = useState<TimeWindow>("30m");
  const [category, setCategory] = useState("All trends");
  const [subcategory, setSubcategory] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>("Animals");
  const [query, setQuery] = useState("");
  const [acceleratingOnly, setAcceleratingOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("viral");
  const [selectedTrend, setSelectedTrend] = useState<Trend | null>(null);
  const [watching, setWatching] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(!initialPayload);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => initialPayload ? new Date(initialPayload.refreshedAt).getTime() : 0);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadTrends = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    else if (!initialPayload) setLoading(true);
    setError(null);
    try {
      const response = await fetch(force ? "/api/trends?refresh=1" : "/api/trends", { cache: "no-store" });
      const body = await response.json() as TrendsPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || "Live sources did not respond");
      setPayload(body);
      setSelectedTrend((current) => current ? body.trends.find((trend) => trend.id === current.id) ?? null : null);
      setClock(Date.now());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not refresh live trends");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [initialPayload]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void loadTrends(false), 0);
    const refreshTimer = window.setInterval(() => void loadTrends(false), 5 * 60_000);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [loadTrends]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedTrend(null);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const trends = useMemo(() => payload?.trends ?? [], [payload]);
  const visibleTrends = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const fallbackTime = payload ? new Date(payload.refreshedAt).getTime() : 0;
    return [...trends]
      .filter((trend) => category === "All trends" || trend.category === category)
      .filter((trend) => !subcategory || trend.subcategory === subcategory)
      .filter((trend) => !acceleratingOnly || trend.phase === "Igniting" || trend.phase === "Accelerating")
      .filter((trend) => !normalizedQuery || [trend.title, trend.category, trend.subcategory, ...trend.tags].join(" ").toLowerCase().includes(normalizedQuery))
      .sort((a, b) => {
        if (sortMode === "newest") return firstSeenValue(b, fallbackTime) - firstSeenValue(a, fallbackTime) || b.score[activeWindow] - a.score[activeWindow];
        if (sortMode === "oldest") return firstSeenValue(a, fallbackTime) - firstSeenValue(b, fallbackTime) || b.score[activeWindow] - a.score[activeWindow];
        return b.score[activeWindow] - a.score[activeWindow] || firstSeenValue(b, fallbackTime) - firstSeenValue(a, fallbackTime);
      });
  }, [activeWindow, acceleratingOnly, category, payload, query, sortMode, subcategory, trends]);

  const headlineTrends = visibleTrends.slice(0, 3);
  const pumpCoins = useMemo(() => [...(payload?.pumpCoins ?? [])].sort((a, b) => b.score[activeWindow] - a.score[activeWindow]), [activeWindow, payload?.pumpCoins]);
  const categoryLabel = subcategory ?? category;
  const ignitingCount = visibleTrends.filter((trend) => trend.phase === "Igniting").length;
  const acceleratingCount = visibleTrends.filter((trend) => trend.phase === "Accelerating").length;
  const coolingCount = visibleTrends.filter((trend) => trend.phase === "Cooling").length;
  const liveSourceCount = payload?.sources.filter((source) => source.state === "live" && source.key !== "analysis").length ?? 0;
  const disconnectedSources = payload?.sources.filter((source) => source.state === "needs-key" && source.key !== "analysis").map((source) => source.label) ?? [];
  const analysisStatus = payload?.sources.find((source) => source.key === "analysis");
  const elapsed = payload ? Math.max(0, Math.floor((clock - new Date(payload.refreshedAt).getTime()) / 1000)) : 0;

  const selectCategory = (name: string) => {
    setCategory(name);
    setSubcategory(null);
    setExpandedCategory((current) => current === name ? null : name);
  };

  const toggleWatch = (id: string) => {
    setWatching((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openNewsItem = (url: string, trendId?: string) => {
    const trend = trendId ? trends.find((candidate) => candidate.id === trendId) : null;
    if (trend) setSelectedTrend(trend);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="app-shell" data-feed-mode="server-persisted">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><Telescope size={18} /></div>
          <div><div className="brand-name">FRONT RUN</div><div className="brand-sub">Early signal intelligence</div></div>
        </div>

        <nav className="side-nav" aria-label="Trend categories">
          <p className="nav-label">Discover</p>
          {categories.map((item) => {
            const Icon = item.icon;
            const isActive = category === item.name;
            const isExpanded = expandedCategory === item.name;
            const summary = payload?.categories?.find((candidate) => candidate.name === item.name);
            const count = item.name === "All trends" ? trends.length : summary?.count ?? trends.filter((trend) => trend.category === item.name).length;
            return (
              <div className="nav-group" key={item.name}>
                <button className={`nav-item ${isActive ? "is-active" : ""}`} onClick={() => selectCategory(item.name)}>
                  <Icon size={17} /><span className="nav-title">{item.name}<small>{count}</small></span>
                  {item.subs.length > 0 && (isExpanded ? <ChevronDown className="nav-chevron" size={14} /> : <ChevronRight className="nav-chevron" size={14} />)}
                </button>
                {item.subs.length > 0 && isExpanded && (
                  <div className="subnav">
                    {item.subs.map((sub) => (
                      <button key={sub} className={subcategory === sub ? "is-active" : ""} onClick={() => { setCategory(item.name); setSubcategory(sub); }}>
                        {sub}<span>{(summary?.subcategories.find((candidate) => candidate.name === sub)?.count ?? trends.filter((trend) => trend.category === item.name && trend.subcategory === sub).length) || "·"}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="coverage-card" title={payload?.sources.map((source) => `${source.label}: ${source.detail}`).join("\n")}>
            <div className="coverage-head"><Globe2 size={15} /> Live coverage</div>
            <strong>{liveSourceCount} measured surfaces</strong>
            <p>{payload?.sources.filter((source) => source.state === "live" && source.key !== "analysis").map((source) => source.label).join(", ") || "Connecting live sources…"}</p>
            <div className="coverage-status"><span className={error ? "status-error" : ""} /> {error ? "Feed issue" : payload?.historyDepth ? `${payload.historyDepth} history points` : "Building baseline"}</div>
          </div>
          <button className="watchlist-button"><Bell size={16} /> Watched signals <span>{watching.size}</span></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><Telescope size={17} /><span>FRONT RUN</span></div>
          <label className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a trend, subject or phrase" aria-label="Search trends" /><kbd>Ctrl K</kbd></label>
          <div className="top-status"><span className={`status-dot ${error ? "status-error" : ""}`} /> {payload ? `Synced ${elapsed}s ago` : "Connecting"}</div>
          <button className="icon-button" aria-label="Refresh live trends" onClick={() => void loadTrends(true)} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={18} /></button>
          <div className="profile-chip">FR</div>
        </header>

        <div className="content-wrap">
          <section className="page-intro">
            <div><div className="eyebrow"><Flame size={14} /> Live signal board</div><h1>Catch the story<br />before it becomes the story.</h1><p>Measured momentum, source crossover and lifecycle forecasts for what the internet is moving toward next.</p></div>
            <div className="intro-stats" aria-label="Trend status summary">
              <div><span>Igniting</span><strong>{ignitingCount}</strong><small>early breakouts</small></div>
              <div><span>Accelerating</span><strong>{acceleratingCount}</strong><small>gaining breadth</small></div>
              <div><span>Cooling</span><strong>{coolingCount}</strong><small>losing energy</small></div>
            </div>
          </section>

          {error && <div className="feed-notice feed-error"><span>{error}</span><button onClick={() => void loadTrends(true)}>Try again</button></div>}
          {payload && (disconnectedSources.length > 0 || analysisStatus?.state === "error") && (
            <div className="feed-notice"><span>{disconnectedSources.length ? `Optional feeds not connected: ${disconnectedSources.join(" and ")}. ` : ""}{analysisStatus?.state === "error" ? "OpenAI analysis is temporarily using the built-in fallback." : "All connected feeds are active."}</span><span className="model-mode">Forecast: {payload.analysisMode}</span></div>
          )}

          <section className="control-rail" aria-label="Trend time window">
            <div className="time-tabs">{timeWindows.map((window) => <button key={window.key} className={activeWindow === window.key ? "is-active" : ""} onClick={() => setActiveWindow(window.key)}>{window.label}</button>)}</div>
            <div className="rail-actions">
              <label className="sort-control"><span>Sort</span><select aria-label="Sort trends" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="viral">Viral score</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select><ChevronDown size={13} /></label>
              <label className="switch-control"><input type="checkbox" checked={acceleratingOnly} onChange={(event) => setAcceleratingOnly(event.target.checked)} /><span className="switch-track" />Rising only</label>
            </div>
          </section>

          {headlineTrends.length > 0 ? (
            <section className="hero-grid">
              <article className={`lead-signal tone-${headlineTrends[0].tone}`}>
                <div className="lead-topline"><span className="lead-rank">01 / strongest signal</span><PhasePill phase={headlineTrends[0].phase} /></div>
                <div className="lead-body"><div><div className="lead-category">{headlineTrends[0].category} · {headlineTrends[0].subcategory}</div><h2>{headlineTrends[0].title}</h2><p>{headlineTrends[0].summary}</p></div><ScoreRing value={headlineTrends[0].score[activeWindow]} /></div>
                <div className="lead-chart"><SparkBars values={headlineTrends[0].spark} phase={headlineTrends[0].phase} large /><div className="chart-baseline"><span>−{activeWindow}</span><span>now</span></div></div>
                <div className="lead-metrics">
                  <div><span>{Object.keys(headlineTrends[0].platforms ?? {}).length ? "Platform posts" : "Observed activity"}</span><strong>{platformActivityLabel(headlineTrends[0], activeWindow)}</strong></div>
                  <div><span>Velocity</span><strong className={headlineTrends[0].growth[activeWindow] >= 0 ? "positive" : "negative"}>{headlineTrends[0].growth[activeWindow] >= 0 ? "+" : ""}{headlineTrends[0].growth[activeWindow]}%</strong></div>
                  <div><span>Likely next move</span><strong>{headlineTrends[0].forecastTime}</strong></div>
                  <button onClick={() => setSelectedTrend(headlineTrends[0])}>Open analysis <ChevronRight size={15} /></button>
                </div>
              </article>

              <div className="secondary-signals">
                {headlineTrends.slice(1).map((trend, index) => (
                  <button key={trend.id} className="signal-card" onClick={() => setSelectedTrend(trend)}>
                    <div className="signal-card-top"><span>0{index + 2}</span><PhasePill phase={trend.phase} /></div><div className={`trend-mark tone-${trend.tone}`}>{trend.mark}</div>
                    <div className="signal-card-title"><h3>{trend.title}</h3><ScoreRing value={trend.score[activeWindow]} compact /></div><p>{trend.category} · {trend.subcategory}</p>
                    <div className="signal-card-bottom"><SparkBars values={trend.spark} phase={trend.phase} /><span className={trend.growth[activeWindow] >= 0 ? "positive" : "negative"}>{trend.growth[activeWindow] >= 0 ? "+" : ""}{trend.growth[activeWindow]}%</span></div>
                  </button>
                ))}
              </div>
            </section>
          ) : loading ? (
            <section className="empty-state"><LoaderCircle className="spin" size={24} /><h2>Reading live signals</h2><p>Collecting search, news and discussion activity now.</p></section>
          ) : (
            <section className="empty-state"><Search size={22} /><h2>No signals found</h2><p>Try a broader category or clear your search.</p></section>
          )}

          <div className="dashboard-grid">
            <section className="trend-board">
              <div className="section-heading"><div><span className="section-kicker">Ranked now</span><h2>{categoryLabel}</h2></div><span className="result-count">{visibleTrends.length} signals</span></div>
              <div className="table-head"><span>Trend</span><span>Momentum</span><span>Activity</span><span>Score</span><span /></div>
              <div className="trend-list">
                {visibleTrends.map((trend, index) => (
                  <button className="trend-row" key={trend.id} onClick={() => setSelectedTrend(trend)}>
                    <div className="trend-identity"><span className="trend-rank">{String(index + 1).padStart(2, "0")}</span><div className={`trend-mark tone-${trend.tone}`}>{trend.mark}</div><div><strong>{trend.title}</strong><span>{trend.category} / {trend.subcategory} · {trend.evidence.length} links · first seen {trend.firstSeen}</span></div></div>
                    <div className="momentum-cell"><SparkBars values={trend.spark} phase={trend.phase} /><PhasePill phase={trend.phase} /></div>
                    <div className="volume-cell"><strong>{platformActivityLabel(trend, activeWindow)}</strong><span className={trend.growth[activeWindow] >= 0 ? "positive" : "negative"}>{trend.growth[activeWindow] >= 0 ? "+" : ""}{trend.growth[activeWindow]}%</span></div>
                    <ScoreRing value={trend.score[activeWindow]} compact /><span className="row-arrow"><ChevronRight size={17} /></span>
                  </button>
                ))}
              </div>
            </section>

            <aside className="insight-rail">
              <section className="forecast-panel">
                <div className="section-heading compact"><div><span className="section-kicker">{payload?.analysisMode === "openai" ? "Model outlook" : "Rules outlook"}</span><h2>Next 90 minutes</h2></div><Telescope size={18} /></div>
                <div className="forecast-list">
                  {trends.filter((trend) => trend.phase === "Igniting" || trend.phase === "Accelerating").sort((a, b) => b.score["5m"] - a.score["5m"]).slice(0, 4).map((trend, index) => (
                    <button key={trend.id} onClick={() => setSelectedTrend(trend)}><span className="forecast-time">{index === 0 ? "Now" : `+${index * 30}m`}</span><span className={`forecast-dot tone-${trend.tone}`} /><span className="forecast-copy"><strong>{trend.title}</strong><small>{trend.phase === "Igniting" ? "Breakout window opening" : "Likely cross-source lift"}</small></span><span className="forecast-confidence">{trend.confidence}%</span></button>
                  ))}
                </div>
                <p className="forecast-note">Scores use observed source activity, freshness, crossover and stored trajectory. Zero velocity means the historical baseline is still forming.</p>
              </section>

              <section className="news-panel">
                <div className="section-heading compact"><div><span className="section-kicker">Crossover radar</span><h2>News pickup</h2></div><Newspaper size={18} /></div>
                <div className="news-list">{payload?.news.slice(0, 6).map((item) => <button key={`${item.title}-${item.source}`} onClick={() => openNewsItem(item.url, item.trendId)}><div><strong>{item.title}</strong><span>{item.source} · {item.age} ago</span></div><ChevronRight size={15} /></button>)}</div>
              </section>
            </aside>
          </div>

          <section className="pump-radar" id="pump-radar">
            <div className="pump-radar-head">
              <div><span className="section-kicker"><Coins size={13} /> Narrative crossover</span><h2>Pump.fun attention radar</h2><p>What Pump.fun is surfacing now, cross-checked against X and Front Run&apos;s independent news/trend evidence.</p></div>
              <div className="pump-disclaimer"><span>Discovery signal</span><strong>Not an endorsement</strong></div>
            </div>
            {pumpCoins.length ? <div className="pump-grid">
              {pumpCoins.map((coin) => (
                <article className="pump-card" key={coin.mint}>
                  <div className="pump-card-top"><span className={`pump-bucket ${coin.bucket === "Trending now" ? "is-featured" : ""}`}>{coin.bucket} · #{coin.rank}</span><ScoreRing value={coin.score[activeWindow]} compact /></div>
                  <div className="pump-title-row"><div className="pump-coin-mark">{coin.name.slice(0, 2).toUpperCase()}</div><div><h3>{coin.name}</h3><span>${coin.symbol} · {coinAge(coin, clock)}</span></div></div>
                  <p className="pump-description">{coin.description}</p>
                  <div className="pump-metrics"><div><span>Market cap</span><strong>{coin.marketCapUsd ? `$${formatNumber(coin.marketCapUsd)}` : "—"}</strong></div><div><span>X posts · {activeWindow}</span><strong>{coin.xPosts ? formatNumber(coin.xPosts[activeWindow]) : "Not measured"}</strong></div><div><span>Attention</span><strong>{coin.score[activeWindow]}/100</strong></div></div>
                  <div className="pump-source"><span>Likely source</span>{coin.relatedTrendId ? <button onClick={() => setSelectedTrend(trends.find((trend) => trend.id === coin.relatedTrendId) ?? null)}>{coin.sourceLabel}<ChevronRight size={13} /></button> : <a href={coin.sourceUrl} target="_blank" rel="noreferrer">{coin.sourceLabel}<ExternalLink size={12} /></a>}</div>
                  <p className="pump-summary">{coin.summary}</p>
                  <div className="pump-links">{coin.evidence.slice(0, 3).map((item) => <a key={`${coin.mint}-${item.url}`} href={item.url} target="_blank" rel="noreferrer" title={item.title}>{item.source}<ExternalLink size={11} /></a>)}</div>
                  <a className="pump-open" href={coin.url} target="_blank" rel="noreferrer">Open on Pump.fun <ExternalLink size={13} /></a>
                </article>
              ))}
            </div> : <div className="pump-empty"><LoaderCircle className={loading ? "spin" : ""} size={18} /><div><strong>Pump.fun radar is reconnecting</strong><span>The normal news and trend feed remains independent.</span></div></div>}
          </section>
        </div>

        <div className="mobile-category-rail" aria-label="Mobile categories">{categories.map((item) => <button key={item.name} className={category === item.name ? "is-active" : ""} onClick={() => selectCategory(item.name)}>{item.name}</button>)}</div>
      </main>

      {selectedTrend && (
        <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${selectedTrend.title} analysis`}>
          <button className="drawer-backdrop" onClick={() => setSelectedTrend(null)} aria-label="Close analysis" />
          <aside className="analysis-drawer">
            <div className="drawer-header"><div className="drawer-brand"><Telescope size={16} /> Front Run analysis</div><button className="icon-button" onClick={() => setSelectedTrend(null)} aria-label="Close"><X size={19} /></button></div>
            <div className="drawer-content">
              <div className="drawer-title-row"><div className={`trend-mark large tone-${selectedTrend.tone}`}>{selectedTrend.mark}</div><div><span>{selectedTrend.category} · {selectedTrend.subcategory}</span><h2>{selectedTrend.title}</h2></div></div>
              <div className="drawer-status-row"><PhasePill phase={selectedTrend.phase} /><span>First seen {selectedTrend.firstSeen}</span><span>{selectedTrend.geography}</span></div>
              <section className="drawer-score-card"><div><span>Viral score · {activeWindow}</span><ScoreRing value={selectedTrend.score[activeWindow]} /></div><div className="drawer-score-copy"><span>Summary</span><p className="drawer-summary-copy">{selectedTrend.summary}</p></div></section>
              <section className="trajectory-section">
                <div className="drawer-section-head"><div><span>Trajectory</span><h3>Momentum is {selectedTrend.phase.toLowerCase()}</h3></div><strong className={selectedTrend.growth[activeWindow] >= 0 ? "positive" : "negative"}>{selectedTrend.growth[activeWindow] >= 0 ? "+" : ""}{selectedTrend.growth[activeWindow]}%</strong></div>
                <div className="drawer-chart"><SparkBars values={selectedTrend.spark} phase={selectedTrend.phase} large /></div><div className="drawer-axis"><span>First detection</span><span>Current</span><span>Projected</span></div>
              </section>
              <section className="drawer-section"><span className="drawer-label">What happens next</span><p className="analyst-copy">{selectedTrend.forecast}</p><p className="forecast-window">Expected decision window: <strong>{selectedTrend.forecastTime}</strong></p><div className="signal-reasons">{selectedTrend.signals.map((signal) => <div key={signal}><Zap size={14} /><span>{signal}</span></div>)}</div></section>
              <section className="drawer-section">
                <div className="drawer-section-head"><div><span>Source mix</span><h3>Where the signal lives</h3></div><small>{formatNumber(selectedTrend.mentions[activeWindow])} observed activity</small></div>
                <div className="source-bars">{Object.entries(selectedTrend.sources).map(([source, value]) => <div key={source}><div><span>{source === "x" ? "X" : source === "kym" ? "Know Your Meme" : source === "hackernews" ? "Hacker News" : source.charAt(0).toUpperCase() + source.slice(1)}</span><strong>{value}%</strong></div><div className="source-track"><span style={{ width: `${value}%` }} /></div></div>)}</div>
              </section>
              {Object.keys(selectedTrend.platforms ?? {}).length > 0 && <section className="drawer-section">
                <div className="drawer-section-head"><div><span>Platform counts</span><h3>Posts by time window</h3></div><small>Exact where the platform permits it</small></div>
                <div className="platform-count-grid">{Object.entries(selectedTrend.platforms).map(([platform, metric]) => <div key={platform}>
                  <div className="platform-count-head"><strong>{metric.label}</strong><span>{metric.scope === "sample" ? "sample" : "official count"}</span></div>
                  <div className="platform-window-row">{timeWindows.map((window) => <div key={window.key}><span>{window.label}</span><strong>{formatNumber(metric.windows[window.key])}</strong></div>)}</div>
                  <p>{metric.detail}</p>
                </div>)}</div>
              </section>}
              <section className="drawer-section">
                <div className="drawer-section-head"><div><span>Viral links</span><h3>News coverage and leading posts</h3></div><small>{selectedTrend.evidence.length} links</small></div>
                <div className="evidence-list">{selectedTrend.evidence.map((item) => <a key={`${item.source}-${item.url}`} href={item.url} target="_blank" rel="noreferrer"><span><strong>{item.title}</strong><small>{item.source} · {item.detail}</small></span><ExternalLink size={14} /></a>)}</div>
              </section>
              <section className="drawer-section"><div className="saturation-row"><div><span>Saturation</span><h3>{selectedTrend.saturation < 30 ? "Early and underexposed" : selectedTrend.saturation < 70 ? "Expanding audience" : "Approaching exhaustion"}</h3></div><strong>{selectedTrend.saturation}%</strong></div><div className="saturation-track"><span style={{ width: `${selectedTrend.saturation}%` }} /></div><div className="tag-row">{selectedTrend.tags.map((item) => <span key={item}>{item}</span>)}</div></section>
            </div>
            <div className="drawer-footer"><button className={`watch-button ${watching.has(selectedTrend.id) ? "is-watching" : ""}`} onClick={() => toggleWatch(selectedTrend.id)}><Bell size={16} /> {watching.has(selectedTrend.id) ? "Watching signal" : "Watch signal"}</button><span><Clock3 size={14} /> Updated {elapsed}s ago · {selectedTrend.confidence}% confidence</span></div>
          </aside>
        </div>
      )}
    </div>
  );
}
