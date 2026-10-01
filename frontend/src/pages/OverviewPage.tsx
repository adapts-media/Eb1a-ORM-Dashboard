import { useEffect, useState } from "react";
import { api } from "../api/client";
import type {
  KeywordSummary,
  Overview,
  SentimentByKeywordRow,
  SentimentByPlatformRow,
  SentimentOverTimeRow,
} from "../api/types";
import { StatCard } from "../components/StatCard";
import { DateRangeSelector, getDateBounds, type DateRange } from "../components/DateRangeSelector";
import {
  DistributionPieChart,
  SentimentOverTimeChart,
  KeywordSentimentBars,
  PlatformSentimentBars,
} from "../components/charts/Charts";
import { UndoToast, type PendingDeletion } from "../components/UndoToast";
import { getActorName } from "../lib/actor";

export function OverviewPage() {
  const [selectedPlatform, setSelectedPlatform] = useState<string>("all");
  // "google" filters by discovery source (Serper SERP) rather than by platform label.
  const [selectedSource, setSelectedSource] = useState<"scraper" | "google" | undefined>(undefined);
  const [dateRange, setDateRange] = useState<DateRange>({});
  const [overview, setOverview] = useState<Overview | null>(null);
  const [byKeyword, setByKeyword] = useState<SentimentByKeywordRow[]>([]);
  const [byPlatform, setByPlatform] = useState<SentimentByPlatformRow[]>([]);
  const [overTime, setOverTime] = useState<SentimentOverTimeRow[]>([]);
  const [keywords, setKeywords] = useState<KeywordSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingDeletion | null>(null);

  async function loadData(platform = selectedPlatform, dr = dateRange, source = selectedSource) {
    setLoading(true);
    setError(null);

    const { dateFrom, dateTo } = getDateBounds(dr);

    try {
      const [ov, bk, bp, ot, kw] = await Promise.all([
        api.getOverview(undefined, platform === "all" ? undefined : platform, dateFrom, dateTo, source),
        api.getByKeyword(),
        api.getByPlatform(undefined, dateFrom, dateTo),
        api.getOverTime(undefined, platform === "all" ? undefined : platform, dateFrom, dateTo),
        api.getKeywords(),
      ]);
      setOverview(ov);
      setByKeyword(bk);
      setByPlatform(bp);
      setOverTime(ot);
      setKeywords(kw.keywords);
    } catch (err: any) {
      console.error("Failed to load overview:", err);
      setError(err?.message || "Failed to connect to backend server.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData(selectedPlatform, dateRange, selectedSource);
  }, [selectedPlatform, dateRange, selectedSource]);

  function handlePlatformTab(platform: string) {
    setSelectedPlatform(platform);
    setSelectedSource(undefined);
  }

  function handleExportExcel() {
    const { dateFrom, dateTo } = getDateBounds(dateRange);
    api.exportToExcel({
      scope: "brand",
      platform: selectedPlatform === "all" ? undefined : selectedPlatform,
      dateFrom,
      dateTo,
    });
  }

  // Feature: "add a safety net before deleting anything". The confirm()
  // click below is step one; step two is the delete itself being a soft
  // delete with a 24h undo window — this shows the Undo toast for that
  // window and attributes the action in the DeletionLog audit trail.
  async function handleDeleteKeyword(term: string) {
    const kw = keywords.find((k) => k.term === term);
    if (!kw) return;
    const confirmed = window.confirm(`Delete keyword "${term}" and all its scraped items? You can undo this for the next 24 hours.`);
    if (!confirmed) return;

    try {
      const actor = getActorName();
      await api.deleteKeyword(kw.id, actor);
      await loadData(selectedPlatform, dateRange);
      setPendingUndo({
        label: `Keyword "${term}" deleted`,
        undo: async () => {
          await api.restoreKeyword(kw.id);
          await loadData(selectedPlatform, dateRange);
        },
      });
    } catch (err: any) {
      setError(err.message || "Failed to delete keyword.");
    }
  }

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2>Overview Dashboard</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-dim)", fontSize: 13 }}>
            Real-time reputation metrics, sentiment distribution, and platform-wise breakdown.
          </p>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary"
            onClick={handleExportExcel}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Download multi-tab Excel spreadsheet with platform tabs & clickable links"
          >
            📊 Export Excel
          </button>

          {/* Platform Selector Filter */}
          <div className="preset-chips">
            <button
              type="button"
              className={`preset-chip ${selectedPlatform === "all" ? "active" : ""}`}
              onClick={() => handlePlatformTab("all")}
            >
              All Platforms
            </button>
            <button
              type="button"
              className={`preset-chip ${selectedPlatform === "reddit" ? "active" : ""}`}
              onClick={() => handlePlatformTab("reddit")}
            >
              Reddit
            </button>
            <button
              type="button"
              className={`preset-chip ${selectedPlatform === "quora" ? "active" : ""}`}
              onClick={() => handlePlatformTab("quora")}
            >
              Quora
            </button>
            <button
              type="button"
              className={`preset-chip ${selectedPlatform === "teamblind" ? "active" : ""}`}
              onClick={() => handlePlatformTab("teamblind")}
            >
              TeamBlind
            </button>
            <button
              type="button"
              className={`preset-chip ${selectedPlatform === "trustpilot" ? "active" : ""}`}
              onClick={() => handlePlatformTab("trustpilot")}
            >
              Trustpilot
            </button>
            <button
              type="button"
              className={`preset-chip ${selectedPlatform === "linkedin" ? "active" : ""}`}
              onClick={() => handlePlatformTab("linkedin")}
            >
              LinkedIn
            </button>
            <button
              type="button"
              className={`preset-chip ${selectedSource === "google" ? "active" : ""}`}
              onClick={() => {
                setSelectedPlatform("all");
                setSelectedSource(selectedSource === "google" ? undefined : "google");
              }}
              title="Mentions discovered via Google/Bing/YouTube search (Serper)"
            >
              Google Search
            </button>
          </div>
        </div>
      </div>

      {/* Date Range Selector matching user reference design */}
      <DateRangeSelector value={dateRange} onChange={setDateRange} />

      {error && (
        <div className="banner error" style={{ marginBottom: 20 }}>
          {error} <button onClick={() => loadData(selectedPlatform, dateRange, selectedSource)} style={{ marginLeft: 10 }}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="empty-state">Loading dashboard data…</div>
      ) : !overview ? (
        <div className="empty-state">No overview data available.</div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard
              label={`Total Mentions (${selectedSource === "google" ? "GOOGLE SEARCH" : selectedPlatform.toUpperCase()})`}
              trend={overview.trend?.change.total}
              goodDirection="up"
              windowDays={overview.trend?.windowDays}
              value={overview.totalMentions.toLocaleString()}
              sub={
                selectedPlatform === "trustpilot"
                  ? `${overview.totalMentions.toLocaleString()} reviews`
                  : overview.bySource
                    ? `${overview.totalPosts} posts · ${overview.totalComments} comments · ${overview.bySource.scraper.toLocaleString()} scraped + ${overview.bySource.google.toLocaleString()} Google`
                    : `${overview.totalPosts} posts · ${overview.totalComments} comments`
              }
            />
            <StatCard label="Total Analyzed" value={overview.totalAnalyzed.toLocaleString()} />
            <StatCard
              label="Positive"
              value={overview.positive.toLocaleString()}
              sub={`${overview.positivePct}%`}
              variant="positive"
              trend={overview.trend?.change.positive}
              goodDirection="up"
              windowDays={overview.trend?.windowDays}
            />
            <StatCard
              label="Negative"
              value={overview.negative.toLocaleString()}
              sub={`${overview.negativePct}%`}
              variant="negative"
              trend={overview.trend?.change.negative}
              goodDirection="up"
              windowDays={overview.trend?.windowDays}
            />
            <StatCard
              label="Neutral"
              value={overview.neutral.toLocaleString()}
              sub={`${overview.neutralPct}%`}
              variant="neutral"
              trend={overview.trend?.change.neutral}
              goodDirection="down"
              windowDays={overview.trend?.windowDays}
            />
          </div>

          <div className="charts-grid">
            <div className="card">
              <div className="chart-title">
                Sentiment Distribution {selectedPlatform !== "all" && `(${selectedPlatform.toUpperCase()})`}
              </div>
              <DistributionPieChart overview={overview} />
            </div>
            <div className="card">
              <div className="chart-title">
                Sentiment Over Time {selectedPlatform !== "all" && `(${selectedPlatform.toUpperCase()})`}
              </div>
              <SentimentOverTimeChart data={overTime} />
            </div>
          </div>

          {/* Platform Breakdown Comparison Card */}
          <div className="card" style={{ marginBottom: 22 }}>
            <div className="chart-title">Sentiment by Platform</div>
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              {byPlatform.map((row) => (
                <PlatformSentimentBars key={row.platform} row={row} />
              ))}
            </div>
          </div>

          {/* Keyword Breakdown Card */}
          <div className="card">
            <div className="chart-title">Sentiment by Keyword</div>
            {byKeyword.length === 0 && <div className="empty-state">No keywords scraped yet.</div>}
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              {byKeyword.map((row) => (
                <KeywordSentimentBars key={row.keyword} row={row} onDelete={handleDeleteKeyword} />
              ))}
            </div>
          </div>

          {keywords.length === 0 && (
            <div className="banner info" style={{ marginTop: 20 }}>
              No data yet — enter a keyword above or use the Keywords Cards section to pull real data.
            </div>
          )}
        </>
      )}

      <UndoToast pending={pendingUndo} onDismiss={() => setPendingUndo(null)} />
    </div>
  );
}
