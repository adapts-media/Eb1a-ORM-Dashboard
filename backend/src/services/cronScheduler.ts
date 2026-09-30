import { prisma } from "../lib/prisma";
import { runPythonSocialScraper } from "./pythonScraperService";
import { runManualScrapePipeline } from "../routes/manualScraper";
import { runPythonCommand, autoIngestGoogleItems } from "../routes/googleScraper";
import { analyzeBacklog, sendPendingAlerts } from "./pipelineService";
import { isAlertEmailConfigured } from "./emailService";

export interface CronLog {
  timestamp: string;
  platform: string;
  keyword: string;
  status: "SUCCESS" | "FAILED";
  newItems: number;
  message: string;
}

let cronTimer: NodeJS.Timeout | null = null;
let isScrapingRunning = false;
let lastCronRunAt: Date | null = null;
let nextCronRunAt: Date | null = null;
const cronLogs: CronLog[] = [];

const HOURLY_MS = 60 * 60 * 1000; // 1 hour

/** Milliseconds until the next top of the hour, so runs land on :00 regardless of when the process started. */
function msUntilNextHour(): number {
  const now = Date.now();
  return HOURLY_MS - (now % HOURLY_MS);
}

function scheduleNextRun() {
  const delay = msUntilNextHour();
  nextCronRunAt = new Date(Date.now() + delay);
  cronTimer = setTimeout(async () => {
    try {
      await executeHourlyScrapeCycle();
    } catch (err: any) {
      console.error("⚠ [Hourly Scraper] Cycle crashed:", err?.message || err);
    } finally {
      if (cronTimer) scheduleNextRun();
    }
  }, delay);
}

export function startHourlyScraperCron() {
  if (cronTimer) return;
  scheduleNextRun();
  console.log(`⏰ Hourly Scraper Cron started — runs at the top of every hour. Next run: ${nextCronRunAt?.toISOString()}`);
}

export function stopHourlyScraperCron() {
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
    nextCronRunAt = null;
    console.log("⏰ Automated Hourly Scraper Cron Job stopped.");
  }
}

export function getCronStatus() {
  return {
    isRunning: isScrapingRunning,
    cronEnabled: cronTimer !== null,
    lastCronRunAt,
    nextCronRunAt,
    logs: cronLogs.slice(-20),
  };
}

export async function executeHourlyScrapeCycle() {
  if (isScrapingRunning) {
    console.log("⏰ Hourly scrape cycle skipped: Previous cycle still in progress.");
    return { ok: false, message: "Scrape cycle already in progress." };
  }

  isScrapingRunning = true;
  lastCronRunAt = new Date();

  console.log(`⏰ Executing Hourly Scrape Cycle at ${lastCronRunAt.toISOString()}...`);

  try {
    // 1) Fetch all active platform keywords from DB
    const activeKeywords = await (prisma as any).platformKeyword.findMany({
      // Deletion safety net: a trashed card must not keep scraping in the
      // background during its 24h undo window.
      where: { enabled: true, deletedAt: null },
    });

    // If no custom platform keywords exist yet, default to seed keywords for all 5 platforms
    const targets = activeKeywords.length > 0 ? activeKeywords : [
      { id: "default_r", platform: "reddit", keyword: "eb1aexperts.com", searchUrl: "https://www.reddit.com/search/?type=comments&q=eb1aexperts.com&sort=relevance&safe=0" },
      { id: "default_q", platform: "quora", keyword: "eb1aexperts.com", searchUrl: "https://www.quora.com/search?q=eb1aexperts.com" },
      { id: "default_b", platform: "teamblind", keyword: "eb1aexperts.com", searchUrl: "https://www.teamblind.com/search/eb1aexperts.com" },
      { id: "default_t", platform: "trustpilot", keyword: "eb1aexperts.com", searchUrl: "https://www.trustpilot.com/review/eb1aexperts.com" },
      { id: "default_l", platform: "linkedin", keyword: "eb1aexperts.com", searchUrl: "https://www.linkedin.com/search/results/content/?keywords=eb1aexperts.com" },
    ];

    let totalNewItems = 0;

    for (const target of targets) {
      try {
        console.log(`⏰ [Hourly Scraper] Scraping platform "${target.platform.toUpperCase()}" for keyword "${target.keyword}"...`);
        
        const rawItems = await runPythonSocialScraper({
          keyword: target.keyword,
          url: target.searchUrl || undefined,
          limit: 100,
          platform: target.platform as any,
        });

        const result = await runManualScrapePipeline(
          target.keyword,
          target.platform as any,
          rawItems
        );

        const newCount = (result.postsCreated || 0) + (result.commentsCreated || 0);
        totalNewItems += newCount;

        // Update lastRunAt timestamp
        if (target.id && !target.id.startsWith("default_")) {
          await (prisma as any).platformKeyword.update({
            where: { id: target.id },
            data: { lastRunAt: new Date() },
          });
        }

        const logMsg: CronLog = {
          timestamp: new Date().toISOString(),
          platform: target.platform,
          keyword: target.keyword,
          status: "SUCCESS",
          newItems: newCount,
          message: `Added ${newCount} new items (${result.postsSkippedExisting + result.commentsSkippedExisting} duplicates skipped).`,
        };
        cronLogs.push(logMsg);
        console.log(`✓ [Hourly Scraper] ${target.platform.toUpperCase()}: ${logMsg.message}`);

      } catch (err: any) {
        const errorLog: CronLog = {
          timestamp: new Date().toISOString(),
          platform: target.platform,
          keyword: target.keyword,
          status: "FAILED",
          newItems: 0,
          message: err.message || "Failed to scrape platform.",
        };
        cronLogs.push(errorLog);
        console.error(`⚠ [Hourly Scraper] Error scraping ${target.platform}: ${err.message}`);
      }
    }

    // 2) Google SERP Scraper (Serper API) - 1-hour automated cron
    try {
      console.log(`⏰ [Hourly Scraper] Scraping Google SERP (Serper API)...`);
      const googleKeyword = "EB1A Experts";
      const rawGoogleItems = await runPythonCommand(["--action", "scan", "--keyword", googleKeyword, "--json"]);
      if (Array.isArray(rawGoogleItems) && rawGoogleItems.length > 0) {
        const ingestRes = await autoIngestGoogleItems(rawGoogleItems, googleKeyword);
        totalNewItems += ingestRes.postsCreated;
        const gLogMsg: CronLog = {
          timestamp: new Date().toISOString(),
          platform: "google",
          keyword: googleKeyword,
          status: "SUCCESS",
          newItems: ingestRes.postsCreated,
          message: `Added ${ingestRes.postsCreated} new items (${ingestRes.postsSkipped} duplicates skipped, ${ingestRes.analyzed} AI sentiment analyzed).`,
        };
        cronLogs.push(gLogMsg);
        console.log(`✓ [Hourly Scraper] GOOGLE: ${gLogMsg.message}`);
      }
    } catch (gErr: any) {
      const gErrLog: CronLog = {
        timestamp: new Date().toISOString(),
        platform: "google",
        keyword: "EB1A Experts",
        status: "FAILED",
        newItems: 0,
        message: gErr.message || "Failed to scrape Google SERP.",
      };
      cronLogs.push(gErrLog);
      console.error(`⚠ [Hourly Scraper] Error scraping Google SERP: ${gErr.message}`);
    }

    // 3) Analyze anything Mistral hasn't classified yet (earlier failures, rate limits, crashed runs).
    let backlogAnalyzed = 0;
    try {
      const backlog = await analyzeBacklog(200);
      backlogAnalyzed = backlog.analyzed;
      if (backlog.total > 0) {
        pushLog("mistral", "backlog", backlog.failed > 0 && backlog.analyzed === 0 ? "FAILED" : "SUCCESS", backlog.analyzed,
          `Analyzed ${backlog.analyzed}/${backlog.total} pending items (${backlog.failed} failed, will retry next hour).`);
      }
    } catch (err: any) {
      pushLog("mistral", "backlog", "FAILED", 0, err?.message || "Backlog analysis failed.");
    }

    // 4) Re-send alerts for negative items whose email never went out.
    let alertsSent = 0;
    try {
      if (await isAlertEmailConfigured()) {
        const alerts = await sendPendingAlerts(50);
        alertsSent = alerts.sent;
        if (alerts.pending > 0) {
          pushLog("email", "alerts", alerts.sent < alerts.pending ? "FAILED" : "SUCCESS", alerts.sent,
            `Sent ${alerts.sent}/${alerts.pending} pending negative-mention alerts.`);
        }
      } else {
        const msg = "SMTP or ALERT_EMAIL not configured — negative alerts are queued until it is set in Settings.";
        console.warn(`⚠ [Hourly Scraper] ${msg}`);
        pushLog("email", "alerts", "FAILED", 0, msg);
      }
    } catch (err: any) {
      pushLog("email", "alerts", "FAILED", 0, err?.message || "Pending alert delivery failed.");
    }

    const message = `Hourly scrape cycle completed. ${totalNewItems} new mentions, ${backlogAnalyzed} backlog items analyzed, ${alertsSent} queued alerts sent.`;
    console.log(`✓ [Hourly Scraper] ${message}`);
    return { ok: true, message, newItems: totalNewItems };
  } finally {
    isScrapingRunning = false;
  }
}

function pushLog(platform: string, keyword: string, status: CronLog["status"], newItems: number, message: string) {
  cronLogs.push({ timestamp: new Date().toISOString(), platform, keyword, status, newItems, message });
  // Logs live in memory for the status endpoint; cap so a long-running process doesn't grow unbounded.
  if (cronLogs.length > 200) cronLogs.splice(0, cronLogs.length - 200);
}
