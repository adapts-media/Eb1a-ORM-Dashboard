import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { runPythonSocialScraper } from "../services/pythonScraperService";
import { normalizeApifyItems } from "../services/dataNormalizer";
import { buildSourceKey } from "../lib/hash";
import { ProcessingStatus } from "../types/status";
import { analyzePost, analyzeComment } from "../services/pipelineService";
import { computePurgeAt, logDeletion, logRestore } from "../services/queryService";

export const competitorsRouter = Router();

// Stores scraped competitor items. AI sentiment analysis is opt-in per
// competitor card (CompetitorCard.sentimentEnabled) — feature: "turn on
// sentiment scoring for competitors". When disabled (the default), items
// are stamped with a placeholder verdict — status ANALYZED, sentiment
// NEUTRAL, confidence 1.0 — the exact same stamp `reset_competitor_sentiment.ts`
// knows how to clear, so a card can be switched on later and its backlog
// picked up for real analysis. Competitor items are still excluded from
// negative-mention email alerts — those exist to flag your own reputation,
// not a rival's.
export async function runCompetitorScrapePipeline(
  term: string,
  platformName: string,
  rawPayload: any[],
  sentimentEnabled = false
) {
  const normalized = normalizeApifyItems(rawPayload);

  const dbKeyword = await prisma.keyword.upsert({
    where: { term },
    create: { term },
    update: { deletedAt: null, purgeAt: null },
  });

  const scrapeRun = await prisma.scrapeRun.create({
    data: {
      keywordId: dbKeyword.id,
      status: ProcessingStatus.ANALYZED,
      rawResponse: JSON.stringify(rawPayload),
      itemCount: normalized.posts.length + normalized.standaloneComments.length,
      completedAt: new Date(),
    },
  });

  let postsCreated = 0;
  let postsSkippedExisting = 0;
  let commentsCreated = 0;
  let commentsSkippedExisting = 0;
  const createdPostIds: string[] = [];
  const createdCommentIds: string[] = [];
  // Scraper-side comment id -> stored DB id, for reply threading.
  const commentIdMap = new Map<string, string>();

  // When sentiment is off: stamp the placeholder verdict at creation time so
  // the item never enters RECEIVED status and can never be picked up by the
  // hourly backlog sweep (pipelineService.ts's analyzeBacklog) — gating only
  // the analyze calls below would not be enough, since that sweep has no
  // per-card awareness and would silently re-analyze it anyway.
  const neutralPlaceholder = {
    status: ProcessingStatus.ANALYZED,
    sentiment: "NEUTRAL" as const,
    confidence: 1.0,
    analyzedAt: new Date(),
  };
  const pendingAnalysis = { status: ProcessingStatus.RECEIVED };
  const itemStamp = sentimentEnabled ? pendingAnalysis : neutralPlaceholder;

  for (const post of normalized.posts) {
    const sourceKey = buildSourceKey({
      keyword: term,
      type: "post",
      id: post.id,
      url: post.url,
      text: post.text,
      author: post.author,
    });

    const existing = await prisma.post.findFirst({
      where: {
        OR: [
          { sourceKey },
          { AND: [{ keywordId: dbKeyword.id }, { url: post.url, NOT: { url: null } }] },
        ],
      },
    });

    let currentPostId: string | null = null;

    if (existing) {
      postsSkippedExisting++;
      currentPostId = existing.id;
      if (!existing.isCompetitor) {
        await prisma.post.update({
          where: { id: existing.id },
          data: { isCompetitor: true },
        });
      }
    } else {
      const created = await prisma.post.create({
        data: {
          sourceKey,
          keywordId: dbKeyword.id,
          scrapeRunId: scrapeRun.id,
          platform: post.platform || platformName,
          title: post.text ? post.text.slice(0, 100) : null,
          text: post.text || null,
          url: post.url || null,
          author: post.author || null,
          authorUrl: post.authorUrl || null,
          publishedAt: post.publishedAt ? new Date(post.publishedAt) : null,
          likes: post.likes ?? null,
          shares: post.shares ?? null,
          commentsCount: post.commentsCount ?? null,
          rawItem: JSON.stringify(post.raw || {}),
          isCompetitor: true,
          ...itemStamp,
        },
      });
      postsCreated++;
      currentPostId = created.id;
      if (sentimentEnabled) createdPostIds.push(created.id);
    }

    // Process nested comments for this post
    if (Array.isArray(post.comments)) {
      for (const c of post.comments) {
        const cSourceKey = buildSourceKey({
          keyword: term,
          type: "comment",
          id: c.id,
          url: c.url,
          text: c.text,
          author: c.author,
        });

        const existingC = await prisma.comment.findFirst({
          where: {
            OR: [
              { sourceKey: cSourceKey },
              { AND: [{ keywordId: dbKeyword.id }, { url: c.url, NOT: { url: null } }] },
            ],
          },
        });

        if (existingC) {
          commentsSkippedExisting++;
          if (c.id) commentIdMap.set(c.id, existingC.id);
          if (!existingC.isCompetitor) {
            await prisma.comment.update({
              where: { id: existingC.id },
              data: { isCompetitor: true },
            });
          }
        } else {
          const createdComment = await prisma.comment.create({
            data: {
              sourceKey: cSourceKey,
              keywordId: dbKeyword.id,
              scrapeRunId: scrapeRun.id,
              postId: currentPostId,
              parentCommentId: c.parentId ? commentIdMap.get(c.parentId) ?? null : null,
              depth: c.depth ?? 0,
              text: c.text || null,
              url: c.url || null,
              author: c.author || null,
              authorUrl: c.authorUrl || null,
              publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
              likes: c.likes ?? null,
              rawItem: JSON.stringify(c.raw || {}),
              isCompetitor: true,
              ...itemStamp,
            },
          });
          commentsCreated++;
          if (sentimentEnabled) createdCommentIds.push(createdComment.id);
          if (c.id) commentIdMap.set(c.id, createdComment.id);
        }
      }
    }
  }

  for (const c of normalized.standaloneComments) {
    const sourceKey = buildSourceKey({
      keyword: term,
      type: "comment",
      id: c.id,
      url: c.url,
      text: c.text,
      author: c.author,
    });

    const existing = await prisma.comment.findFirst({
      where: {
        OR: [
          { sourceKey },
          { AND: [{ keywordId: dbKeyword.id }, { url: c.url, NOT: { url: null } }] },
        ],
      },
    });

    if (existing) {
      commentsSkippedExisting++;
      if (!existing.isCompetitor) {
        await prisma.comment.update({
          where: { id: existing.id },
          data: { isCompetitor: true },
        });
      }
    } else {
      const createdStandalone = await prisma.comment.create({
        data: {
          sourceKey,
          keywordId: dbKeyword.id,
          scrapeRunId: scrapeRun.id,
          text: c.text || null,
          url: c.url || null,
          author: c.author || null,
          authorUrl: c.authorUrl || null,
          publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
          likes: c.likes ?? null,
          rawItem: JSON.stringify(c.raw || {}),
          isCompetitor: true,
          ...itemStamp,
        },
      });
      commentsCreated++;
      if (sentimentEnabled) createdCommentIds.push(createdStandalone.id);
    }
  }

  // Run Mistral sentiment on the newly stored competitor items — only when
  // this card has opted in. Relevance is checked against the competitor's
  // own name (`term`), not the brand's.
  let analyzed = 0;
  let failed = 0;
  if (sentimentEnabled) {
    for (const id of createdPostIds) (await analyzePost(id, term)) ? analyzed++ : failed++;
    for (const id of createdCommentIds) (await analyzeComment(id, term)) ? analyzed++ : failed++;
  }

  return {
    scrapeRunId: scrapeRun.id,
    postsCreated,
    postsSkippedExisting,
    commentsCreated,
    commentsSkippedExisting,
    analyzed,
    failed,
    sentimentEnabled,
  };
}

// GET /api/competitor-cards — list all (non-deleted) competitor cards
competitorsRouter.get("/cards", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cards = await (prisma as any).competitorCard.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    res.json({ cards });
  } catch (err) {
    next(err);
  }
});

// POST /api/competitor-cards — add a new competitor card
competitorsRouter.post("/cards", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platform, keyword, searchUrl } = req.body ?? {};
    if (!platform || !keyword || typeof keyword !== "string" || !keyword.trim()) {
      return res.status(400).json({ error: "Platform and keyword are required." });
    }

    const cleanPlatform = String(platform).toLowerCase().trim();
    const cleanKeyword = keyword.trim();
    const cleanUrl = searchUrl && typeof searchUrl === "string" ? searchUrl.trim() : null;

    // Upsert also revives a soft-deleted card with the same platform+keyword.
    const card = await (prisma as any).competitorCard.upsert({
      where: { platform_keyword: { platform: cleanPlatform, keyword: cleanKeyword } },
      create: {
        platform: cleanPlatform,
        keyword: cleanKeyword,
        searchUrl: cleanUrl,
        enabled: true,
      },
      update: {
        searchUrl: cleanUrl,
        enabled: true,
        deletedAt: null,
        purgeAt: null,
      },
    });

    await syncCompetitorFlags();

    res.json({ ok: true, card });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/competitor-cards/:id — soft-deletes with a 24h undo window
// instead of an immediate hard delete.
competitorsRouter.delete("/cards/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { actor } = req.body ?? {};

    const card = await (prisma as any).competitorCard.findUnique({ where: { id } });
    if (!card) return res.json({ ok: true, message: "Competitor card deleted." });

    const purgeAt = computePurgeAt();
    await (prisma as any).competitorCard.update({ where: { id }, data: { deletedAt: new Date(), purgeAt } });
    await logDeletion("CompetitorCard", id, `${card.platform}: ${card.keyword}`, typeof actor === "string" ? actor : undefined);
    await syncCompetitorFlags();

    res.json({ ok: true, message: "Competitor card moved to trash. It can be restored within 24 hours.", purgeAt });
  } catch (err) {
    next(err);
  }
});

// POST /api/competitor-cards/:id/restore — undoes a delete within the grace window
competitorsRouter.post("/cards/:id/restore", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const card = await (prisma as any).competitorCard.findUnique({ where: { id } });
    if (!card || !card.deletedAt) {
      return res.status(404).json({ error: "Competitor card not found in trash." });
    }

    const restored = await (prisma as any).competitorCard.update({ where: { id }, data: { deletedAt: null, purgeAt: null } });
    await logRestore("CompetitorCard", id);
    await syncCompetitorFlags();

    res.json({ ok: true, card: restored, message: "Competitor card restored." });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/competitor-cards/:id/toggle
competitorsRouter.patch("/cards/:id/toggle", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const card = await (prisma as any).competitorCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: "Card not found." });

    const updated = await (prisma as any).competitorCard.update({
      where: { id },
      data: { enabled: !card.enabled },
    });

    res.json({ ok: true, card: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/competitor-cards/:id/toggle-sentiment — feature: "turn on
// sentiment scoring for competitors". Opt-in per card, so enabling AI
// analysis for one competitor never silently increases spend for the rest.
competitorsRouter.patch("/cards/:id/toggle-sentiment", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const card = await (prisma as any).competitorCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: "Card not found." });

    const updated = await (prisma as any).competitorCard.update({
      where: { id },
      data: { sentimentEnabled: !card.sentimentEnabled },
    });

    res.json({ ok: true, card: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/competitor-cards/run-card/:id — execute scraping for a single competitor card.
// AI sentiment only runs if this card has sentimentEnabled = true.
competitorsRouter.post("/cards/run-card/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const card = await (prisma as any).competitorCard.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: "Card not found." });

    const keyword = card.keyword;
    const platform = card.platform;
    const url = card.searchUrl || undefined;

    const rawItems = await runPythonSocialScraper({
      keyword,
      url,
      limit: 100,
      platform: platform as any,
    });

    const result = await runCompetitorScrapePipeline(keyword, platform, rawItems, Boolean(card.sentimentEnabled));
    await syncCompetitorFlags();

    await (prisma as any).competitorCard.update({
      where: { id },
      data: { lastRunAt: new Date() },
    });

    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/competitor-cards/run-all — run all enabled competitor cards
competitorsRouter.post("/cards/run-all", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const activeCards = await (prisma as any).competitorCard.findMany({
      where: { enabled: true, deletedAt: null },
    });

    if (activeCards.length === 0) {
      return res.json({ ok: true, message: "No active competitor cards found.", newItems: 0 });
    }

    let totalNew = 0;
    for (const card of activeCards) {
      try {
        const rawItems = await runPythonSocialScraper({
          keyword: card.keyword,
          url: card.searchUrl || undefined,
          limit: 100,
          platform: card.platform as any,
        });
        const res = await runCompetitorScrapePipeline(card.keyword, card.platform, rawItems, Boolean(card.sentimentEnabled));
        totalNew += (res.postsCreated || 0) + (res.commentsCreated || 0);
        await (prisma as any).competitorCard.update({
          where: { id: card.id },
          data: { lastRunAt: new Date() },
        });
      } catch (err: any) {
        console.error(`Failed competitor card ${card.keyword}:`, err.message);
      }
    }

    await syncCompetitorFlags();

    res.json({ ok: true, message: `Scraped ${activeCards.length} competitor card(s).`, newItems: totalNew });
  } catch (err) {
    next(err);
  }
});

// GET /api/competitors/items — retrieve competitor posts & comments (no AI sentiment filter needed)
competitorsRouter.get("/items", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = (req.query.platform as string) || "all";
    const search = (req.query.search as string) || "";
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;

    const wherePost: any = { isCompetitor: true, deletedAt: null };
    const whereComment: any = { isCompetitor: true, deletedAt: null };

    if (platform && platform !== "all") {
      const platLower = platform.toLowerCase().trim();
      wherePost.platform = { equals: platLower, mode: "insensitive" };
      whereComment.OR = [
        { post: { platform: { equals: platLower, mode: "insensitive" } } },
        { url: { contains: platLower, mode: "insensitive" } },
      ];
    }
    if (search.trim()) {
      const searchFilter = [
        { text: { contains: search, mode: "insensitive" } },
        { title: { contains: search, mode: "insensitive" } },
        { author: { contains: search, mode: "insensitive" } },
      ];
      wherePost.OR = searchFilter;
      whereComment.OR = [
        { text: { contains: search, mode: "insensitive" } },
        { author: { contains: search, mode: "insensitive" } },
      ];
    }

    const [posts, comments] = await Promise.all([
      prisma.post.findMany({
        where: wherePost,
        include: { keyword: true },
        orderBy: { publishedAt: "desc" },
      }),
      prisma.comment.findMany({
        where: whereComment,
        include: { keyword: true, post: true },
        orderBy: { publishedAt: "desc" },
      }),
    ]);

    const inferPlatform = (itemUrl: string | null, postPlat?: string | null) => {
      if (postPlat) return postPlat;
      if (!itemUrl) return "web";
      const u = itemUrl.toLowerCase();
      if (u.includes("quora")) return "quora";
      if (u.includes("teamblind")) return "teamblind";
      if (u.includes("trustpilot")) return "trustpilot";
      if (u.includes("linkedin")) return "linkedin";
      if (u.includes("reddit")) return "reddit";
      return "web";
    };

    const allItems = [
      ...posts.map((p) => ({
        id: p.id,
        type: "post" as const,
        platform: inferPlatform(p.url, p.platform),
        keyword: p.keyword.term,
        text: p.text || p.title || "",
        url: p.url,
        author: p.author,
        authorUrl: p.authorUrl,
        publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
        likes: p.likes,
        shares: p.shares,
        commentsCount: p.commentsCount,
        status: p.status,
        sentiment: p.sentiment,
        confidence: p.confidence,
        rawItem: p.rawItem,
      })),
      ...comments.map((c) => ({
        id: c.id,
        type: "comment" as const,
        platform: inferPlatform(c.url, c.post?.platform),
        keyword: c.keyword.term,
        text: c.text || "",
        url: c.url,
        author: c.author,
        authorUrl: c.authorUrl,
        publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
        likes: c.likes,
        shares: null,
        commentsCount: null,
        status: c.status,
        sentiment: c.sentiment,
        confidence: c.confidence,
        rawItem: c.rawItem,
      })),
    ].sort((a, b) => {
      const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return db - da;
    });

    const total = allItems.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedItems = allItems.slice(startIndex, startIndex + pageSize);

    res.json({
      items: paginatedItems,
      pagination: {
        page,
        pageSize,
        total,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/competitors/overview — get overview metrics for Competitor Dashboard
competitorsRouter.get("/overview", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [totalPosts, totalComments, activeCardsCount, cards] = await Promise.all([
      prisma.post.count({ where: { isCompetitor: true, deletedAt: null } }),
      prisma.comment.count({ where: { isCompetitor: true, deletedAt: null } }),
      (prisma as any).competitorCard.count({ where: { enabled: true, deletedAt: null } }),
      (prisma as any).competitorCard.findMany({ where: { deletedAt: null } }),
    ]);

    const totalMentions = totalPosts + totalComments;

    res.json({
      totalMentions,
      totalPosts,
      totalComments,
      activeCardsCount,
      totalCardsCount: cards.length,
    });
  } catch (err) {
    next(err);
  }
});

export async function syncCompetitorFlags() {
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
    console.warn("Notice syncing competitor flags:", e);
  }
}

// POST /api/competitors/seed — seeds default competitor cards and classifies brand vs competitor items
competitorsRouter.post("/seed", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const existingCards = await (prisma as any).competitorCard.findMany();
    let seededCards = 0;

    if (existingCards.length === 0) {
      const defaults = [
        { platform: "reddit", keyword: "GreenCard Inc.", searchUrl: "https://www.reddit.com/search/?type=comments&q=GreenCard%20Inc&sort=relevance&safe=0" },
        { platform: "quora", keyword: "Manifest Law", searchUrl: "https://www.quora.com/search?q=Manifest%20Law" },
        { platform: "teamblind", keyword: "Smart Green Card", searchUrl: "https://www.teamblind.com/search/Smart%20Green%20Card" },
        { platform: "trustpilot", keyword: "Ellis Porter", searchUrl: "https://www.trustpilot.com/search?query=Ellis%20Porter" },
      ];

      for (const card of defaults) {
        await (prisma as any).competitorCard.upsert({
          where: { platform_keyword: { platform: card.platform, keyword: card.keyword } },
          create: { platform: card.platform, keyword: card.keyword, searchUrl: card.searchUrl, enabled: true },
          update: {},
        });
        seededCards++;
      }
    }

    await syncCompetitorFlags();

    const brandPostsCount = await prisma.post.count({ where: { isCompetitor: false } });
    const compPostsCount = await prisma.post.count({ where: { isCompetitor: true } });

    res.json({
      ok: true,
      seededCards,
      brandPostsCount,
      compPostsCount,
      message: `Database synchronized cleanly: ${brandPostsCount} brand items on Overview Dashboard, ${compPostsCount} competitor items on Competitor Dashboard.`,
    });
  } catch (err) {
    next(err);
  }
});
