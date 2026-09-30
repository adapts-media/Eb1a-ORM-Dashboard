export type Sentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL";
export type ProcessingStatus = "RECEIVED" | "PROCESSING" | "ANALYZED" | "FAILED";

export interface Overview {
  totalPosts: number;
  totalComments: number;
  totalMentions: number;
  /** Where the mentions came from. Both are already included in totalMentions. */
  bySource?: { scraper: number; google: number };
  /** Week-over-week momentum by publish date, independent of the selected range. */
  trend?: OverviewTrend;
  byPlatform?: Record<string, number>;
  totalAnalyzed: number;
  positive: number;
  negative: number;
  neutral: number;
  positivePct: number;
  negativePct: number;
  neutralPct: number;
}

export interface TrendBucket {
  total: number;
  positive: number;
  negative: number;
  neutral: number;
}

export interface TrendChange {
  abs: number;
  /** null when the previous window was empty, so there is no meaningful percentage. */
  pct: number | null;
}

export interface OverviewTrend {
  windowDays: number;
  current: TrendBucket;
  previous: TrendBucket;
  change: { total: TrendChange; positive: TrendChange; negative: TrendChange; neutral: TrendChange };
}

export interface KeywordSummary {
  id: string;
  term: string;
  createdAt: string;
  _count: { posts: number; comments: number };
}

export interface BaseItem {
  id: string;
  sourceKey: string;
  keyword: string;
  text: string | null;
  url: string | null;
  author: string | null;
  authorUrl: string | null;
  publishedAt: string | null;
  sentiment: Sentiment | null;
  confidence: number | null;
  status: ProcessingStatus;
  processingError: string | null;
  platform?: string | null;
  createdAt: string;
}

export interface PostItem extends BaseItem {
  type: "post";
  platform: string | null;
  likes: number | null;
  shares: number | null;
  commentsCount: number | null;
}

export interface CommentItem extends BaseItem {
  type: "comment";
  postId: string | null;
  likes: number | null;
  post?: { url: string | null; text: string | null } | null;
  /** Reply threading: top-level comments are depth 0 with no parent. */
  parentCommentId?: string | null;
  depth?: number;
}

export type FeedItem = PostItem | CommentItem;

export interface ItemsResponse {
  items: FeedItem[];
  pagination: { page: number; pageSize: number; totalPosts: number; totalComments: number; total: number };
}

export interface ItemFiltersQuery {
  keyword?: string;
  sentiment?: Sentiment;
  type?: "post" | "comment" | "both";
  // Any platform label in the data: the scraper feeds plus Google SERP ones
  // (news, web, youtube, facebook, ...).
  platform?: string;
  /** Restrict to how the mention was discovered. Omit for the combined feed. */
  source?: "scraper" | "google";
  dateFrom?: string;
  dateTo?: string;
  author?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface SentimentByKeywordRow extends Overview {
  keyword: string;
  // Feature: merge duplicate brand trackers. Present only for a merged
  // profile — the original per-variant numbers, still visible on request.
  isGroup?: boolean;
  groupId?: string;
  variants?: SentimentByKeywordRow[];
}

export interface SentimentByPlatformRow extends Overview {
  platform: string;
}

export interface SentimentOverTimeRow {
  date: string;
  POSITIVE: number;
  NEGATIVE: number;
  NEUTRAL: number;
}

export interface ScrapeResult {
  keyword: string;
  scrapeRunId: string;
  itemsReceived: number;
  postsCreated: number;
  commentsCreated: number;
  postsSkippedExisting: number;
  commentsSkippedExisting: number;
  analyzed: number;
  failed: number;
  warnings: string[];
}

export interface SearchResponse {
  posts: (PostItem & { keyword: string })[];
  comments: (CommentItem & { keyword: string })[];
  keywords: { id: string; term: string }[];
}

export interface DashboardSettings {
  apifyApiUrl: string;
  apifyApiKey: string;
  aiApiUrl: string;
  aiApiKey: string;
  aiModel: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPass?: string;
  gmailUser?: string;
  gmailPass?: string;
  mailFrom?: string;
  alertEmail?: string;
  searchApiKey?: string;
  serperApiKey?: string;
  mongodbUri?: string;
  mongodbDb?: string;
  databaseUrl?: string;
  apifyConfigured?: boolean;
  aiConfigured?: boolean;
  smtpConfigured?: boolean;
  gmailConfigured?: boolean;
  searchApiConfigured?: boolean;
  serperApiConfigured?: boolean;
  databaseConfigured?: boolean;
}

export interface ManualScrapePayload {
  keyword: string;
  url?: string;
  limit?: number;
  platform?: "reddit" | "quora" | "teamblind" | "trustpilot" | "linkedin" | "all";
}

export interface ManualScrapeResult {
  ok: boolean;
  keyword: string;
  scrapeRunId?: string;
  itemsReceived: number;
  postsCreated: number;
  commentsCreated: number;
  postsSkippedExisting?: number;
  commentsSkippedExisting?: number;
  analyzed: number;
  failed: number;
  warnings?: string[];
  message?: string;
  posts?: PostItem[];
  comments?: CommentItem[];
}

export interface PlatformKeywordCard {
  id: string;
  platform: string;
  keyword: string;
  searchUrl?: string | null;
  enabled: boolean;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompetitorCard {
  id: string;
  platform: string;
  keyword: string;
  searchUrl?: string | null;
  enabled: boolean;
  // Feature: turn on sentiment scoring for competitors. Opt-in per card;
  // off = items are stamped NEUTRAL with zero AI spend.
  sentimentEnabled?: boolean;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompetitorOverview {
  totalMentions: number;
  totalPosts: number;
  totalComments: number;
  activeCardsCount: number;
  totalCardsCount: number;
}

export interface CronLogItem {
  timestamp: string;
  platform: string;
  keyword: string;
  status: "SUCCESS" | "FAILED";
  newItems: number;
  message: string;
}

export interface CronStatus {
  isRunning: boolean;
  cronEnabled: boolean;
  lastCronRunAt?: string;
  nextCronRunAt?: string;
  logs: CronLogItem[];
}

export interface GoogleMention {
  id: string;
  title_key?: string;
  norm_url?: string;
  url: string;
  title: string;
  snippet?: string;
  domain: string;
  platform: string;
  source_id?: string;
  engine?: string;
  query?: string;
  published?: string;
  first_seen?: string;
  date_status?: "confirmed" | "estimated" | "unknown";
  /** Available now that Google mentions are stored alongside the scraper feeds. */
  sentiment?: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | null;
  confidence?: number | null;
  keyword?: string;
}

export interface GoogleMentionsResponse {
  brand: string;
  total: number;
  shown: number;
  counts: Record<string, number>;
  mentions: GoogleMention[];
}

export interface GoogleStatsResponse {
  total: number;
  counts: Record<string, number>;
}

export interface GoogleScanPayload {
  keyword?: string;
  engine?: string;
}

export interface GoogleIngestResult {
  ok: boolean;
  keyword: string;
  itemsReceived: number;
  postsCreated: number;
  postsSkipped: number;
  analyzed: number;
  failed: number;
  message: string;
}



