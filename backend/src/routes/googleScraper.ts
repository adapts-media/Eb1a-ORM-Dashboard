import { Router, Request, Response, NextFunction } from "express";
import { spawn } from "child_process";
import path from "path";
import { prisma } from "../lib/prisma";
import { buildSourceKey } from "../lib/hash";
import { ProcessingStatus } from "../types/status";
import { analyzePost } from "../services/pipelineService";
import { generateGoogleExcelReport, GoogleExportItem, GoogleExcelExportOptions } from "../services/excelService";

export const googleScraperRouter = Router();

const scriptPath = path.resolve(__dirname, "../../scripts/google_scraper.py");
const pythonCmd = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");

// Active scan state and subscriber SSE connections
let scanRunning = false;
let lastScanLog: string[] = [];
let lastScanFinished: string | null = null;
let lastScanError: string | null = null;
let lastScanAdded = 0;

const sseClients: Response[] = [];

function safeParseDate(val: any, snippetFallback?: string): Date | null {
  let str = (typeof val === "string" ? val : "").trim();

  // If no direct date provided, check for date prefix in snippet (e.g. "Sep 5, 2024 — ...", "3 days ago — ...")
  if (!str && snippetFallback) {
    const prefixMatch = snippetFallback.match(/^([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*[—\-–\.]/);
    if (prefixMatch) {
      str = prefixMatch[1].trim();
    } else {
      const relPrefixMatch = snippetFallback.match(/^(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)\s*[—\-–\.]/i);
      if (relPrefixMatch) {
        str = relPrefixMatch[1].trim();
      }
    }
  }

  if (!str) return null;

  // Handle relative dates like "1 year ago", "3 days ago", "2 months ago"
  const relMatch = str.toLowerCase().match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (relMatch) {
    const num = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = new Date();
    if (unit === "second") now.setSeconds(now.getSeconds() - num);
    else if (unit === "minute") now.setMinutes(now.getMinutes() - num);
    else if (unit === "hour") now.setHours(now.getHours() - num);
    else if (unit === "day") now.setDate(now.getDate() - num);
    else if (unit === "week") now.setDate(now.getDate() - num * 7);
    else if (unit === "month") now.setMonth(now.getMonth() - num);
    else if (unit === "year") now.setFullYear(now.getFullYear() - num);
    return now;
  }

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
}

function broadcastSSE(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => {
    try {
      res.write(payload);
    } catch {
      // client disconnected
    }
  });
}

export function runPythonCommand(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonCmd, [scriptPath, ...args], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdoutData = "";
    let stderrData = "";

    proc.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString("utf-8");
    });

    proc.stderr.on("data", (chunk) => {
      stderrData += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start python process: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Python script exited with code ${code}. Stderr: ${stderrData.slice(0, 500)}`));
      }
      try {
        const trimmed = stdoutData.trim();
        if (!trimmed) return resolve({});
        const parsed = JSON.parse(trimmed);
        resolve(parsed);
      } catch (err: any) {
        reject(new Error(`Failed to parse Python JSON output: ${err.message}. Raw output: ${stdoutData.slice(0, 300)}`));
      }
    });
  });
}

export const GOOGLE_SOURCE = "google";

/** A stored Google-sourced Post rendered in the GoogleMention shape the page already expects. */
function toGoogleMention(post: any) {
  let raw: any = {};
  try {
    raw = post.rawItem ? JSON.parse(post.rawItem) : {};
  } catch {
    raw = {};
  }
  const text: string = post.text || "";
  const splitIdx = text.indexOf("\n\n");
  return {
    id: post.id,
    url: post.url || raw.url || "",
    title: raw.title || (splitIdx > 0 ? text.slice(0, splitIdx) : text).slice(0, 300),
    snippet: raw.snippet ?? (splitIdx > 0 ? text.slice(splitIdx + 2) : ""),
    domain: post.author || raw.domain || "",
    platform: raw.platform || post.platform || "Web",
    norm_url: raw.norm_url,
    title_key: raw.title_key,
    source_id: raw.source_id,
    engine: raw.engine,
    query: raw.query,
    published: post.publishedAt ? post.publishedAt.toISOString() : raw.published || "",
    first_seen: post.createdAt ? post.createdAt.toISOString() : raw.first_seen || "",
    // Available now that Google mentions live alongside everything else.
    sentiment: post.sentiment,
    confidence: post.confidence,
    keyword: post.keyword?.term,
  };
}

/** Reads Google-sourced mentions out of Postgres, applying the page's platform/query filters. */
export async function fetchGoogleMentions(platform = "All", query = "", limit = 2000) {
  const baseWhere = { source: GOOGLE_SOURCE, isCompetitor: false, deletedAt: null };
  const where: any = { ...baseWhere };
  if (platform && platform.toLowerCase() !== "all") {
    where.platform = { equals: platform, mode: "insensitive" };
  }
  if (query && query.trim()) {
    const q = query.trim();
    where.OR = [
      { text: { contains: q, mode: "insensitive" } },
      { url: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
    ];
  }

  const [rows, totalAll, byPlatform] = await Promise.all([
    prisma.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 5000),
      include: { keyword: { select: { term: true } } },
    }),
    prisma.post.count({ where: baseWhere }),
    prisma.post.groupBy({
      by: ["platform"],
      where: baseWhere,
      _count: true,
    }),
  ]);

  const counts: Record<string, number> = {};
  for (const row of byPlatform) {
    const label = row.platform ? row.platform.charAt(0).toUpperCase() + row.platform.slice(1) : "Web";
    counts[label] = (counts[label] || 0) + row._count;
  }

  const mentions = rows.map(toGoogleMention);
  return { brand: "EB1A Experts", total: totalAll, shown: mentions.length, counts, mentions };
}

// 1) Mentions endpoint
googleScraperRouter.get("/mentions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = (req.query.platform as string) || "All";
    const query = (req.query.q as string) || (req.query.query as string) || "";
    const limit = Number(req.query.limit) || 2000;

    res.json(await fetchGoogleMentions(platform, query, limit));
  } catch (err) {
    next(err);
  }
});

// 2) Stats endpoint
googleScraperRouter.get("/stats", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { total, counts } = await fetchGoogleMentions("All", "", 1);
    res.json({ total, counts });
  } catch (err) {
    next(err);
  }
});

// 3) Real-time SSE Stream
googleScraperRouter.get("/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.push(res);

  // Send initial state
  const helloPayload = {
    running: scanRunning,
    log: lastScanLog,
    finished: lastScanFinished,
    error: lastScanError,
    added: lastScanAdded,
  };
  res.write(`event: hello\ndata: ${JSON.stringify(helloPayload)}\n\n`);

  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// 4) Trigger Scan
googleScraperRouter.post("/scan", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (scanRunning) {
      return res.status(409).json({ error: "A scan is already running." });
    }

    const { keyword, engine } = req.body ?? {};
    scanRunning = true;
    lastScanLog = [];
    lastScanFinished = null;
    lastScanError = null;
    lastScanAdded = 0;

    broadcastSSE("start", { running: true, log: [] });

    res.json({ ok: true, message: "Scan started." });

    // Execute python scan asynchronously
    const args = ["--action", "scan", "--json"];
    if (keyword && typeof keyword === "string" && keyword.trim()) {
      args.push("--keyword", keyword.trim());
    }
    if (engine && typeof engine === "string" && engine.trim()) {
      args.push("--engine", engine.trim());
    }

    const proc = spawn(pythonCmd, [scriptPath, ...args], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdoutData = "";

    proc.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString("utf-8");
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      lines.forEach((line: string) => {
        lastScanLog.push(line);
        if (lastScanLog.length > 50) lastScanLog.shift();
        broadcastSSE("log", { line });
      });
    });

    proc.on("close", async (code) => {
      scanRunning = false;
      lastScanFinished = new Date().toISOString();

      if (code !== 0) {
        lastScanError = `Scan process exited with code ${code}`;
        broadcastSSE("done", { running: false, error: lastScanError, added: 0, finished: lastScanFinished });
        return;
      }

      try {
        const items = JSON.parse(stdoutData.trim() || "[]");
        lastScanAdded = Array.isArray(items) ? items.length : 0;
        
        // Broadcast new items
        if (Array.isArray(items)) {
          items.forEach((item) => broadcastSSE("mention", item));
        }

        // Automatic Ingestion & AI Sentiment Analysis for every Google Scrape!
        if (Array.isArray(items) && items.length > 0) {
          const targetKeyword = (typeof keyword === "string" && keyword.trim()) ? keyword.trim() : "eb1a";
          broadcastSSE("log", { line: `[SYS] Automatically ingesting ${items.length} Google mention(s) and executing AI sentiment analysis...` });
          const ingestRes = await autoIngestGoogleItems(items, targetKeyword);
          broadcastSSE("log", { line: `[SYS] ✓ Ingested ${ingestRes.postsCreated} new mention(s) into ORM Dashboard database (${ingestRes.analyzed} analyzed with AI sentiment)!` });
        }

        // Broadcast stats
        const stats = await runPythonCommand(["--action", "stats"]).catch(() => ({}));
        broadcastSSE("stats", stats);
      } catch (e: any) {
        console.warn("Notice parsing scan output:", e.message);
      }

      broadcastSSE("done", {
        running: false,
        error: null,
        added: lastScanAdded,
        finished: lastScanFinished,
        log: lastScanLog,
      });
    });
  } catch (err) {
    scanRunning = false;
    next(err);
  }
});

// Helper for automatic ingestion & AI sentiment analysis of Google Mentions
export async function autoIngestGoogleItems(items: any[], keyword?: string) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, postsCreated: 0, postsSkipped: 0, analyzed: 0, failed: 0 };
  }

  const term = (keyword || "eb1a").trim();
  const dbKeyword = await prisma.keyword.upsert({
    where: { term },
    create: { term },
    update: { deletedAt: null, purgeAt: null },
  });

  const scrapeRun = await prisma.scrapeRun.create({
    data: {
      keywordId: dbKeyword.id,
      status: ProcessingStatus.RECEIVED,
      rawResponse: JSON.stringify(items),
      itemCount: items.length,
    },
  });

  let postsCreated = 0;
  let postsSkipped = 0;
  const createdPostIds: string[] = [];

  for (const item of items) {
    const sourceKey = buildSourceKey({
      keyword: term,
      type: "post",
      id: item.id || item.norm_url || item.url,
      url: item.url,
      text: item.snippet || item.title,
      author: item.domain || "google",
    });

    const existing = await prisma.post.findFirst({
      where: {
        OR: [
          { sourceKey },
          { AND: [{ keywordId: dbKeyword.id }, { url: item.url, NOT: { url: null } }] },
        ],
      },
    });

    if (existing) {
      postsSkipped++;
    } else {
      const platform = (item.platform || "Web").toLowerCase();
      const created = await prisma.post.create({
        data: {
          sourceKey,
          keywordId: dbKeyword.id,
          scrapeRunId: scrapeRun.id,
          platform,
          text: `${item.title || ''}\n\n${item.snippet || ''}`.trim(),
          url: item.url || null,
          author: item.domain || null,
          publishedAt: safeParseDate(item.published, item.snippet),
          rawItem: JSON.stringify(item),
          status: ProcessingStatus.RECEIVED,
          source: GOOGLE_SOURCE,
        },
      });
      postsCreated++;
      createdPostIds.push(created.id);
    }
  }

  // Run AI sentiment analysis on newly created posts
  let analyzed = 0;
  let failed = 0;
  for (const id of createdPostIds) {
    const ok = await analyzePost(id);
    ok ? analyzed++ : failed++;
  }

  await prisma.scrapeRun.update({
    where: { id: scrapeRun.id },
    data: { status: ProcessingStatus.ANALYZED, completedAt: new Date() },
  });

  return {
    ok: true,
    keyword: term,
    itemsReceived: items.length,
    postsCreated,
    postsSkipped,
    analyzed,
    failed,
    message: `Ingested ${postsCreated} new mention(s) into ORM Dashboard and ran AI sentiment analysis.`,
  };
}

// 5) Ingest Google Mentions into ORM Dashboard database (Prisma)
googleScraperRouter.post("/ingest", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { items, keyword } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No mention items provided for ingestion." });
    }

    const result = await autoIngestGoogleItems(items, keyword);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 6) Export Google Mentions to Multi-Tab Excel
googleScraperRouter.post("/export-excel", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { items, filters } = req.body ?? {};
    let exportItems: GoogleExportItem[] = Array.isArray(items) ? items : [];

    // If no items passed, fetch from Python scraper backend with platform / query filters
    if (exportItems.length === 0) {
      const platform = (filters?.platform as string) || "All";
      const query = (filters?.query as string) || (filters?.q as string) || "";
      const limit = Number(filters?.limit) || 5000;

      const result = await fetchGoogleMentions(platform, query, limit);
      exportItems = result.mentions as GoogleExportItem[];
    }

    const exportOptions: GoogleExcelExportOptions = {
      platform: filters?.platform || "All",
      dateRangeLabel: filters?.dateRangeLabel,
      dateFrom: filters?.dateFrom,
      dateTo: filters?.dateTo,
      query: filters?.query,
    };

    const buffer = await generateGoogleExcelReport(exportItems, exportOptions);

    const safePlat = (filters?.platform || "All").replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `Google_Mentions_${safePlat}_${timestamp}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

googleScraperRouter.get("/export-excel", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = (req.query.platform as string) || "All";
    const query = (req.query.q as string) || (req.query.query as string) || "";
    const dateRangeLabel = req.query.dateRangeLabel ? String(req.query.dateRangeLabel) : undefined;
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
    const limit = Number(req.query.limit) || 5000;

    const exportItems = (await fetchGoogleMentions(platform, query, limit)).mentions as GoogleExportItem[];

    const buffer = await generateGoogleExcelReport(exportItems, {
      platform,
      dateRangeLabel,
      dateFrom,
      dateTo,
      query,
    });

    const safePlat = platform.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `Google_Mentions_${safePlat}_${timestamp}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

