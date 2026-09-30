import { prisma } from "../lib/prisma";
import { ProcessingStatus } from "../types/status";
import { buildSourceKey } from "../lib/hash";
import { fetchApifyResults, ApifyError } from "./apifyService";
import { normalizeApifyItems } from "./dataNormalizer";
import { classifyMention, AiSentimentError } from "./sentimentService";
import { sendNegativeMentionAlert } from "./emailService";
import { NormalizedComment, NormalizedPost, MentionContext, RelevanceMethod } from "../types/normalized";
import { BRAND_GROUP_NAME, BRAND_NAME_VARIANTS } from "../config/brand";

/** Human-readable, code-generated (not AI-generated, to save output tokens) explanation of a relevance verdict. */
function describeRelevanceMethod(method: RelevanceMethod): string {
  switch (method) {
    case "keyword_match":
      return "Text contains the brand/competitor name directly.";
    case "ai_check":
      return "AI judged relevance — name not literally present in the text.";
    default:
      return "Relevance not evaluated.";
  }
}

/**
 * Assembles brief context for a reply: the post it's under (title, falling
 * back to the start of the post's text since Post.title is often left null
 * — the title gets folded into `text` at ingest instead), and, if this is a
 * reply to another comment, that immediate parent's text only (not the
 * whole ancestor chain, to keep token cost bounded).
 */
async function buildReplyContext(comment: { postId: string | null; parentCommentId: string | null }): Promise<MentionContext | undefined> {
  if (!comment.postId && !comment.parentCommentId) return undefined;

  const [post, parent] = await Promise.all([
    comment.postId
      ? prisma.post.findUnique({ where: { id: comment.postId }, select: { title: true, text: true } })
      : Promise.resolve(null),
    comment.parentCommentId
      ? prisma.comment.findUnique({ where: { id: comment.parentCommentId }, select: { text: true } })
      : Promise.resolve(null),
  ]);

  const postTitle = post?.title || post?.text?.slice(0, 150) || undefined;
  const parentText = parent?.text ?? undefined;
  if (!postTitle && !parentText) return undefined;

  return { postTitle, parentText };
}

export interface RunScrapeResult {
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

export async function runScrapeForKeyword(keywordTerm: string): Promise<RunScrapeResult> {
  const term = keywordTerm.trim();
  if (!term) throw new Error("Keyword must not be empty.");

  // update also revives a keyword mid-way through its 24h trash window —
  // otherwise a re-scrape would attach new posts to a row about to be purged.
  const keyword = await prisma.keyword.upsert({
    where: { term },
    create: { term },
    update: { deletedAt: null, purgeAt: null },
  });

  // 1) Apify — the only source of raw data.
  let rawItems: unknown[];
  try {
    rawItems = await fetchApifyResults(term);
  } catch (err) {
    const failedRun = await prisma.scrapeRun.create({
      data: {
        keywordId: keyword.id,
        status: ProcessingStatus.FAILED,
        rawResponse: "null",
        itemCount: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      },
    });
    throw new PipelineError(
      err instanceof ApifyError ? err.message : `Apify request failed: ${String(err)}`,
      failedRun.id
    );
  }

  // 2) Store untouched raw response
  const scrapeRun = await prisma.scrapeRun.create({
    data: {
      keywordId: keyword.id,
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
      keyword: term,
      scrapeRunId: scrapeRun.id,
      itemsReceived: 0,
      postsCreated: 0,
      commentsCreated: 0,
      postsSkippedExisting: 0,
      commentsSkippedExisting: 0,
      analyzed: 0,
      failed: 0,
      warnings: ["Apify returned zero items for this keyword."],
    };
  }

  // 3) Normalize.
  const { posts, standaloneComments, warnings } = normalizeApifyItems(rawItems);

  let postsCreated = 0;
  let postsSkipped = 0;
  let commentsCreated = 0;
  let commentsSkipped = 0;

  const createdPostIds: string[] = [];
  const createdCommentIds: string[] = [];

  for (const post of posts) {
    const sourceKey = buildSourceKey({
      keyword: term,
      type: "post",
      id: post.id,
      url: post.url,
      text: post.text,
      author: post.author,
    });

    const existing = await prisma.post.findUnique({ where: { sourceKey } });
    if (existing) {
      postsSkipped++;
      for (const c of post.comments) {
        const r = await upsertComment(c, term, keyword.id, scrapeRun.id, existing.id);
        if (r.created) { commentsCreated++; createdCommentIds.push(r.id); } else commentsSkipped++;
      }
      continue;
    }

    const created = await prisma.post.create({
      data: {
        sourceKey,
        keywordId: keyword.id,
        scrapeRunId: scrapeRun.id,
        platform: post.platform ?? null,
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
    createdPostIds.push(created.id);

    for (const c of post.comments) {
      const r = await upsertComment(c, term, keyword.id, scrapeRun.id, created.id);
      if (r.created) { commentsCreated++; createdCommentIds.push(r.id); } else commentsSkipped++;
    }
  }

  for (const c of standaloneComments) {
    const r = await upsertComment(c, term, keyword.id, scrapeRun.id, null);
    if (r.created) { commentsCreated++; createdCommentIds.push(r.id); } else commentsSkipped++;
  }

  // 5) AI sentiment analysis — send email on new negative mentions
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

  return {
    keyword: term,
    scrapeRunId: scrapeRun.id,
    itemsReceived: rawItems.length,
    postsCreated,
    commentsCreated,
    postsSkippedExisting: postsSkipped,
    commentsSkippedExisting: commentsSkipped,
    analyzed,
    failed,
    warnings,
  };
}

async function upsertComment(
  c: NormalizedComment,
  keywordTerm: string,
  keywordId: string,
  scrapeRunId: string,
  postId: string | null
): Promise<{ created: boolean; id: string }> {
  const sourceKey = buildSourceKey({
    keyword: keywordTerm,
    type: "comment",
    id: c.id,
    url: c.url,
    text: c.text,
    author: c.author,
  });

  const existing = await prisma.comment.findUnique({ where: { sourceKey } });
  if (existing) return { created: false, id: existing.id };

  const created = await prisma.comment.create({
    data: {
      sourceKey,
      keywordId,
      scrapeRunId,
      postId,
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
  return { created: true, id: created.id };
}

/** Emails an alert for a NEGATIVE post; marks alertSent only once delivery succeeds so failures retry next cycle. */
async function alertNegativePost(id: string): Promise<boolean> {
  const post = await prisma.post.findUnique({ where: { id }, include: { keyword: true } });
  if (!post || post.sentiment !== "NEGATIVE" || post.alertSent || post.isCompetitor) return false;
  if (post.relevant === false) return false; // off-topic negative mentions don't count as brand press

  const platform = post.platform || (post.url?.includes("quora") ? "quora" : post.url?.includes("teamblind") ? "teamblind" : "reddit");
  const sent = await sendNegativeMentionAlert({
    type: "post",
    keyword: post.keyword.term,
    platform,
    text: post.text || "",
    author: post.author || "Anonymous",
    url: post.url || "",
    sentiment: "NEGATIVE",
    confidence: post.confidence,
    publishedAt: post.publishedAt || post.createdAt,
  });
  if (sent) {
    await prisma.post.update({ where: { id }, data: { alertSent: true } });
  }
  return sent;
}

/** Emails an alert for a NEGATIVE comment; marks alertSent only once delivery succeeds so failures retry next cycle. */
async function alertNegativeComment(id: string): Promise<boolean> {
  const comment = await prisma.comment.findUnique({ where: { id }, include: { keyword: true, post: true } });
  if (!comment || comment.sentiment !== "NEGATIVE" || comment.alertSent || comment.isCompetitor) return false;
  if (comment.relevant === false) return false;

  const platform = comment.post?.platform || (comment.url?.includes("quora") ? "quora" : comment.url?.includes("teamblind") ? "teamblind" : "reddit");
  const sent = await sendNegativeMentionAlert({
    type: "comment",
    keyword: comment.keyword.term,
    platform,
    text: comment.text || "",
    author: comment.author || "Anonymous",
    url: comment.url || comment.post?.url || "",
    sentiment: "NEGATIVE",
    confidence: comment.confidence,
    publishedAt: comment.publishedAt || comment.createdAt,
  });
  if (sent) {
    await prisma.comment.update({ where: { id }, data: { alertSent: true } });
  }
  return sent;
}

/**
 * Analyzes a single post by id: relevance check + sentiment in one AI call
 * (see sentimentService.classifyMention). Returns true if it ended ANALYZED.
 * Sends email alert for a negative post that's also relevant.
 * `subjectOverride` lets competitor items check relevance against the
 * competitor's own name instead of the brand (see routes/competitors.ts).
 */
export async function analyzePost(id: string, subjectOverride?: string): Promise<boolean> {
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) return false;

  if (!post.text || !post.text.trim()) {
    await prisma.post.update({
      where: { id },
      data: { status: ProcessingStatus.FAILED, processingError: "No text available to analyze." },
    });
    return false;
  }

  await prisma.post.update({ where: { id }, data: { status: ProcessingStatus.PROCESSING } });
  try {
    const result = await classifyMention({
      text: post.text,
      subject: subjectOverride ?? BRAND_GROUP_NAME,
      subjectVariants: subjectOverride ? undefined : BRAND_NAME_VARIANTS,
    });
    await prisma.post.update({
      where: { id },
      data: {
        status: ProcessingStatus.ANALYZED,
        sentiment: result.sentiment,
        confidence: result.confidence,
        relevant: result.relevant,
        relevanceReason: describeRelevanceMethod(result.relevanceMethod),
        processingError: null,
        analyzedAt: new Date(),
      },
    });
  } catch (err) {
    await prisma.post.update({
      where: { id },
      data: {
        status: ProcessingStatus.FAILED,
        processingError: err instanceof Error ? err.message : String(err),
      },
    });
    return false;
  }

  // An email failure must not flip a successful analysis to FAILED.
  await alertNegativePost(id).catch((err) => console.error(`Alert for post ${id} failed:`, err?.message || err));
  return true;
}

/**
 * Analyzes a single comment by id. Same relevance+sentiment behavior as
 * analyzePost, plus reply-context assembly: if this comment has a post
 * and/or is itself a reply to another comment, that context is included in
 * the classification call instead of judging the reply in total isolation.
 */
export async function analyzeComment(id: string, subjectOverride?: string): Promise<boolean> {
  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) return false;

  if (!comment.text || !comment.text.trim()) {
    await prisma.comment.update({
      where: { id },
      data: { status: ProcessingStatus.FAILED, processingError: "No text available to analyze." },
    });
    return false;
  }

  await prisma.comment.update({ where: { id }, data: { status: ProcessingStatus.PROCESSING } });
  try {
    const context = await buildReplyContext(comment);
    const result = await classifyMention({
      text: comment.text,
      subject: subjectOverride ?? BRAND_GROUP_NAME,
      subjectVariants: subjectOverride ? undefined : BRAND_NAME_VARIANTS,
      context,
    });
    await prisma.comment.update({
      where: { id },
      data: {
        status: ProcessingStatus.ANALYZED,
        sentiment: result.sentiment,
        confidence: result.confidence,
        relevant: result.relevant,
        relevanceReason: describeRelevanceMethod(result.relevanceMethod),
        processingError: null,
        analyzedAt: new Date(),
      },
    });
  } catch (err) {
    await prisma.comment.update({
      where: { id },
      data: {
        status: ProcessingStatus.FAILED,
        processingError: err instanceof Error ? err.message : String(err),
      },
    });
    return false;
  }

  await alertNegativeComment(id).catch((err) => console.error(`Alert for comment ${id} failed:`, err?.message || err));
  return true;
}

// Items stuck in PROCESSING longer than this are assumed orphaned by a crash/restart.
const STALE_PROCESSING_MS = 30 * 60 * 1000;

function backlogWhere() {
  return {
    // Competitor items are analyzed too; they're only excluded from email alerts.
    AND: [{ text: { not: null } }, { text: { not: "" } }],
    OR: [
      { status: ProcessingStatus.RECEIVED },
      { status: ProcessingStatus.FAILED },
      { status: ProcessingStatus.PROCESSING, updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    ],
    // A soft-deleted item sitting in its trash window shouldn't be analyzed.
    deletedAt: null,
  };
}

/** Sends Mistral analysis for brand posts/comments that were never analyzed or previously failed. */
export async function analyzeBacklog(limit = 200): Promise<{ total: number; analyzed: number; failed: number }> {
  const posts = await prisma.post.findMany({ where: backlogWhere(), select: { id: true }, orderBy: { createdAt: "asc" }, take: limit });
  const comments = await prisma.comment.findMany({
    where: backlogWhere(),
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: Math.max(0, limit - posts.length),
  });

  let analyzed = 0;
  let failed = 0;
  for (const p of posts) (await analyzePost(p.id)) ? analyzed++ : failed++;
  for (const c of comments) (await analyzeComment(c.id)) ? analyzed++ : failed++;
  return { total: posts.length + comments.length, analyzed, failed };
}

/** Retries alerts for NEGATIVE items whose email never went out (e.g. SMTP was down or unconfigured). */
export async function sendPendingAlerts(limit = 50): Promise<{ pending: number; sent: number }> {
  const where = { sentiment: "NEGATIVE", alertSent: false, isCompetitor: false, relevant: { not: false }, deletedAt: null };
  const posts = await prisma.post.findMany({ where, select: { id: true }, orderBy: { createdAt: "asc" }, take: limit });
  const comments = await prisma.comment.findMany({
    where,
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: Math.max(0, limit - posts.length),
  });

  // Stop at the first delivery failure: it almost always means SMTP itself is broken, so
  // hammering it with the rest of the queue just burns attempts until the next cycle.
  let sent = 0;
  for (const p of posts) {
    if (!(await alertNegativePost(p.id))) return { pending: posts.length + comments.length, sent };
    sent++;
  }
  for (const c of comments) {
    if (!(await alertNegativeComment(c.id))) return { pending: posts.length + comments.length, sent };
    sent++;
  }
  return { pending: posts.length + comments.length, sent };
}

export class PipelineError extends Error {
  scrapeRunId?: string;
  constructor(message: string, scrapeRunId?: string) {
    super(message);
    this.name = "PipelineError";
    this.scrapeRunId = scrapeRunId;
  }
}
