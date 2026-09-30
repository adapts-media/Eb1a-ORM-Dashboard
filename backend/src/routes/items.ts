import { Router } from "express";
import {
  getItems,
  getOverview,
  getNegativeItems,
  getNeutralItems,
  getPositiveItems,
  globalSearch,
  getFailedItems,
  computePurgeAt,
  logDeletion,
  logRestore,
  softDeleteCommentTree,
  restoreCommentTree,
} from "../services/queryService";
import { ItemFilters } from "../services/queryService";
import { prisma } from "../lib/prisma";

export const itemsRouter = Router();

function parseFilters(query: any): ItemFilters {
  const f: ItemFilters = {};
  if (query.keyword) f.keyword = String(query.keyword);
  if (query.sentiment && ["POSITIVE", "NEGATIVE", "NEUTRAL"].includes(String(query.sentiment).toUpperCase())) {
    f.sentiment = String(query.sentiment).toUpperCase() as ItemFilters["sentiment"];
  }
  if (query.type && ["post", "comment", "both"].includes(String(query.type))) {
    f.type = query.type;
  }
  // Any platform label the data actually contains is allowed now that Google SERP
  // mentions (news, web, youtube, ...) live in the same table as the scraper feeds.
  if (query.platform && /^[a-z0-9_-]{1,30}$/i.test(String(query.platform))) {
    f.platform = String(query.platform).toLowerCase();
  }
  if (query.source && ["scraper", "google"].includes(String(query.source).toLowerCase())) {
    f.source = String(query.source).toLowerCase() as ItemFilters["source"];
  }
  if (query.author) f.author = String(query.author);
  if (query.search) f.search = String(query.search);
  if (query.dateFrom) f.dateFrom = new Date(String(query.dateFrom));
  if (query.dateTo) f.dateTo = new Date(String(query.dateTo));
  if (query.page) f.page = Number(query.page);
  if (query.pageSize) f.pageSize = Number(query.pageSize);
  return f;
}

// GET /api/overview?keyword=...&platform=...&dateFrom=...&dateTo=...
itemsRouter.get("/overview", async (req, res) => {
  const keyword = req.query.keyword ? String(req.query.keyword) : undefined;
  const platform = req.query.platform ? String(req.query.platform) : undefined;
  const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : undefined;
  const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : undefined;
  const source = ["scraper", "google"].includes(String(req.query.source || "").toLowerCase())
    ? (String(req.query.source).toLowerCase() as "scraper" | "google")
    : undefined;
  const overview = await getOverview(keyword, platform, dateFrom, dateTo, source);
  res.json(overview);
});

// GET /api/items?keyword=&sentiment=&type=&dateFrom=&dateTo=&author=&search=&page=&pageSize=
itemsRouter.get("/items", async (req, res) => {
  const result = await getItems(parseFilters(req.query));
  res.json(result);
});

// GET /api/items/negative
itemsRouter.get("/items/negative", async (req, res) => {
  const result = await getNegativeItems(parseFilters(req.query));
  res.json(result);
});

// GET /api/items/neutral
itemsRouter.get("/items/neutral", async (req, res) => {
  const result = await getNeutralItems(parseFilters(req.query));
  res.json(result);
});

// GET /api/items/positive
itemsRouter.get("/items/positive", async (req, res) => {
  const result = await getPositiveItems(parseFilters(req.query));
  res.json(result);
});

// GET /api/items/failed — items that failed AI analysis and can be retried.
itemsRouter.get("/items/failed", async (_req, res) => {
  const result = await getFailedItems();
  res.json(result);
});

// GET /api/search?q=...
itemsRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "");
  if (!q.trim()) return res.json({ posts: [], comments: [], keywords: [] });
  const result = await globalSearch(q);
  res.json(result);
});

// DELETE /api/items/post/:id or /api/post/:id — soft-deletes a post (and its
// comments, on the same grace window) with a 24h undo window instead of
// deleting it immediately (see services/queryService.ts).
itemsRouter.delete(["/items/post/:id", "/post/:id"], async (req, res) => {
  try {
    const id = req.params.id;
    const actor = typeof req.body?.actor === "string" ? req.body.actor : undefined;

    const post = await prisma.post.findUnique({ where: { id } });
    if (!post) return res.status(404).json({ error: "Post not found" });

    const now = new Date();
    const purgeAt = computePurgeAt();
    await prisma.comment.updateMany({ where: { postId: id, deletedAt: null }, data: { deletedAt: now, purgeAt } });
    await prisma.post.update({ where: { id }, data: { deletedAt: now, purgeAt } });
    await logDeletion("Post", id, post.title || post.text?.slice(0, 120) || post.url || id, actor);

    res.json({ ok: true, message: "Post moved to trash. It can be restored within 24 hours.", id, purgeAt });
  } catch (err: any) {
    console.error("Error deleting post:", err);
    res.status(500).json({ error: err?.message || "Failed to delete post" });
  }
});

// POST /api/items/post/:id/restore — undoes a post delete within the grace window
itemsRouter.post(["/items/post/:id/restore", "/post/:id/restore"], async (req, res) => {
  try {
    const id = req.params.id;
    const post = await prisma.post.findUnique({ where: { id } });
    if (!post || !post.deletedAt) return res.status(404).json({ error: "Post not found in trash." });

    await prisma.comment.updateMany({ where: { postId: id, purgeAt: post.purgeAt ?? undefined }, data: { deletedAt: null, purgeAt: null } });
    await prisma.post.update({ where: { id }, data: { deletedAt: null, purgeAt: null } });
    await logRestore("Post", id);

    res.json({ ok: true, message: "Post restored.", id });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to restore post" });
  }
});

// DELETE /api/items/comment/:id or /api/comment/:id — soft-deletes a comment
// (and its descendant replies) with a 24h undo window.
itemsRouter.delete(["/items/comment/:id", "/comment/:id"], async (req, res) => {
  try {
    const id = req.params.id;
    const actor = typeof req.body?.actor === "string" ? req.body.actor : undefined;

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const { purgeAt } = await softDeleteCommentTree(id);
    await logDeletion("Comment", id, comment.text?.slice(0, 120) || comment.url || id, actor);

    res.json({ ok: true, message: "Comment moved to trash. It can be restored within 24 hours.", id, purgeAt });
  } catch (err: any) {
    console.error("Error deleting comment:", err);
    res.status(500).json({ error: err?.message || "Failed to delete comment" });
  }
});

// POST /api/items/comment/:id/restore — undoes a comment delete within the grace window
itemsRouter.post(["/items/comment/:id/restore", "/comment/:id/restore"], async (req, res) => {
  try {
    const id = req.params.id;
    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment || !comment.deletedAt) return res.status(404).json({ error: "Comment not found in trash." });

    await restoreCommentTree(id);
    await logRestore("Comment", id);

    res.json({ ok: true, message: "Comment restored.", id });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to restore comment" });
  }
});
