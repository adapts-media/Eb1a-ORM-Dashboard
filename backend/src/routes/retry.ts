import { Router } from "express";
import { analyzePost, analyzeComment } from "../services/pipelineService";
import { prisma } from "../lib/prisma";
import { ConfigError } from "../config/env";
import { computePurgeAt, logDeletion, logRestore, softDeleteCommentTree, restoreCommentTree } from "../services/queryService";

export const retryRouter = Router();

// POST /api/retry/all — re-run AI sentiment analysis for ALL failed posts & comments.
retryRouter.post("/all", async (_req, res) => {
  try {
    const failedPosts = await prisma.post.findMany({ where: { status: "FAILED", deletedAt: null }, select: { id: true } });
    const failedComments = await prisma.comment.findMany({ where: { status: "FAILED", deletedAt: null }, select: { id: true } });

    let analyzed = 0;
    let failed = 0;

    for (const p of failedPosts) {
      const ok = await analyzePost(p.id);
      ok ? analyzed++ : failed++;
    }

    for (const c of failedComments) {
      const ok = await analyzeComment(c.id);
      ok ? analyzed++ : failed++;
    }

    res.json({
      ok: true,
      total: failedPosts.length + failedComments.length,
      analyzed,
      failed,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/retry/post/:id — re-run AI sentiment analysis for one failed post.
retryRouter.post("/post/:id", async (req, res) => {
  try {
    const ok = await analyzePost(req.params.id);
    res.json({ id: req.params.id, analyzed: ok });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/retry/comment/:id
retryRouter.post("/comment/:id", async (req, res) => {
  try {
    const ok = await analyzeComment(req.params.id);
    res.json({ id: req.params.id, analyzed: ok });
  } catch (err) {
    handleError(err, res);
  }
});

// DELETE /api/retry/all (and /clear-all) — soft-deletes all failed posts &
// comments with a 24h undo window instead of an immediate, permanent bulk
// delete. Recorded as ONE DeletionLog entry (not one per row) so clearing a
// large backlog doesn't flood the audit trail.
retryRouter.delete(["/all", "/clear-all"], async (req, res) => {
  try {
    const actor = typeof req.body?.actor === "string" ? req.body.actor : undefined;
    const now = new Date();
    const purgeAt = computePurgeAt();

    const updatedComments = await prisma.comment.updateMany({
      where: {
        deletedAt: null,
        OR: [
          { status: "FAILED" },
          { post: { status: "FAILED" } },
        ],
      },
      data: { deletedAt: now, purgeAt },
    });

    const updatedPosts = await prisma.post.updateMany({
      where: { status: "FAILED", deletedAt: null },
      data: { deletedAt: now, purgeAt },
    });

    if (updatedPosts.count + updatedComments.count > 0) {
      await logDeletion(
        "Post",
        "bulk-clear-failed",
        `Bulk-cleared ${updatedPosts.count} failed post(s) and ${updatedComments.count} failed comment(s).`,
        actor
      );
    }

    res.json({
      ok: true,
      deletedPosts: updatedPosts.count,
      deletedComments: updatedComments.count,
      totalDeleted: updatedPosts.count + updatedComments.count,
      purgeAt,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// DELETE /api/retry/post/:id — soft-deletes a failed post (and its comments) with a 24h undo window.
retryRouter.delete("/post/:id", async (req, res) => {
  try {
    const actor = typeof req.body?.actor === "string" ? req.body.actor : undefined;
    const post = await prisma.post.findUnique({ where: { id: req.params.id } });
    if (!post) return res.status(404).json({ error: "Post not found" });

    const now = new Date();
    const purgeAt = computePurgeAt();
    await prisma.comment.updateMany({ where: { postId: req.params.id, deletedAt: null }, data: { deletedAt: now, purgeAt } });
    await prisma.post.update({ where: { id: req.params.id }, data: { deletedAt: now, purgeAt } });
    await logDeletion("Post", req.params.id, post.title || post.text?.slice(0, 120) || post.url || req.params.id, actor);

    res.json({ ok: true, id: req.params.id, purgeAt });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/retry/post/:id/restore
retryRouter.post("/post/:id/restore", async (req, res) => {
  try {
    const post = await prisma.post.findUnique({ where: { id: req.params.id } });
    if (!post || !post.deletedAt) return res.status(404).json({ error: "Post not found in trash." });

    await prisma.comment.updateMany({ where: { postId: req.params.id, purgeAt: post.purgeAt ?? undefined }, data: { deletedAt: null, purgeAt: null } });
    await prisma.post.update({ where: { id: req.params.id }, data: { deletedAt: null, purgeAt: null } });
    await logRestore("Post", req.params.id);

    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    handleError(err, res);
  }
});

// DELETE /api/retry/comment/:id — soft-deletes a failed comment (and its descendant replies) with a 24h undo window.
retryRouter.delete("/comment/:id", async (req, res) => {
  try {
    const actor = typeof req.body?.actor === "string" ? req.body.actor : undefined;
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const { purgeAt } = await softDeleteCommentTree(req.params.id);
    await logDeletion("Comment", req.params.id, comment.text?.slice(0, 120) || comment.url || req.params.id, actor);

    res.json({ ok: true, id: req.params.id, purgeAt });
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/retry/comment/:id/restore
retryRouter.post("/comment/:id/restore", async (req, res) => {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment || !comment.deletedAt) return res.status(404).json({ error: "Comment not found in trash." });

    await restoreCommentTree(req.params.id);
    await logRestore("Comment", req.params.id);

    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    handleError(err, res);
  }
});

function handleError(err: unknown, res: any) {
  if (err instanceof ConfigError) return res.status(503).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Unexpected server error while retrying analysis." });
}
