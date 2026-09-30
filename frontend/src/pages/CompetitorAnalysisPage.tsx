import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { CompetitorCard, FeedItem, ItemsResponse } from "../api/types";
import { ItemList } from "../components/ItemList";
import { UndoToast, type PendingDeletion } from "../components/UndoToast";
import { getActorName } from "../lib/actor";

const PAGE_SIZE = 20;

export function CompetitorAnalysisPage() {
  const [platform, setPlatform] = useState<string>("all");
  const [cards, setCards] = useState<CompetitorCard[]>([]);

  // New competitor card form state
  const [formPlatform, setFormPlatform] = useState<string>("reddit");
  const [newKeyword, setNewKeyword] = useState("");
  const [newSearchUrl, setNewSearchUrl] = useState("");

  const [loadingCardId, setLoadingCardId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingDeletion | null>(null);

  // Feed items state
  const [data, setData] = useState<ItemsResponse | null>(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    loadCards();
  }, []);

  useEffect(() => {
    fetchFeedData();
  }, [platform, searchQuery, page]);

  async function loadCards() {
    try {
      const res = await api.getCompetitorCards();
      setCards(res.cards || []);
    } catch (err) {
      console.error("Failed to load competitor cards:", err);
    }
  }

  function fetchFeedData() {
    setFeedLoading(true);
    api.getCompetitorItems({ platform, search: searchQuery, page, pageSize: PAGE_SIZE })
      .then((r) => setData(r))
      .catch((err) => console.error("Failed to load competitor feed:", err))
      .finally(() => setFeedLoading(false));
  }

  async function handleAddCard(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyword.trim()) return;
    const targetPlatform = formPlatform;

    try {
      setError(null);
      setSuccessBanner(null);
      await api.createCompetitorCard({
        platform: targetPlatform,
        keyword: newKeyword.trim(),
        searchUrl: newSearchUrl.trim() || undefined,
      });
      setNewKeyword("");
      setNewSearchUrl("");
      setSuccessBanner(`✓ Added new competitor card for "${newKeyword.trim()}" on ${targetPlatform.toUpperCase()}`);
      await loadCards();
      fetchFeedData();
    } catch (err: any) {
      setError(err.message || "Failed to create competitor card.");
    }
  }

  async function handleToggleCard(id: string) {
    try {
      await api.toggleCompetitorCard(id);
      await loadCards();
    } catch (err: any) {
      setError(err.message || "Failed to toggle card.");
    }
  }

  // Feature: "turn on sentiment scoring for competitors" — opt-in per card,
  // off by default. When on, new mentions for this competitor get real AI
  // sentiment analysis instead of a stamped NEUTRAL placeholder.
  async function handleToggleSentiment(id: string) {
    try {
      await api.toggleCompetitorSentiment(id);
      await loadCards();
    } catch (err: any) {
      setError(err.message || "Failed to toggle sentiment scoring.");
    }
  }

  async function handleDeleteCard(id: string) {
    const card = cards.find((c) => c.id === id);
    if (!confirm("Delete this competitor card? You can undo this for the next 24 hours.")) return;
    try {
      const actor = getActorName();
      await api.deleteCompetitorCard(id, actor);
      await loadCards();
      setPendingUndo({
        label: `Competitor card "${card?.keyword ?? ""}" deleted`,
        undo: async () => {
          await api.restoreCompetitorCard(id);
          await loadCards();
        },
      });
    } catch (err: any) {
      setError(err.message || "Failed to delete card.");
    }
  }

  async function handleRunCard(card: CompetitorCard) {
    try {
      setLoadingCardId(card.id);
      setError(null);
      setSuccessBanner(null);
      const res = await api.runCompetitorCardNow(card.id);
      const newCount = (res.result?.postsCreated || 0) + (res.result?.commentsCreated || 0);
      const sentimentUsed = res.result?.sentimentEnabled ?? card.sentimentEnabled;
      setSuccessBanner(`✓ Scraped competitor card "${card.keyword}": Added ${newCount} new competitor mention(s) (${sentimentUsed ? "AI sentiment analyzed" : "no AI sentiment used"}).`);
      await loadCards();
      fetchFeedData();
    } catch (err: any) {
      setError(err.message || `Failed to scrape competitor "${card.keyword}".`);
    } finally {
      setLoadingCardId(null);
    }
  }

  async function handleRunAllCards() {
    try {
      setRunningAll(true);
      setError(null);
      setSuccessBanner(null);
      const res = await api.runAllCompetitorCardsNow();
      setSuccessBanner(`⚡ ${res.message || "Competitor scrape completed!"}`);
      await loadCards();
      fetchFeedData();
    } catch (err: any) {
      setError(err.message || "Failed to run competitor cards.");
    } finally {
      setRunningAll(false);
    }
  }

  const activeCards = cards.filter((c) => (platform === "all" ? true : c.platform === platform));
  const items: FeedItem[] = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.pagination.total / PAGE_SIZE)) : 1;

  return (
    <div style={{ maxWidth: 1080 }}>
      {/* Header */}
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2>🥊 Competitor Analysis</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-dim)", fontSize: 13 }}>
            Monitor competitor brand mentions across Reddit, Quora, TeamBlind, Trustpilot &amp; Web. AI sentiment scoring is opt-in per card below — off by default (no tokens spent) until you turn it on.
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
            cursor: "pointer",
          }}
        >
          {runningAll ? "Scraping Competitors…" : "⚡ Run All Competitor Cards Now"}
        </button>
      </div>

      {/* Notifications */}
      {successBanner && (
        <div className="banner info" style={{ marginBottom: 16 }}>
          {successBanner}
        </div>
      )}
      {error && (
        <div className="banner warn" style={{ marginBottom: 16 }}>
          ⚠ {error}
        </div>
      )}

      {/* Platform Chips */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          { id: "all", label: "All Platforms" },
          { id: "reddit", label: "Reddit" },
          { id: "quora", label: "Quora" },
          { id: "teamblind", label: "TeamBlind" },
          { id: "trustpilot", label: "Trustpilot" },
          { id: "linkedin", label: "LinkedIn" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setPlatform(tab.id);
              setPage(1);
            }}
            className={platform === tab.id ? "primary" : "secondary"}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Add Competitor Card Form */}
      <div className="card" style={{ marginBottom: 24, padding: 20 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>➕ Register Competitor Keyword Card</h3>
        <form onSubmit={handleAddCard} style={{ display: "grid", gridTemplateColumns: "1fr 2fr 120px", gap: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4, color: "var(--text-dim)" }}>Platform</label>
            <select
              value={formPlatform}
              onChange={(e) => setFormPlatform(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 6 }}
            >
              <option value="reddit">Reddit</option>
              <option value="quora">Quora</option>
              <option value="teamblind">TeamBlind</option>
              <option value="trustpilot">Trustpilot</option>
              <option value="linkedin">LinkedIn</option>
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4, color: "var(--text-dim)" }}>Competitor Brand / Keyword</label>
            <input
              type="text"
              placeholder='e.g. "CompetitorName" or competitor domain'
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 6 }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button type="submit" className="primary" style={{ width: "100%", height: 38, padding: 0 }}>
              Add Card
            </button>
          </div>
        </form>
      </div>

      {/* Competitor Cards List */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Competitor Keyword Cards ({activeCards.length})</h3>
        {activeCards.length === 0 ? (
          <div className="empty-state">No competitor cards configured yet for this filter. Add one above!</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {activeCards.map((card) => (
              <div
                key={card.id}
                className="card"
                style={{
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  opacity: card.enabled ? 1 : 0.6,
                  borderLeft: `4px solid ${card.enabled ? "var(--accent)" : "var(--border)"}`,
                }}
              >
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--accent)" }}>
                      {card.platform}
                    </span>
                    <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={card.enabled}
                        onChange={() => handleToggleCard(card.id)}
                      />
                      {card.enabled ? "Active" : "Paused"}
                    </label>
                  </div>

                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{card.keyword}</div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
                    Last run: {card.lastRunAt ? new Date(card.lastRunAt).toLocaleString() : "Never"}
                  </div>

                  <label
                    title="When on, new mentions of this competitor get real AI sentiment analysis instead of a stamped NEUTRAL placeholder. This is the only enhancement with ongoing AI cost, so it stays off until you turn it on here."
                    style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginBottom: 8, color: card.sentimentEnabled ? "var(--accent)" : "var(--text-dim)" }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(card.sentimentEnabled)}
                      onChange={() => handleToggleSentiment(card.id)}
                    />
                    AI sentiment scoring {card.sentimentEnabled ? "ON" : "OFF"}
                  </label>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={loadingCardId === card.id || !card.enabled}
                    onClick={() => handleRunCard(card)}
                    style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
                  >
                    {loadingCardId === card.id ? "Scraping…" : "▶ Run Scraper"}
                  </button>

                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleDeleteCard(card.id)}
                    style={{ padding: "6px 10px", fontSize: 12, color: "#ff8f9c" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Competitor Feed Section */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            Scraped Competitor Mentions {data && <span style={{ fontSize: 13, color: "var(--text-dim)", fontWeight: 400 }}>({data.pagination.total} total)</span>}
          </h3>

          <input
            type="text"
            placeholder="Search competitor posts &amp; comments…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            style={{ padding: "6px 12px", borderRadius: 6, width: 260, fontSize: 13 }}
          />
        </div>

        {feedLoading ? (
          <div className="empty-state">Loading competitor feed…</div>
        ) : items.length === 0 ? (
          <div className="empty-state">No competitor mentions found yet. Run a competitor card above!</div>
        ) : (
          <>
            <ItemList items={items} onRetried={fetchFeedData} />

            {data && data.pagination.total > PAGE_SIZE && (
              <div className="pagination" style={{ marginTop: 20 }}>
                <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Prev
                </button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <button className="secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <UndoToast pending={pendingUndo} onDismiss={() => setPendingUndo(null)} />
    </div>
  );
}
