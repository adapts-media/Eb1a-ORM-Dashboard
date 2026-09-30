import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ManualScrapeResult, PlatformKeywordCard, CronStatus } from "../api/types";
import { ItemList } from "../components/ItemList";
import { UndoToast, type PendingDeletion } from "../components/UndoToast";
import { getActorName } from "../lib/actor";

export function ManualScraperPage() {
  const [platform, setPlatform] = useState<"reddit" | "quora" | "teamblind" | "trustpilot" | "linkedin" | "all">("reddit");
  const [cards, setCards] = useState<PlatformKeywordCard[]>([]);
  const [cronStatus, setCronStatus] = useState<CronStatus | null>(null);

  // New card creation form state
  const [newKeyword, setNewKeyword] = useState("");
  const [newSearchUrl, setNewSearchUrl] = useState("");

  const [loadingCardId, setLoadingCardId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [progressStage, setProgressStage] = useState<string>("");
  const [result, setResult] = useState<ManualScrapeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingDeletion | null>(null);

  useEffect(() => {
    loadCardsAndStatus();
  }, []);

  async function loadCardsAndStatus() {
    try {
      const [cRes, csRes] = await Promise.all([
        api.getPlatformCards(),
        api.getCronStatus(),
      ]);
      setCards(cRes.cards);
      setCronStatus(csRes);
    } catch (err) {
      console.error("Failed to load platform cards:", err);
    }
  }

  function handlePlatformChange(newPlatform: "reddit" | "quora" | "teamblind" | "trustpilot" | "linkedin" | "all") {
    setPlatform(newPlatform);
    setNewKeyword("");
    setNewSearchUrl("");
  }

  async function handleAddCard(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyword.trim()) return;
    const targetPlatform = platform === "all" ? "reddit" : platform;

    try {
      setError(null);
      setSuccessBanner(null);
      await api.createPlatformCard({
        platform: targetPlatform,
        keyword: newKeyword.trim(),
        searchUrl: newSearchUrl.trim() || undefined,
      });
      setNewKeyword("");
      setNewSearchUrl("");
      setSuccessBanner(`✓ Added new ${targetPlatform.toUpperCase()} card for "${newKeyword.trim()}"`);
      await loadCardsAndStatus();
    } catch (err: any) {
      setError(err.message || "Failed to add keyword card.");
    }
  }

  async function handleToggleCard(id: string) {
    try {
      await api.togglePlatformCard(id);
      await loadCardsAndStatus();
    } catch (err: any) {
      setError(err.message || "Failed to toggle card.");
    }
  }

  async function handleDeleteCard(id: string) {
    const card = cards.find((c) => c.id === id);
    if (!window.confirm("Remove this keyword card? You can undo this for the next 24 hours.")) return;
    try {
      const actor = getActorName();
      await api.deletePlatformCard(id, actor);
      await loadCardsAndStatus();
      setPendingUndo({
        label: `"${card?.keyword ?? "Keyword"}" card removed`,
        undo: async () => {
          await api.restorePlatformCard(id);
          await loadCardsAndStatus();
        },
      });
    } catch (err: any) {
      setError(err.message || "Failed to delete card.");
    }
  }

  async function handleRunCard(card: PlatformKeywordCard) {
    setLoadingCardId(card.id);
    setError(null);
    setSuccessBanner(null);
    setResult(null);
    setProgressStage(`Running Playwright scraper for ${card.platform.toUpperCase()} keyword "${card.keyword}"...`);

    try {
      const res = await api.runPlatformCardNow(card.id, {
        platform: card.platform,
        keyword: card.keyword,
        searchUrl: card.searchUrl || undefined,
      });
      setResult(res.result);
      const newItems = (res.result.postsCreated || 0) + (res.result.commentsCreated || 0);
      const skipped = (res.result.postsSkippedExisting || 0) + (res.result.commentsSkippedExisting || 0);
      const totalScraped = res.result.itemsReceived || (newItems + skipped);

      if (newItems > 0) {
        setSuccessBanner(`✓ Scraped ${card.platform.toUpperCase()} for "${card.keyword}" — Added ${newItems} new mentions (${skipped} existing items verified in DB).`);
      } else {
        setSuccessBanner(`✓ Scraped ${card.platform.toUpperCase()} for "${card.keyword}" — ${totalScraped || skipped} items found (${skipped || totalScraped} items already verified up-to-date in DB).`);
      }
      await loadCardsAndStatus();
    } catch (err: any) {
      setError(err.message || `Failed to scrape ${card.platform}.`);
    } finally {
      setLoadingCardId(null);
      setProgressStage("");
    }
  }

  async function handleRunAllCards() {
    setRunningAll(true);
    setError(null);
    setSuccessBanner(null);
    setResult(null);
    setProgressStage("Running automated scraper cycle for ALL platform keyword cards...");

    try {
      const res = await api.runAllPlatformCardsNow();
      setSuccessBanner(`✓ Full platform cycle completed! ${res.message}`);
      await loadCardsAndStatus();
    } catch (err: any) {
      setError(err.message || "Failed to run all cards.");
    } finally {
      setRunningAll(false);
      setProgressStage("");
    }
  }

  // Filter cards for active platform tab
  const activeCards = cards.filter((c) => (platform === "all" ? true : c.platform === platform));

  const feedItems = [
    ...(result?.posts ?? []).map((p) => ({ ...p, type: "post" as const })),
    ...(result?.comments ?? []).map((c) => ({ ...c, type: "comment" as const })),
  ];

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2>Social Scraper Engine &amp; Keyword Cards</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-dim)", fontSize: 13 }}>
            Manage keyword cards for Reddit, Quora, TeamBlind, Trustpilot &amp; LinkedIn. Scrapers run automatically every 1 hour in background.
          </p>
        </div>

        <button
          type="button"
          onClick={handleRunAllCards}
          disabled={runningAll || loadingCardId !== null}
          style={{
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "8px 16px",
            fontWeight: 600,
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {runningAll ? <span className="spinner" style={{ width: 14, height: 14 }} /> : "⚡"}
          {runningAll ? "Scraping All Platforms…" : "Run All Cards Now"}
        </button>
      </div>

      {/* Success Breadcrumb Banner */}
      {successBanner && (
        <div
          style={{
            marginBottom: 20,
            padding: "12px 16px",
            background: "rgba(51, 193, 122, 0.12)",
            border: "1px solid rgba(51, 193, 122, 0.4)",
            borderRadius: 8,
            color: "#33c17a",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <span>{successBanner}</span>
          <button
            type="button"
            onClick={() => setSuccessBanner(null)}
            style={{ background: "transparent", border: "none", color: "#33c17a", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Hourly Background Cron Status Banner */}
      <div
        className="card"
        style={{
          marginBottom: 24,
          background: "rgba(51, 193, 122, 0.06)",
          border: "1px solid rgba(51, 193, 122, 0.3)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 20px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#33c17a" }}>
              ⏰ Automated 1-Hour Background Cron Scraper: ACTIVE
            </span>
          </div>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-dim)" }}>
            Automatically scrapes every active keyword card across Reddit, Quora, TeamBlind, Trustpilot, and LinkedIn every 60 minutes with live AI sentiment analysis and instant SMTP email alerts.
          </p>
        </div>

        {cronStatus?.nextCronRunAt && (
          <div style={{ textAlign: "right", fontSize: 12, color: "var(--text-dim)" }}>
            <div>Next scheduled run:</div>
            <strong style={{ color: "var(--text)" }}>{new Date(cronStatus.nextCronRunAt).toLocaleTimeString()}</strong>
          </div>
        )}
      </div>

      {/* Platform Selector Chips */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>
            Select Scraper Window / Platform
          </label>
          <div className="preset-chips" style={{ marginTop: 8 }}>
            <button
              type="button"
              className={`preset-chip ${platform === "reddit" ? "active" : ""}`}
              onClick={() => handlePlatformChange("reddit")}
              style={{ fontSize: 13, padding: "6px 14px" }}
            >
              Reddit Cards ({cards.filter((c) => c.platform === "reddit").length})
            </button>
            <button
              type="button"
              className={`preset-chip ${platform === "quora" ? "active" : ""}`}
              onClick={() => handlePlatformChange("quora")}
              style={{ fontSize: 13, padding: "6px 14px" }}
            >
              Quora Cards ({cards.filter((c) => c.platform === "quora").length})
            </button>
            <button
              type="button"
              className={`preset-chip ${platform === "teamblind" ? "active" : ""}`}
              onClick={() => handlePlatformChange("teamblind")}
              style={{ fontSize: 13, padding: "6px 14px" }}
            >
              TeamBlind Cards ({cards.filter((c) => c.platform === "teamblind").length})
            </button>
            <button
              type="button"
              className={`preset-chip ${platform === "trustpilot" ? "active" : ""}`}
              onClick={() => handlePlatformChange("trustpilot")}
              style={{ fontSize: 13, padding: "6px 14px" }}
            >
              Trustpilot Cards ({cards.filter((c) => c.platform === "trustpilot").length})
            </button>
            <button
              type="button"
              className={`preset-chip ${platform === "linkedin" ? "active" : ""}`}
              onClick={() => handlePlatformChange("linkedin")}
              style={{ fontSize: 13, padding: "6px 14px" }}
            >
              LinkedIn Cards ({cards.filter((c) => c.platform === "linkedin").length})
            </button>
            <button
              type="button"
              className={`preset-chip ${platform === "all" ? "active" : ""}`}
              onClick={() => handlePlatformChange("all")}
              style={{ fontSize: 13, padding: "6px 14px" }}
            >
              All Keyword Cards ({cards.length})
            </button>
          </div>
        </div>

        {/* Form to Add New Keyword Card for Selected Platform */}
        <form onSubmit={handleAddCard} style={{ background: "var(--bg-panel-alt)", padding: 16, borderRadius: 8, border: "1px solid var(--border)" }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
            ➕ Add New Keyword Card for {platform === "all" ? "REDDIT" : platform.toUpperCase()}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 12, alignItems: "end" }}>
            <div className="settings-form-group">
              <label htmlFor="newKeyword">Search Keyword / Domain</label>
              <input
                id="newKeyword"
                type="text"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                placeholder="e.g. eb1aexperts.com or eb1a"
                required
              />
            </div>

            <div className="settings-form-group">
              <label htmlFor="newSearchUrl">Custom Search / Review URL (Optional)</label>
              <input
                id="newSearchUrl"
                type="text"
                value={newSearchUrl}
                onChange={(e) => setNewSearchUrl(e.target.value)}
                placeholder="Leave blank for automatic URL generation"
              />
            </div>

            <button type="submit" style={{ height: 38, padding: "0 16px", minWidth: 120 }}>
              Add Card
            </button>
          </div>
        </form>
      </div>

      {/* Keyword Cards Display */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, marginBottom: 14 }}>
          {platform === "all" ? "All Platform Keyword Cards" : `${platform.toUpperCase()} Keyword Cards`} ({activeCards.length})
        </h3>

        {activeCards.length === 0 ? (
          <div className="empty-state">No keyword cards added for this platform yet. Use the form above to add one.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
            {activeCards.map((card) => (
              <div
                key={card.id}
                className="card"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  position: "relative",
                  borderLeft: `4px solid ${
                    card.platform === "reddit"
                      ? "#ff4500"
                      : card.platform === "quora"
                      ? "#b92b27"
                      : card.platform === "teamblind"
                      ? "#00a4e4"
                      : card.platform === "linkedin"
                      ? "#0077b5"
                      : "#00b67a"
                  }`,
                  opacity: card.enabled ? 1 : 0.6,
                }}
              >
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: "var(--bg-panel-alt)",
                        color: "var(--text-dim)",
                      }}
                    >
                      {card.platform}
                    </span>

                    {/* Enable / Disable Toggle Switch */}
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={card.enabled}
                        onChange={() => handleToggleCard(card.id)}
                      />
                      <span>{card.enabled ? "Active" : "Paused"}</span>
                    </label>
                  </div>

                  <h4 style={{ margin: "0 0 6px", fontSize: 15, color: "var(--text)" }}>{card.keyword}</h4>

                  {card.searchUrl && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)", wordBreak: "break-all", marginBottom: 12 }}>
                      {card.searchUrl}
                    </div>
                  )}

                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
                    Last scraped: {card.lastRunAt ? new Date(card.lastRunAt).toLocaleTimeString() : "Never run"}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button
                    type="button"
                    onClick={() => handleRunCard(card)}
                    disabled={loadingCardId === card.id || runningAll}
                    style={{ flex: 1, padding: "8px 12px", fontSize: 12, height: 34 }}
                  >
                    {loadingCardId === card.id ? (
                      <>
                        <span className="spinner" style={{ marginRight: 6, width: 12, height: 12 }} />
                        Scraping…
                      </>
                    ) : (
                      "🚀 Run Scraper"
                    )}
                  </button>

                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleDeleteCard(card.id)}
                    disabled={loadingCardId === card.id || runningAll}
                    style={{ padding: "8px 12px", fontSize: 12, height: 34, color: "#f87171" }}
                  >
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {progressStage && (
        <div
          style={{
            marginBottom: 24,
            padding: "12px 16px",
            background: "rgba(91, 141, 239, 0.12)",
            border: "1px solid rgba(91, 141, 239, 0.3)",
            borderRadius: "var(--radius)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 13,
            color: "#bcd2ff",
          }}
        >
          <span className="spinner" style={{ width: 16, height: 16 }} />
          <span>{progressStage}</span>
        </div>
      )}

      {error && (
        <div className="banner warn" style={{ marginBottom: 24 }}>
          ⚠ {error}
        </div>
      )}

      {/* Scrape Execution Summary Results */}
      {result && (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 24 }}>
            <div className="stat-card">
              <div className="label">New Items Added</div>
              <div className="value">{result.postsCreated + result.commentsCreated}</div>
              <div className="sub">
                {(result.postsSkippedExisting ?? 0) + (result.commentsSkippedExisting ?? 0) > 0
                  ? `${(result.postsSkippedExisting ?? 0) + (result.commentsSkippedExisting ?? 0)} duplicate items skipped`
                  : `Scraped from ${result.keyword}`}
              </div>
            </div>

            <div className="stat-card">
              <div className="label">Posts Created</div>
              <div className="value">{result.postsCreated}</div>
              <div className="sub">{result.postsSkippedExisting ?? 0} existing skipped</div>
            </div>

            <div className="stat-card">
              <div className="label">Comments Created</div>
              <div className="value">{result.commentsCreated}</div>
              <div className="sub">{result.commentsSkippedExisting ?? 0} existing skipped</div>
            </div>

            <div className="stat-card positive">
              <div className="label">AI Analyzed</div>
              <div className="value">{result.analyzed}</div>
              <div className="sub">{result.failed} failed</div>
            </div>
          </div>

          <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Scraped Items ({result.keyword})</h3>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Showing {feedItems.length} items
            </span>
          </div>

          <ItemList items={feedItems} emptyMessage="No posts or comments found for this query." />
        </>
      )}

      <UndoToast pending={pendingUndo} onDismiss={() => setPendingUndo(null)} />
    </div>
  );
}
