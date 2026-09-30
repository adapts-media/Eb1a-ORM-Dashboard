import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { Sentiment, SentimentValue } from "../types/status";
import { BRAND_GROUP_NAME, BRAND_NAME_VARIANTS } from "../config/brand";

export interface ItemFilters {
  keyword?: string;
  sentiment?: SentimentValue;
  type?: "post" | "comment" | "both";
  // Any platform label present in the data (reddit, quora, news, youtube, web, ...) or "all".
  platform?: string;
  // Which subsystem found the mention: "scraper", "google", or undefined for both.
  source?: "scraper" | "google";
  dateFrom?: Date;
  dateTo?: Date;
  author?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

function postWhere(f: ItemFilters): Prisma.PostWhereInput {
  const conditions: Prisma.PostWhereInput[] = [
    { isCompetitor: false },
    // Deletion safety net: soft-deleted rows never show up in normal views.
    { deletedAt: null },
  ];

  if (f.source) {
    conditions.push({ source: f.source });
  }

  if (f.keyword && f.keyword.trim()) {
    const kw = f.keyword.trim();
    conditions.push({
      keyword: {
        term: {
          equals: kw,
          mode: "insensitive",
        },
      },
    });
  }

  if (f.sentiment) {
    conditions.push({ sentiment: f.sentiment });
  }

  if (f.platform && f.platform !== "all") {
    const p = f.platform.toLowerCase().trim();
    conditions.push({
      OR: [
        { platform: { equals: p, mode: "insensitive" } },
        { url: { contains: p, mode: "insensitive" } },
      ],
    });
  }

  if (f.dateFrom || f.dateTo) {
    const dateFilter: Prisma.DateTimeNullableFilter = {};
    if (f.dateFrom) dateFilter.gte = f.dateFrom;
    if (f.dateTo) dateFilter.lte = f.dateTo;
    conditions.push({ publishedAt: dateFilter });
  }

  if (f.author && f.author.trim()) {
    conditions.push({
      author: { contains: f.author.trim(), mode: "insensitive" },
    });
  }

  if (f.search && f.search.trim()) {
    const s = f.search.trim();
    conditions.push({
      OR: [
        { text: { contains: s, mode: "insensitive" } },
        { author: { contains: s, mode: "insensitive" } },
        { title: { contains: s, mode: "insensitive" } },
      ],
    });
  }

  return conditions.length > 0 ? { AND: conditions } : {};
}

function commentWhere(f: ItemFilters): Prisma.CommentWhereInput {
  const conditions: Prisma.CommentWhereInput[] = [
    { isCompetitor: false },
    { deletedAt: null },
  ];

  if (f.source === "google") {
    // Google SERP results are posts only; no comment can match this filter.
    conditions.push({ id: { equals: "__never__" } });
  }

  if (f.keyword && f.keyword.trim()) {
    const kw = f.keyword.trim();
    conditions.push({
      keyword: {
        term: {
          equals: kw,
          mode: "insensitive",
        },
      },
    });
  }

  if (f.sentiment) {
    conditions.push({ sentiment: f.sentiment });
  }

  if (f.platform && f.platform !== "all") {
    const p = f.platform.toLowerCase().trim();
    conditions.push({
      OR: [
        { post: { platform: { equals: p, mode: "insensitive" } } },
        { url: { contains: p, mode: "insensitive" } },
      ],
    });
  }

  if (f.dateFrom || f.dateTo) {
    const dateFilter: Prisma.DateTimeNullableFilter = {};
    if (f.dateFrom) dateFilter.gte = f.dateFrom;
    if (f.dateTo) dateFilter.lte = f.dateTo;
    conditions.push({ publishedAt: dateFilter });
  }

  if (f.author && f.author.trim()) {
    conditions.push({
      author: { contains: f.author.trim(), mode: "insensitive" },
    });
  }

  if (f.search && f.search.trim()) {
    const s = f.search.trim();
    conditions.push({
      OR: [
        { text: { contains: s, mode: "insensitive" } },
        { author: { contains: s, mode: "insensitive" } },
      ],
    });
  }

  return conditions.length > 0 ? { AND: conditions } : {};
}

export async function purgeSeedKeyword() {
  try {
    const seedKws = await prisma.keyword.findMany({
      where: {
        OR: [
          { term: { equals: "seed", mode: "insensitive" } },
          { term: { equals: "Seed", mode: "insensitive" } },
        ],
      },
    });

    for (const kw of seedKws) {
      await prisma.comment.deleteMany({ where: { keywordId: kw.id } });
      await prisma.post.deleteMany({ where: { keywordId: kw.id } });
      await prisma.scrapeRun.deleteMany({ where: { keywordId: kw.id } });
      await prisma.keyword.delete({ where: { id: kw.id } }).catch(() => {});
    }
  } catch (e) {
    // Ignore if DB busy
  }
}

let lastSyncTime = 0;

export async function syncCompetitorFlags() {
  const now = Date.now();
  if (now - lastSyncTime < 30000) return;
  lastSyncTime = now;

  try {
    const competitorCards = await (prisma as any).competitorCard.findMany().catch(() => []);
    const compKeywordTerms = new Set(competitorCards.map((c: any) => c.keyword.toLowerCase().trim()));

    const competitorNames = ["greencard inc.", "manifest law", "smart green card", "ellis porter", "alma law"];
    competitorNames.forEach((n) => compKeywordTerms.add(n));

    const allKeywords = await prisma.keyword.findMany();

    const brandKwIds: string[] = [];
    const compKwIds: string[] = [];

    for (const kw of allKeywords) {
      const termLower = kw.term.toLowerCase().trim();
      if (compKeywordTerms.has(termLower)) {
        compKwIds.push(kw.id);
      } else {
        brandKwIds.push(kw.id);
      }
    }

    if (brandKwIds.length > 0) {
      await prisma.post.updateMany({
        where: { keywordId: { in: brandKwIds } },
        data: { isCompetitor: false },
      });
      await prisma.comment.updateMany({
        where: { keywordId: { in: brandKwIds } },
        data: { isCompetitor: false },
      });
    }

    if (compKwIds.length > 0) {
      await prisma.post.updateMany({
        where: { keywordId: { in: compKwIds } },
        data: { isCompetitor: true },
      });
      await prisma.comment.updateMany({
        where: { keywordId: { in: compKwIds } },
        data: { isCompetitor: true },
      });
    }
  } catch (e) {
    // Ignore error
  }
}

// ---------------------------------------------------------------------------
// Feature: deletion safety net (24h soft-delete + undo + audit log)
// ---------------------------------------------------------------------------

export const DELETION_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export function computePurgeAt(): Date {
  return new Date(Date.now() + DELETION_GRACE_PERIOD_MS);
}

/**
 * Records a soft-delete in the audit log. `label` is a short, human-readable
 * snapshot captured at delete time so the log stays meaningful even after
 * the row is purged. No auth/session system exists in this app, so `actor`
 * is a best-effort free-text field the UI asks for, not a real user id.
 */
export async function logDeletion(entityType: string, entityId: string, label: string, actor?: string | null) {
  try {
    await prisma.deletionLog.create({
      data: {
        entityType,
        entityId,
        label: label.slice(0, 500),
        actor: actor && actor.trim() ? actor.trim().slice(0, 200) : null,
      },
    });
  } catch (e) {
    console.warn(`Notice: failed to write DeletionLog entry for ${entityType}:${entityId}`, e);
  }
}

/** Marks the most recent open DeletionLog entry for this entity as restored. */
export async function logRestore(entityType: string, entityId: string) {
  try {
    await prisma.deletionLog.updateMany({
      where: { entityType, entityId, restoredAt: null, purgedAt: null },
      data: { restoredAt: new Date() },
    });
  } catch (e) {
    console.warn(`Notice: failed to update DeletionLog entry for ${entityType}:${entityId}`, e);
  }
}

/** Walks parentCommentId downward (any depth) to find a comment's full descendant set, itself included. */
async function findCommentDescendantIds(rootId: string): Promise<string[]> {
  const idsToProcess = [rootId];
  const allIds: string[] = [];
  while (idsToProcess.length > 0) {
    const currentId = idsToProcess.shift()!;
    allIds.push(currentId);
    const children = await prisma.comment.findMany({ where: { parentCommentId: currentId }, select: { id: true } });
    idsToProcess.push(...children.map((c) => c.id));
  }
  return allIds;
}

/** Soft-deletes a standalone comment and all of its descendant replies (any depth) with one shared purgeAt. */
export async function softDeleteCommentTree(commentId: string): Promise<{ purgeAt: Date; affectedIds: string[] }> {
  const affectedIds = await findCommentDescendantIds(commentId);
  const deletedAt = new Date();
  const purgeAt = computePurgeAt();
  await prisma.comment.updateMany({ where: { id: { in: affectedIds } }, data: { deletedAt, purgeAt } });
  return { purgeAt, affectedIds };
}

/** Restores a comment and its descendant replies that were soft-deleted alongside it. */
export async function restoreCommentTree(commentId: string): Promise<string[]> {
  const affectedIds = await findCommentDescendantIds(commentId);
  await prisma.comment.updateMany({ where: { id: { in: affectedIds } }, data: { deletedAt: null, purgeAt: null } });
  return affectedIds;
}

let lastPurgeTime = 0;

/**
 * Hard-deletes anything whose 24h grace window has passed. Lazy, throttled
 * sweep (same pattern as syncCompetitorFlags above) rather than a dedicated
 * cron job — piggybacks on whatever read touches an affected list next.
 *
 * Safe w.r.t. the Comment self-referencing FK (parentComment, onDelete:
 * NoAction): every soft-delete route cascades the SAME deletedAt/purgeAt to
 * a row's full descendant tree at delete time (a post's comments, or a
 * comment's own replies), so by the time anything is due for purge, every
 * row that still references it via parentCommentId/postId is either
 * already gone or is purged in the very same deleteMany call — and Postgres
 * only checks NO ACTION constraints at the end of each statement, so a
 * whole connected subtree removed in one deleteMany never trips the FK.
 */
export async function purgeExpiredDeletions() {
  const now = Date.now();
  if (now - lastPurgeTime < 30000) return;
  lastPurgeTime = now;

  const cutoff = new Date();

  try {
    const expiredComments = await prisma.comment.findMany({ where: { purgeAt: { lte: cutoff } }, select: { id: true } });
    if (expiredComments.length > 0) {
      const ids = expiredComments.map((c) => c.id);
      await prisma.comment.deleteMany({ where: { id: { in: ids } } });
      await prisma.deletionLog.updateMany({ where: { entityType: "Comment", entityId: { in: ids }, purgedAt: null }, data: { purgedAt: cutoff } });
    }

    const expiredPosts = await prisma.post.findMany({ where: { purgeAt: { lte: cutoff } }, select: { id: true } });
    if (expiredPosts.length > 0) {
      const ids = expiredPosts.map((p) => p.id);
      // Defensive: any comment still attached shouldn't exist (posts cascade
      // the same purgeAt to their comments at delete time, so the sweep
      // above already removed them), but this covers any edge case cleanly.
      await prisma.comment.deleteMany({ where: { postId: { in: ids } } });
      await prisma.post.deleteMany({ where: { id: { in: ids } } });
      await prisma.deletionLog.updateMany({ where: { entityType: "Post", entityId: { in: ids }, purgedAt: null }, data: { purgedAt: cutoff } });
    }

    const expiredKeywords = await prisma.keyword.findMany({ where: { purgeAt: { lte: cutoff } }, select: { id: true } });
    for (const kw of expiredKeywords) {
      await prisma.comment.deleteMany({ where: { keywordId: kw.id } });
      await prisma.post.deleteMany({ where: { keywordId: kw.id } });
      await prisma.scrapeRun.deleteMany({ where: { keywordId: kw.id } });
      await prisma.keyword.delete({ where: { id: kw.id } }).catch(() => {});
    }
    if (expiredKeywords.length > 0) {
      const ids = expiredKeywords.map((k) => k.id);
      await prisma.deletionLog.updateMany({ where: { entityType: "Keyword", entityId: { in: ids }, purgedAt: null }, data: { purgedAt: cutoff } });
    }

    const expiredPlatformCards = await (prisma as any).platformKeyword.findMany({ where: { purgeAt: { lte: cutoff } }, select: { id: true } }).catch(() => []);
    if (expiredPlatformCards.length > 0) {
      const ids = expiredPlatformCards.map((c: any) => c.id);
      await (prisma as any).platformKeyword.deleteMany({ where: { id: { in: ids } } });
      await prisma.deletionLog.updateMany({ where: { entityType: "PlatformKeyword", entityId: { in: ids }, purgedAt: null }, data: { purgedAt: cutoff } });
    }

    const expiredCompCards = await (prisma as any).competitorCard.findMany({ where: { purgeAt: { lte: cutoff } }, select: { id: true } }).catch(() => []);
    if (expiredCompCards.length > 0) {
      const ids = expiredCompCards.map((c: any) => c.id);
      await (prisma as any).competitorCard.deleteMany({ where: { id: { in: ids } } });
      await prisma.deletionLog.updateMany({ where: { entityType: "CompetitorCard", entityId: { in: ids }, purgedAt: null }, data: { purgedAt: cutoff } });
    }
  } catch (e) {
    console.warn("Notice: purge sweep failed:", e);
  }
}

export interface TrendBucket {
  total: number;
  positive: number;
  negative: number;
  neutral: number;
}

export interface TrendChange {
  abs: number;
  /** Percent change vs the previous window; null when that window was empty. */
  pct: number | null;
}

/** Counts mentions in one window, by sentiment. */
async function countWindow(f: ItemFilters, from: Date, to: Date): Promise<TrendBucket> {
  const windowed: ItemFilters = { ...f, dateFrom: from, dateTo: to };
  const [postAgg, commentAgg] = await Promise.all([
    prisma.post.groupBy({ by: ["sentiment"], where: postWhere(windowed), _count: true }),
    prisma.comment.groupBy({ by: ["sentiment"], where: commentWhere(windowed), _count: true }),
  ]);

  const bucket: TrendBucket = { total: 0, positive: 0, negative: 0, neutral: 0 };
  for (const row of [...postAgg, ...commentAgg]) {
    bucket.total += row._count;
    if (row.sentiment === Sentiment.POSITIVE) bucket.positive += row._count;
    else if (row.sentiment === Sentiment.NEGATIVE) bucket.negative += row._count;
    else if (row.sentiment === Sentiment.NEUTRAL) bucket.neutral += row._count;
  }
  return bucket;
}

function change(current: number, previous: number): TrendChange {
  return {
    abs: current - previous,
    // A jump from zero has no meaningful percentage, so report null rather than Infinity.
    pct: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10,
  };
}

/**
 * Week-over-week momentum: the last `windowDays` against the `windowDays` before it,
 * by publish date. createdAt would only measure how much scraping we happened to do.
 * Deliberately independent of any date range picked in the UI, so the arrows always
 * mean the same thing.
 */
export async function getTrend(f: ItemFilters = {}, windowDays = 7) {
  const now = new Date();
  const spanMs = windowDays * 24 * 60 * 60 * 1000;
  const currentFrom = new Date(now.getTime() - spanMs);
  const previousFrom = new Date(now.getTime() - spanMs * 2);

  const base: ItemFilters = { ...f, dateFrom: undefined, dateTo: undefined };
  const [current, previous] = await Promise.all([
    countWindow(base, currentFrom, now),
    countWindow(base, previousFrom, currentFrom),
  ]);

  return {
    windowDays,
    current,
    previous,
    change: {
      total: change(current.total, previous.total),
      positive: change(current.positive, previous.positive),
      negative: change(current.negative, previous.negative),
      neutral: change(current.neutral, previous.neutral),
    },
  };
}

export async function getOverview(
  keyword?: string,
  platform?: string,
  dateFrom?: Date,
  dateTo?: Date,
  source?: ItemFilters["source"]
) {
  await syncCompetitorFlags().catch(() => {});
  await purgeExpiredDeletions().catch(() => {});

  const f: ItemFilters = {
    keyword,
    platform: platform && platform !== "all" ? platform : undefined,
    dateFrom,
    dateTo,
    source,
  };
  const pWhere = postWhere(f);
  const cWhere = commentWhere(f);

  const [totalPosts, totalComments, postAgg, commentAgg, sourceAgg, platformAgg, trend] = await Promise.all([
    prisma.post.count({ where: pWhere }),
    prisma.comment.count({ where: cWhere }),
    prisma.post.groupBy({ by: ["sentiment"], where: pWhere, _count: true }),
    prisma.comment.groupBy({ by: ["sentiment"], where: cWhere, _count: true }),
    prisma.post.groupBy({ by: ["source"], where: pWhere, _count: true }),
    prisma.post.groupBy({ by: ["platform"], where: pWhere, _count: true }),
    getTrend(f),
  ]);

  const counts: Record<string, number> = { POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0 };
  for (const row of [...postAgg, ...commentAgg]) {
    if (row.sentiment) counts[row.sentiment] += row._count;
  }

  const totalAnalyzed = counts.POSITIVE + counts.NEGATIVE + counts.NEUTRAL;
  const pct = (n: number) => (totalAnalyzed > 0 ? Math.round((n / totalAnalyzed) * 1000) / 10 : 0);

  // One total, split by where it came from: scraper posts + their comments vs Google SERP posts.
  const googlePosts = sourceAgg.find((r) => r.source === "google")?._count ?? 0;
  const scraperPosts = totalPosts - googlePosts;
  const byPlatform: Record<string, number> = {};
  for (const row of platformAgg) {
    if (row.platform) byPlatform[row.platform.toLowerCase()] = (byPlatform[row.platform.toLowerCase()] || 0) + row._count;
  }

  return {
    totalPosts,
    totalComments,
    totalMentions: totalPosts + totalComments,
    trend,
    bySource: {
      scraper: scraperPosts + totalComments,
      google: googlePosts,
    },
    byPlatform,
    totalAnalyzed,
    positive: counts.POSITIVE,
    negative: counts.NEGATIVE,
    neutral: counts.NEUTRAL,
    positivePct: pct(counts.POSITIVE),
    negativePct: pct(counts.NEGATIVE),
    neutralPct: pct(counts.NEUTRAL),
  };
}

export async function getItems(f: ItemFilters) {
  await syncCompetitorFlags().catch(() => {});
  await purgeExpiredDeletions().catch(() => {});

  const page = f.page && f.page > 0 ? f.page : 1;
  const pageSize = f.pageSize && f.pageSize > 0 ? Math.min(f.pageSize, 200) : 50;
  const skip = (page - 1) * pageSize;

  const wantPosts = f.type !== "comment";
  const wantComments = f.type !== "post";

  const [posts, comments, postCount, commentCount] = await Promise.all([
    wantPosts
      ? prisma.post.findMany({
          where: postWhere(f),
          include: { keyword: true },
          orderBy: { publishedAt: "desc" },
          skip,
          take: pageSize,
        })
      : Promise.resolve([]),
    wantComments
      ? prisma.comment.findMany({
          where: commentWhere(f),
          include: { keyword: true, post: { select: { url: true, text: true } } },
          orderBy: { publishedAt: "desc" },
          skip,
          take: pageSize,
        })
      : Promise.resolve([]),
    wantPosts ? prisma.post.count({ where: postWhere(f) }) : Promise.resolve(0),
    wantComments ? prisma.comment.count({ where: commentWhere(f) }) : Promise.resolve(0),
  ]);

  const items = [
    ...posts.map((p) => ({ type: "post" as const, ...p, keyword: p.keyword.term })),
    ...comments.map((c) => ({ type: "comment" as const, ...c, keyword: c.keyword.term })),
  ].sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  }).slice(0, pageSize);

  return {
    items,
    pagination: { page, pageSize, totalPosts: postCount, totalComments: commentCount, total: postCount + commentCount },
  };
}

export async function getKeywords() {
  await purgeSeedKeyword();
  await syncCompetitorFlags().catch(() => {});
  await purgeExpiredDeletions().catch(() => {});

  const competitorCards = await (prisma as any).competitorCard.findMany().catch(() => []);
  const competitorTerms = new Set(competitorCards.map((c: any) => c.keyword.toLowerCase().trim()));

  const all = await prisma.keyword.findMany({
    where: {
      term: { notIn: ["seed", "Seed", "SEED"] },
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { posts: true, comments: true } } },
  });

  return all.filter((kw) => !competitorTerms.has(kw.term.toLowerCase().trim()));
}

export async function getSentimentDistribution(keyword?: string, platform?: string, dateFrom?: Date, dateTo?: Date) {
  return getOverview(keyword, platform, dateFrom, dateTo);
}

// ---------------------------------------------------------------------------
// Feature: merge duplicate brand trackers into one profile
// ---------------------------------------------------------------------------

/**
 * One-time-ish bootstrap: groups the brand's known spelling variants under a
 * single KeywordGroup so "Sentiment by Keyword" shows one merged card
 * instead of one per variant. Deliberately an explicit, hardcoded variant
 * list — not fuzzy matching — so a future unrelated keyword never gets
 * silently folded into the brand. Safe to call repeatedly (upserts); the
 * keyword upsert also revives a soft-deleted variant (clears
 * deletedAt/purgeAt) so it doesn't stay in the trash if scraping resumes.
 */
export async function ensureBrandKeywordGroup() {
  try {
    const group = await (prisma as any).keywordGroup.upsert({
      where: { name: BRAND_GROUP_NAME },
      create: { name: BRAND_GROUP_NAME },
      update: {},
    });

    for (const term of BRAND_NAME_VARIANTS) {
      const kw = await prisma.keyword.upsert({
        where: { term },
        create: { term, groupId: group.id },
        update: { deletedAt: null, purgeAt: null },
      });
      if (!(kw as any).groupId) {
        await prisma.keyword.update({ where: { id: kw.id }, data: { groupId: group.id } });
      }
    }
  } catch (e) {
    console.warn("Notice: could not seed brand keyword group:", e);
  }
}

function combineOverviews(rows: Array<Awaited<ReturnType<typeof getOverview>>>) {
  const totalPosts = rows.reduce((s, r) => s + r.totalPosts, 0);
  const totalComments = rows.reduce((s, r) => s + r.totalComments, 0);
  const positive = rows.reduce((s, r) => s + r.positive, 0);
  const negative = rows.reduce((s, r) => s + r.negative, 0);
  const neutral = rows.reduce((s, r) => s + r.neutral, 0);
  const totalAnalyzed = positive + negative + neutral;
  const pct = (n: number) => (totalAnalyzed > 0 ? Math.round((n / totalAnalyzed) * 1000) / 10 : 0);

  return {
    totalPosts,
    totalComments,
    totalMentions: totalPosts + totalComments,
    totalAnalyzed,
    positive,
    negative,
    neutral,
    positivePct: pct(positive),
    negativePct: pct(negative),
    neutralPct: pct(neutral),
  };
}

/**
 * Sentiment-by-keyword, with brand spelling variants merged into one row
 * (feature: "merge duplicate brand trackers"). Keywords belonging to a
 * KeywordGroup are combined into a single row labeled with the group's
 * name; the original per-variant numbers are still returned in `variants`
 * so the UI can show them on request. Ungrouped keywords behave exactly as
 * before — one row each.
 */
export async function getSentimentByKeyword() {
  await purgeSeedKeyword();
  await syncCompetitorFlags().catch(() => {});

  const competitorCards = await (prisma as any).competitorCard.findMany().catch(() => []);
  const competitorTerms = new Set(competitorCards.map((c: any) => c.keyword.toLowerCase().trim()));

  const keywords = await prisma.keyword.findMany({
    where: {
      term: { notIn: ["seed", "Seed", "SEED"] },
      deletedAt: null,
    },
    include: { group: true },
  });

  const standalone: typeof keywords = [];
  const groupMap = new Map<string, { name: string; terms: string[] }>();

  for (const kw of keywords) {
    const termClean = kw.term.toLowerCase().trim();
    if (competitorTerms.has(termClean)) continue;

    if ((kw as any).group) {
      const g = (kw as any).group as { id: string; name: string };
      const entry = groupMap.get(g.id) ?? { name: g.name, terms: [] };
      entry.terms.push(kw.term);
      groupMap.set(g.id, entry);
    } else {
      standalone.push(kw);
    }
  }

  const results: any[] = [];

  for (const kw of standalone) {
    const overview = await getOverview(kw.term);
    if (overview.totalMentions > 0) {
      results.push({ keyword: kw.term, ...overview });
    }
  }

  for (const [groupId, group] of groupMap) {
    const variants: any[] = [];
    for (const term of group.terms) {
      const overview = await getOverview(term);
      if (overview.totalMentions > 0) variants.push({ keyword: term, ...overview });
    }
    if (variants.length === 0) continue;

    results.push({
      keyword: group.name,
      ...combineOverviews(variants),
      isGroup: true,
      groupId,
      variants,
    });
  }

  return results;
}

export async function getSentimentByPlatform(keyword?: string, dateFrom?: Date, dateTo?: Date) {
  const platforms = ["reddit", "quora", "teamblind", "trustpilot"];
  const results = [];
  for (const p of platforms) {
    const overview = await getOverview(keyword, p, dateFrom, dateTo);
    results.push({ platform: p, ...overview });
  }
  return results;
}

export async function getSentimentOverTime(keyword?: string, platform?: string, dateFrom?: Date, dateTo?: Date) {
  const f: ItemFilters = {
    keyword,
    platform: (platform && platform !== "all" ? platform : undefined) as any,
    dateFrom,
    dateTo,
  };
  const pWhere = { ...postWhere(f), publishedAt: { not: null }, sentiment: { not: null } };
  const cWhere = { ...commentWhere(f), publishedAt: { not: null }, sentiment: { not: null } };

  const [posts, comments] = await Promise.all([
    prisma.post.findMany({
      where: pWhere,
      select: { publishedAt: true, sentiment: true },
    }),
    prisma.comment.findMany({
      where: cWhere,
      select: { publishedAt: true, sentiment: true },
    }),
  ]);

  const buckets = new Map<string, { date: string; POSITIVE: number; NEGATIVE: number; NEUTRAL: number }>();
  for (const row of [...posts, ...comments]) {
    if (!row.publishedAt || !row.sentiment) continue;
    const day = row.publishedAt.toISOString().slice(0, 10);
    if (!buckets.has(day)) buckets.set(day, { date: day, POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0 });
    const sentimentKey = row.sentiment as "POSITIVE" | "NEGATIVE" | "NEUTRAL";
    buckets.get(day)![sentimentKey]++;
  }

  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getNegativeItems(f: Omit<ItemFilters, "sentiment">) {
  return getItems({ ...f, sentiment: Sentiment.NEGATIVE });
}

export async function getNeutralItems(f: Omit<ItemFilters, "sentiment">) {
  return getItems({ ...f, sentiment: Sentiment.NEUTRAL });
}

export async function getPositiveItems(f: Omit<ItemFilters, "sentiment">) {
  return getItems({ ...f, sentiment: Sentiment.POSITIVE });
}

export async function globalSearch(q: string, limit = 50) {
  const query = q.trim();
  if (!query) return { posts: [], comments: [], keywords: [] };

  const [posts, comments, keywords] = await Promise.all([
    prisma.post.findMany({
      where: { deletedAt: null, OR: [{ text: { contains: query } }, { author: { contains: query } }] },
      include: { keyword: true },
      take: limit,
      orderBy: { publishedAt: "desc" },
    }),
    prisma.comment.findMany({
      where: { deletedAt: null, OR: [{ text: { contains: query } }, { author: { contains: query } }] },
      include: { keyword: true },
      take: limit,
      orderBy: { publishedAt: "desc" },
    }),
    prisma.keyword.findMany({ where: { term: { contains: query }, deletedAt: null } }),
  ]);

  return { posts, comments, keywords };
}

export async function getFailedItems() {
  const [posts, comments] = await Promise.all([
    prisma.post.findMany({ where: { status: "FAILED", deletedAt: null }, include: { keyword: true } }),
    prisma.comment.findMany({ where: { status: "FAILED", deletedAt: null }, include: { keyword: true } }),
  ]);
  return { posts, comments };
}
