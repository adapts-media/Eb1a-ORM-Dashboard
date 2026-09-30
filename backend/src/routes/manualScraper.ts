import { Router } from "express";
import { prisma } from "../lib/prisma";
import { runPythonSocialScraper } from "../services/pythonScraperService";
import { normalizeApifyItems } from "../services/dataNormalizer";
import { buildSourceKey } from "../lib/hash";
import { ProcessingStatus } from "../types/status";
import { analyzePost, analyzeComment } from "../services/pipelineService";

export const manualScraperRouter = Router();

export async function runManualScrapePipeline(term: string, platformStr: string, rawItems: any[]) {
  const dbKeyword = await prisma.keyword.upsert({
    where: { term },
    create: { term },
    update: { deletedAt: null, purgeAt: null },
  });

  const scrapeRun = await prisma.scrapeRun.create({
    data: {
      keywordId: dbKeyword.id,
      status: ProcessingStatus.RECEIVED,
      rawResponse: JSON.stringify(rawItems),
      itemCount: rawItems.length,
    },
  });

  if (rawItems.length === 0) {
    await prisma.scrapeRun.update({
      where: { id: scrapeRun.id },
      data: { status: ProcessingStatus.ANALYZED, completedAt: new Date() },
    });
    return {
      ok: true,
      keyword: term,
      itemsReceived: 0,
      postsCreated: 0,
      commentsCreated: 0,
      postsSkippedExisting: 0,
      commentsSkippedExisting: 0,
      analyzed: 0,
      failed: 0,
      posts: [],
      comments: [],
      message: "Python scraper returned zero results for this query.",
    };
  }

  // 2) Normalize items
  const { posts, standaloneComments, warnings } = normalizeApifyItems(rawItems);

  let postsCreated = 0;
  let commentsCreated = 0;
  let postsSkippedExisting = 0;
  let commentsSkippedExisting = 0;
  const createdPostIds: string[] = [];
  const createdCommentIds: string[] = [];
  // Scraper-side comment id -> stored DB id, so replies can point at their parent.
  // Scrapers emit depth-first, so a parent is always seen before its children.
  const commentIdMap = new Map<string, string>();

  // 3) Store Posts & Comments with strict deduplication
  for (const post of posts) {
    const sourceKey = buildSourceKey({
      keyword: term,
      type: "post",
      id: post.id,
      url: post.url,
      text: post.text,
      author: post.author,
    });

    let postId = "";
    const existing = await prisma.post.findFirst({
      where: {
        OR: [
          { sourceKey },
          { AND: [{ keywordId: dbKeyword.id }, { url: post.url, NOT: { url: null } }] },
          { AND: [{ keywordId: dbKeyword.id }, { text: post.text, NOT: { text: null } }] },
        ],
      },
    });

    if (existing) {
      postId = existing.id;
      postsSkippedExisting++;
    } else {
      const created = await prisma.post.create({
        data: {
          sourceKey,
          keywordId: dbKeyword.id,
          scrapeRunId: scrapeRun.id,
          platform: post.platform || platformStr || "reddit",
          text: post.text ?? null,
          url: post.url ?? null,
          author: post.author ?? null,
          authorUrl: post.authorUrl ?? null,
          publishedAt: post.publishedAt ? new Date(post.publishedAt) : null,
          likes: post.likes ?? null,
          shares: post.shares ?? null,
          commentsCount: post.commentsCount ?? null,
          rawItem: JSON.stringify(post.raw),
          status: ProcessingStatus.RECEIVED,
        },
      });
      postsCreated++;
      postId = created.id;
      createdPostIds.push(created.id);
    }

    for (const c of post.comments) {
      const cSourceKey = buildSourceKey({
        keyword: term,
        type: "comment",
        id: c.id,
        url: c.url,
        text: c.text,
        author: c.author,
      });

      const existingComment = await prisma.comment.findFirst({
        where: {
          OR: [
            { sourceKey: cSourceKey },
            { AND: [{ keywordId: dbKeyword.id }, { text: c.text, NOT: { text: null } }] },
          ],
        },
      });

      if (existingComment) {
        commentsSkippedExisting++;
        if (c.id) commentIdMap.set(c.id, existingComment.id);
      } else {
        const createdComment = await prisma.comment.create({
          data: {
            sourceKey: cSourceKey,
            keywordId: dbKeyword.id,
            scrapeRunId: scrapeRun.id,
            postId,
            parentCommentId: c.parentId ? commentIdMap.get(c.parentId) ?? null : null,
            depth: c.depth ?? 0,
            text: c.text ?? null,
            url: c.url ?? null,
            author: c.author ?? null,
            authorUrl: c.authorUrl ?? null,
            publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
            likes: c.likes ?? null,
            rawItem: JSON.stringify(c.raw),
            status: ProcessingStatus.RECEIVED,
          },
        });
        commentsCreated++;
        createdCommentIds.push(createdComment.id);
        if (c.id) commentIdMap.set(c.id, createdComment.id);
      }
    }
  }

  for (const c of standaloneComments) {
    const cSourceKey = buildSourceKey({
      keyword: term,
      type: "comment",
      id: c.id,
      url: c.url,
      text: c.text,
      author: c.author,
    });

    const existingComment = await prisma.comment.findFirst({
      where: {
        OR: [
          { sourceKey: cSourceKey },
          { AND: [{ keywordId: dbKeyword.id }, { text: c.text, NOT: { text: null } }] },
        ],
      },
    });

    if (existingComment) {
      commentsSkippedExisting++;
    } else {
      const createdComment = await prisma.comment.create({
        data: {
          sourceKey: cSourceKey,
          keywordId: dbKeyword.id,
          scrapeRunId: scrapeRun.id,
          postId: null,
          text: c.text ?? null,
          url: c.url ?? null,
          author: c.author ?? null,
          authorUrl: c.authorUrl ?? null,
          publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
          likes: c.likes ?? null,
          rawItem: JSON.stringify(c.raw),
          status: ProcessingStatus.RECEIVED,
        },
      });
      commentsCreated++;
      createdCommentIds.push(createdComment.id);
    }
  }

  // 4) Analyze Sentiment ONLY on newly created items
  let analyzed = 0;
  let failed = 0;

  for (const id of createdPostIds) {
    const ok = await analyzePost(id);
    ok ? analyzed++ : failed++;
  }
  for (const id of createdCommentIds) {
    const ok = await analyzeComment(id);
    ok ? analyzed++ : failed++;
  }

  await prisma.scrapeRun.update({
    where: { id: scrapeRun.id },
    data: { status: ProcessingStatus.ANALYZED, completedAt: new Date() },
  });

  // 5) Fetch latest items for UI feedback
  const dbPosts = await prisma.post.findMany({
    where: { keywordId: dbKeyword.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const dbComments = await prisma.comment.findMany({
    where: { keywordId: dbKeyword.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    ok: true,
    keyword: term,
    scrapeRunId: scrapeRun.id,
    itemsReceived: rawItems.length,
    postsCreated,
    commentsCreated,
    postsSkippedExisting,
    commentsSkippedExisting,
    analyzed,
    failed,
    warnings,
    posts: dbPosts,
    comments: dbComments,
  };
}

manualScraperRouter.post("/scrape", async (req, res, next) => {
  try {
    const { keyword, url, limit, platform } = req.body ?? {};
    const term = (keyword || "eb1a").trim();

    // 1) Execute Python scraper
    const rawItems = await runPythonSocialScraper({
      keyword: term,
      url: typeof url === "string" ? url : undefined,
      limit: typeof limit === "number" ? limit : 100,
      platform: platform ?? "reddit",
    });

    const pipelineResult = await runManualScrapePipeline(term, platform ?? "reddit", rawItems);
    res.json(pipelineResult);
  } catch (err: any) {
    next(err);
  }
});
