import { Router } from "express";
import { runScrapeForKeyword, PipelineError } from "../services/pipelineService";
import { getKeywords, computePurgeAt, logDeletion, logRestore } from "../services/queryService";
import { ApifyError } from "../services/apifyService";
import { ConfigError } from "../config/env";
import { prisma } from "../lib/prisma";

export const keywordsRouter = Router();

// GET /api/keywords — list all keywords searched so far, with counts.
keywordsRouter.get("/", async (_req, res) => {
  const keywords = await getKeywords();
  res.json({ keywords });
});

// POST /api/keywords/scrape { keyword: string }
// Triggers the full pipeline: Apify -> normalize -> store -> AI sentiment -> store.
keywordsRouter.post("/scrape", async (req, res) => {
  const keyword = String(req.body?.keyword ?? "").trim();
  if (!keyword) {
    return res.status(400).json({ error: "Request body must include a non-empty 'keyword' string." });
  }

  try {
    const result = await runScrapeForKeyword(keyword);
    res.json(result);
  } catch (err) {
    if (err instanceof ConfigError) {
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof PipelineError) {
      return res.status(502).json({ error: err.message, scrapeRunId: err.scrapeRunId });
    }
    if (err instanceof ApifyError) {
      return res.status(err.status ?? 502).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Unexpected server error while running the scrape pipeline." });
  }
});

// DELETE /api/keywords/:id — soft-deletes a keyword AND all of its posts/
// comments on the same grace window, instead of deleting anything
// immediately. Restoring the keyword (below) brings its items back too.
keywordsRouter.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { actor } = req.body ?? {};

    const keyword = await prisma.keyword.findUnique({ where: { id } });
    if (!keyword) return res.status(404).json({ error: "Keyword not found." });

    const now = new Date();
    const purgeAt = computePurgeAt();
    await prisma.comment.updateMany({ where: { keywordId: id, deletedAt: null }, data: { deletedAt: now, purgeAt } });
    await prisma.post.updateMany({ where: { keywordId: id, deletedAt: null }, data: { deletedAt: now, purgeAt } });
    await prisma.keyword.update({ where: { id }, data: { deletedAt: now, purgeAt } });
    await logDeletion("Keyword", id, keyword.term, typeof actor === "string" ? actor : undefined);

    res.json({ ok: true, message: "Keyword moved to trash. It can be restored within 24 hours.", purgeAt });
  } catch (err) {
    next(err);
  }
});

// POST /api/keywords/:id/restore — undoes a delete within the grace window
keywordsRouter.post("/:id/restore", async (req, res, next) => {
  try {
    const { id } = req.params;
    const keyword = await prisma.keyword.findUnique({ where: { id } });
    if (!keyword || !keyword.deletedAt) {
      return res.status(404).json({ error: "Keyword not found in trash (it may have already been purged or was never deleted)." });
    }

    await prisma.post.updateMany({ where: { keywordId: id, purgeAt: keyword.purgeAt ?? undefined }, data: { deletedAt: null, purgeAt: null } });
    await prisma.comment.updateMany({ where: { keywordId: id, purgeAt: keyword.purgeAt ?? undefined }, data: { deletedAt: null, purgeAt: null } });
    await prisma.keyword.update({ where: { id }, data: { deletedAt: null, purgeAt: null } });
    await logRestore("Keyword", id);

    res.json({ ok: true, message: "Keyword restored." });
  } catch (err) {
    next(err);
  }
});
