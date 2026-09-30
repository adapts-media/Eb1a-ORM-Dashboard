import express from "express";
import cors from "cors";
import { execSync } from "child_process";
import { env, refreshEnvFromDisk } from "./config/env";
import { keywordsRouter } from "./routes/keywords";
import { itemsRouter } from "./routes/items";
import { chartsRouter } from "./routes/charts";
import { retryRouter } from "./routes/retry";
import { settingsRouter } from "./routes/settings";
import { manualScraperRouter } from "./routes/manualScraper";
import { platformKeywordsRouter } from "./routes/platformKeywords";
import { googleScraperRouter } from "./routes/googleScraper";
import { competitorsRouter, syncCompetitorFlags } from "./routes/competitors";
import { exportRouter } from "./routes/export";
import { startHourlyScraperCron } from "./services/cronScheduler";
import { purgeSeedKeyword, ensureBrandKeywordGroup } from "./services/queryService";

const app = express();

// Auto sync Prisma schema on server startup, purge seed keyword & sync competitor flags
try {
  console.log("Ensuring Prisma database schema is in sync...");
  execSync("npx prisma db push --skip-generate", { stdio: "inherit" });
  refreshEnvFromDisk().catch(() => {});
  purgeSeedKeyword().catch(() => {});
  syncCompetitorFlags().catch(() => {});
  // Feature: "merge duplicate brand trackers" — groups the brand's known
  // spelling variants under one profile on boot.
  ensureBrandKeywordGroup().catch(() => {});
} catch (err: any) {
  console.warn("Notice: Prisma DB sync notice:", err?.message || err);
}

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "ORM Dashboard API Server is Live!" });
});

app.get(["/health", "/api/health"], (_req, res) => {
  res.json({
    ok: true,
    apifyConfigured: Boolean(env.APIFY_API_URL && env.APIFY_API_KEY),
    aiConfigured: Boolean(env.AI_API_URL && env.AI_API_KEY),
  });
});

// Dual mount /api and root routes for 100% path compatibility
app.use(["/api/export", "/export"], exportRouter);
app.use(["/api/settings", "/settings"], settingsRouter);
app.use(["/api/google-scraper", "/google-scraper"], googleScraperRouter);
app.use(["/api/competitor-cards", "/competitor-cards", "/api/competitors", "/competitors"], competitorsRouter);
app.use(["/api/manual-scraper", "/manual-scraper"], manualScraperRouter);
app.use(["/api/platform-keywords", "/platform-keywords"], platformKeywordsRouter);
app.use(["/api/keywords", "/keywords"], keywordsRouter);
app.use(["/api/retry", "/retry"], retryRouter);
app.use(["/api/charts", "/charts"], chartsRouter);
app.use(["/api", "/"], itemsRouter);

// Central error handler — return actual message for clean diagnostics
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("SERVER ERROR:", err);
  const msg = err?.message || (typeof err === "string" ? err : "Unexpected server error.");
  res.status(500).json({ error: msg });
});

app.listen(env.PORT, () => {
  console.log(`ORM Dashboard backend listening on http://localhost:${env.PORT}`);
  if (!env.APIFY_API_URL || !env.APIFY_API_KEY) {
    console.warn("⚠ Apify is not configured yet — set APIFY_API_URL and APIFY_API_KEY in backend/.env");
  }
  if (!env.AI_API_KEY) {
    console.warn("⚠ Mistral AI sentiment engine is not configured yet — set MISTRAL_API_KEY in Settings or backend/.env");
  }

  // Start background hourly cron for all platform keyword cards
  startHourlyScraperCron();
});
