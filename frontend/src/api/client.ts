import type {
  Overview,
  KeywordSummary,
  ItemsResponse,
  ItemFiltersQuery,
  SentimentByKeywordRow,
  SentimentByPlatformRow,
  SentimentOverTimeRow,
  ScrapeResult,
  SearchResponse,
  DashboardSettings,
  ManualScrapePayload,
  ManualScrapeResult,
  PlatformKeywordCard,
  CompetitorCard,
  CompetitorOverview,
  CronStatus,
  GoogleMentionsResponse,
  GoogleStatsResponse,
  GoogleScanPayload,
  GoogleIngestResult,
  GoogleMention,
} from "./types";

function getApiBaseUrl(): string {
  let raw = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "http://localhost:4000/api";
  raw = raw.trim().replace(/\/+$/, "");
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }
  if (!raw.endsWith("/api")) {
    raw = `${raw}/api`;
  }
  return raw;
}

const BASE_URL = getApiBaseUrl();

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore
    }
    throw new ApiError(message, res.status);
  }
  return res.json();
}

function toQuery(filters: Record<string, any> = {}): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  health: () => request<{ ok: boolean; apifyConfigured: boolean; aiConfigured: boolean }>("/health"),

  getSettings: () => request<DashboardSettings>("/settings"),

  updateSettings: (data: Partial<DashboardSettings>) =>
    request<{ ok: boolean; message: string; settings: DashboardSettings }>("/settings", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  testEmail: () =>
    request<{ ok: boolean; message: string }>("/settings/test-email", {
      method: "POST",
    }),

  resetDatabase: () =>
    request<{
      ok: boolean;
      message: string;
      deletedComments: number;
      deletedPosts: number;
      deletedScrapeRuns: number;
      deletedKeywords: number;
    }>("/settings/reset-database", { method: "POST" }),

  getOverview: (
    keyword?: string,
    platform?: ItemFiltersQuery["platform"],
    dateFrom?: string,
    dateTo?: string,
    source?: "scraper" | "google"
  ) => request<Overview>(`/overview${toQuery({ keyword, platform, dateFrom, dateTo, source })}`),

  getKeywords: () => request<{ keywords: KeywordSummary[] }>("/keywords"),

  // Deletion safety net: DELETE now soft-deletes with a 24h undo window —
  // the response's `purgeAt` is when it will actually be removed. `actor`
  // is a free-text name (this app has no login system) for the audit log.
  deleteKeyword: (id: string, actor?: string) =>
    request<{ ok: boolean; message: string; purgeAt?: string }>(`/keywords/${id}`, { method: "DELETE", body: JSON.stringify({ actor }) }),
  restoreKeyword: (id: string) => request<{ ok: boolean; message: string }>(`/keywords/${id}/restore`, { method: "POST" }),

  scrapeKeyword: (keyword: string) =>
    request<ScrapeResult>("/keywords/scrape", { method: "POST", body: JSON.stringify({ keyword }) }),

  getItems: (filters: ItemFiltersQuery) => request<ItemsResponse>(`/items${toQuery(filters)}`),

  getNegative: (filters: ItemFiltersQuery) => request<ItemsResponse>(`/items/negative${toQuery(filters)}`),

  getNeutral: (filters: ItemFiltersQuery) => request<ItemsResponse>(`/items/neutral${toQuery(filters)}`),

  getPositive: (filters: ItemFiltersQuery) => request<ItemsResponse>(`/items/positive${toQuery(filters)}`),

  getFailed: () => request<{ posts: any[]; comments: any[] }>("/items/failed"),

  search: (q: string) => request<SearchResponse>(`/search?q=${encodeURIComponent(q)}`),

  getDistribution: (keyword?: string, platform?: ItemFiltersQuery["platform"], dateFrom?: string, dateTo?: string) =>
    request<Overview>(`/charts/distribution${toQuery({ keyword, platform, dateFrom, dateTo })}`),

  getByKeyword: () => request<SentimentByKeywordRow[]>("/charts/by-keyword"),

  getByPlatform: (keyword?: string, dateFrom?: string, dateTo?: string) =>
    request<SentimentByPlatformRow[]>(`/charts/by-platform${toQuery({ keyword, dateFrom, dateTo })}`),

  getOverTime: (keyword?: string, platform?: ItemFiltersQuery["platform"], dateFrom?: string, dateTo?: string) =>
    request<SentimentOverTimeRow[]>(`/charts/over-time${toQuery({ keyword, platform, dateFrom, dateTo })}`),

  retryPost: (id: string) => request<{ id: string; analyzed: boolean }>(`/retry/post/${id}`, { method: "POST" }),
  retryComment: (id: string) => request<{ id: string; analyzed: boolean }>(`/retry/comment/${id}`, { method: "POST" }),
  retryAllFailed: () =>
    request<{ ok: boolean; total: number; analyzed: number; failed: number }>("/retry/all", { method: "POST" }),
  clearAllFailed: () =>
    request<{ ok: boolean; deletedPosts: number; deletedComments: number; totalDeleted: number }>("/retry/all", {
      method: "DELETE",
    }),
  deletePost: (id: string, actor?: string) =>
    request<{ ok: boolean; id: string; purgeAt?: string }>(`/items/post/${id}`, { method: "DELETE", body: JSON.stringify({ actor }) }),
  restorePost: (id: string) => request<{ ok: boolean; id: string }>(`/items/post/${id}/restore`, { method: "POST" }),
  deleteComment: (id: string, actor?: string) =>
    request<{ ok: boolean; id: string; purgeAt?: string }>(`/items/comment/${id}`, { method: "DELETE", body: JSON.stringify({ actor }) }),
  restoreComment: (id: string) => request<{ ok: boolean; id: string }>(`/items/comment/${id}/restore`, { method: "POST" }),
  deleteFailedPost: (id: string) =>
    request<{ ok: boolean; id: string }>(`/items/post/${id}`, { method: "DELETE" }),
  deleteFailedComment: (id: string) =>
    request<{ ok: boolean; id: string }>(`/items/comment/${id}`, { method: "DELETE" }),

  runManualScrape: (payload: ManualScrapePayload) =>
    request<ManualScrapeResult>("/manual-scraper/scrape", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getPlatformCards: () => request<{ cards: PlatformKeywordCard[] }>("/platform-keywords"),

  createPlatformCard: (data: { platform: string; keyword: string; searchUrl?: string }) =>
    request<{ ok: boolean; card: PlatformKeywordCard }>("/platform-keywords", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deletePlatformCard: (id: string, actor?: string) =>
    request<{ ok: boolean; message: string; purgeAt?: string }>(`/platform-keywords/${id}`, { method: "DELETE", body: JSON.stringify({ actor }) }),
  restorePlatformCard: (id: string) =>
    request<{ ok: boolean; card: PlatformKeywordCard; message: string }>(`/platform-keywords/${id}/restore`, { method: "POST" }),

  togglePlatformCard: (id: string) =>
    request<{ ok: boolean; card: PlatformKeywordCard }>(`/platform-keywords/${id}/toggle`, { method: "PATCH" }),

  runPlatformCardNow: (id: string, payload?: { platform?: string; keyword?: string; searchUrl?: string }) =>
    request<{ ok: boolean; result: ManualScrapeResult }>(`/platform-keywords/run-card/${id}`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),

  runAllPlatformCardsNow: () =>
    request<{ ok: boolean; message: string; newItems?: number }>("/platform-keywords/run-all", { method: "POST" }),

  getCronStatus: () => request<CronStatus>("/platform-keywords/cron-status"),

  // Google Scraper APIs
  getGoogleMentions: (platform = "All", q = "") =>
    request<GoogleMentionsResponse>(`/google-scraper/mentions${toQuery({ platform, q })}`),

  getGoogleStats: () => request<GoogleStatsResponse>("/google-scraper/stats"),

  runGoogleScan: (payload: GoogleScanPayload) =>
    request<{ ok: boolean; message: string }>("/google-scraper/scan", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  ingestGoogleMentions: (payload: { items: any[]; keyword?: string }) =>
    request<GoogleIngestResult>("/google-scraper/ingest", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getGoogleStreamUrl: () => `${BASE_URL}/google-scraper/stream`,

  // Competitor Analysis APIs
  getCompetitorCards: () => request<{ cards: CompetitorCard[] }>("/competitor-cards/cards"),

  createCompetitorCard: (data: { platform: string; keyword: string; searchUrl?: string }) =>
    request<{ ok: boolean; card: CompetitorCard }>("/competitor-cards/cards", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteCompetitorCard: (id: string, actor?: string) =>
    request<{ ok: boolean; message: string; purgeAt?: string }>(`/competitor-cards/cards/${id}`, { method: "DELETE", body: JSON.stringify({ actor }) }),
  restoreCompetitorCard: (id: string) =>
    request<{ ok: boolean; card: CompetitorCard; message: string }>(`/competitor-cards/cards/${id}/restore`, { method: "POST" }),

  toggleCompetitorCard: (id: string) =>
    request<{ ok: boolean; card: CompetitorCard }>(`/competitor-cards/cards/${id}/toggle`, { method: "PATCH" }),

  toggleCompetitorSentiment: (id: string) =>
    request<{ ok: boolean; card: CompetitorCard }>(`/competitor-cards/cards/${id}/toggle-sentiment`, { method: "PATCH" }),

  runCompetitorCardNow: (id: string) =>
    request<{ ok: boolean; result: any }>(`/competitor-cards/cards/run-card/${id}`, { method: "POST" }),

  runAllCompetitorCardsNow: () =>
    request<{ ok: boolean; message: string; newItems?: number }>("/competitor-cards/cards/run-all", { method: "POST" }),

  getCompetitorItems: (filters: { platform?: string; search?: string; page?: number; pageSize?: number }) =>
    request<ItemsResponse>(`/competitors/items${toQuery(filters)}`),

  getCompetitorOverview: () => request<CompetitorOverview>("/competitors/overview"),

  seedCompetitors: () => request<{ ok: boolean; seededCards: number; taggedPosts: number; taggedComments: number; message: string }>("/competitors/seed", { method: "POST" }),

  exportToExcel: (filters: { scope?: string; platform?: string; keyword?: string; dateFrom?: string; dateTo?: string; sentiment?: string; search?: string; author?: string } = {}) => {
    const url = `${BASE_URL}/export/excel${toQuery(filters)}`;
    window.open(url, "_blank");
  },

  exportGoogleToExcel: async (data: {
    items?: GoogleMention[];
    filters?: {
      platform?: string;
      dateRangeLabel?: string;
      dateFrom?: string;
      dateTo?: string;
      query?: string;
    };
  } = {}) => {
    if (data.items && data.items.length > 0) {
      const res = await fetch(`${BASE_URL}/google-scraper/export-excel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        throw new Error("Failed to export Google Excel report.");
      }
      const blob = await res.blob();
      const safePlat = (data.filters?.platform || "All").replace(/[^a-zA-Z0-9_-]/g, "_");
      const dateLabel = (data.filters?.dateRangeLabel || "AllTime").replace(/[^a-zA-Z0-9_-]/g, "_");
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `Google_Mentions_${safePlat}_${dateLabel}_${timestamp}.xlsx`;

      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    } else {
      const queryParams: Record<string, string | undefined> = {
        platform: data.filters?.platform,
        q: data.filters?.query,
        dateRangeLabel: data.filters?.dateRangeLabel,
        dateFrom: data.filters?.dateFrom,
        dateTo: data.filters?.dateTo,
      };
      const url = `${BASE_URL}/google-scraper/export-excel${toQuery(queryParams)}`;
      window.open(url, "_blank");
    }
  },
};

