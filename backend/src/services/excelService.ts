import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { syncCompetitorFlags } from "./queryService";

export interface ExcelExportOptions {
  scope?: "brand" | "competitor" | "all";
  keyword?: string;
  platform?: string;
  sentiment?: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  author?: string;
}

interface ExportItem {
  id: string;
  type: "Post" | "Comment";
  platform: string;
  rawPlatform: string;
  keyword: string;
  title: string;
  text: string;
  author: string;
  authorUrl: string | null;
  publishedAt: Date | null;
  publishedAtStr: string;
  sentiment: string;
  confidence: number | null;
  confidenceStr: string;
  likes: number | null;
  shares: number | null;
  commentsCount: number | null;
  url: string | null;
  isCompetitor: boolean;
}

/**
 * Maps raw platform string or URL domain to clean Platform sheet name
 */
export function normalizePlatformName(platformRaw?: string | null, urlRaw?: string | null): string {
  const p = (platformRaw || "").toLowerCase();
  if (p.includes("reddit")) return "Reddit";
  if (p.includes("quora")) return "Quora";
  if (p.includes("teamblind") || p.includes("blind")) return "TeamBlind";
  if (p.includes("trustpilot")) return "Trustpilot";
  if (p.includes("linkedin")) return "LinkedIn";
  if (p.includes("google") || p.includes("web")) return "Web & Google";

  // Infer from URL
  const u = (urlRaw || "").toLowerCase();
  if (u.includes("reddit.com")) return "Reddit";
  if (u.includes("quora.com")) return "Quora";
  if (u.includes("teamblind.com")) return "TeamBlind";
  if (u.includes("trustpilot.com")) return "Trustpilot";
  if (u.includes("linkedin.com")) return "LinkedIn";

  return "Web & Others";
}

export async function generateExcelReport(options: ExcelExportOptions = {}): Promise<Buffer> {
  await syncCompetitorFlags().catch(() => {});

  const scope = options.scope ?? "all";
  // Exports should never include trashed items (deletion safety net).
  const pWhere: Prisma.PostWhereInput = { deletedAt: null };
  const cWhere: Prisma.CommentWhereInput = { deletedAt: null };

  if (scope === "brand") {
    pWhere.isCompetitor = false;
    cWhere.isCompetitor = false;
  } else if (scope === "competitor") {
    pWhere.isCompetitor = true;
    cWhere.isCompetitor = true;
  }

  if (options.keyword) {
    pWhere.keyword = { term: { equals: options.keyword } };
    cWhere.keyword = { term: { equals: options.keyword } };
  }

  if (options.sentiment) {
    pWhere.sentiment = options.sentiment;
    cWhere.sentiment = options.sentiment;
  }

  if (options.platform && options.platform !== "all") {
    pWhere.OR = [
      { platform: { contains: options.platform } },
      { url: { contains: options.platform } },
    ];
    cWhere.OR = [
      { post: { platform: { contains: options.platform } } },
      { url: { contains: options.platform } },
      { sourceKey: { contains: options.platform } },
    ];
  }

  if (options.dateFrom || options.dateTo) {
    pWhere.publishedAt = {};
    cWhere.publishedAt = {};
    if (options.dateFrom) {
      pWhere.publishedAt.gte = options.dateFrom;
      cWhere.publishedAt.gte = options.dateFrom;
    }
    if (options.dateTo) {
      pWhere.publishedAt.lte = options.dateTo;
      cWhere.publishedAt.lte = options.dateTo;
    }
  }

  const searchParam = options.search || options.author;
  if (searchParam) {
    const existingPOR = pWhere.OR || [];
    pWhere.OR = [
      ...existingPOR,
      { text: { contains: searchParam } },
      { title: { contains: searchParam } },
      { author: { contains: searchParam } },
    ];
    const existingCOR = cWhere.OR || [];
    cWhere.OR = [
      ...existingCOR,
      { text: { contains: searchParam } },
      { author: { contains: searchParam } },
    ];
  }

  const [posts, comments] = await Promise.all([
    prisma.post.findMany({
      where: pWhere,
      include: { keyword: true },
      orderBy: { publishedAt: "desc" },
    }),
    prisma.comment.findMany({
      where: cWhere,
      include: { keyword: true, post: { select: { platform: true, url: true, title: true, text: true } } },
      orderBy: { publishedAt: "desc" },
    }),
  ]);

  const items: ExportItem[] = [
    ...posts.map((p) => {
      const plat = normalizePlatformName(p.platform, p.url);
      const conf = p.confidence !== null ? Math.round(p.confidence * 100) : null;
      return {
        id: p.id,
        type: "Post" as const,
        platform: plat,
        rawPlatform: p.platform || plat,
        keyword: p.keyword.term,
        title: p.title || p.text?.slice(0, 80) || "Post",
        text: p.text || "",
        author: p.author || "Anonymous",
        authorUrl: p.authorUrl,
        publishedAt: p.publishedAt,
        publishedAtStr: p.publishedAt ? new Date(p.publishedAt).toLocaleString() : "N/A",
        sentiment: p.sentiment || "UNANALYZED",
        confidence: p.confidence,
        confidenceStr: conf !== null ? `${conf}%` : "N/A",
        likes: p.likes ?? 0,
        shares: p.shares ?? 0,
        commentsCount: p.commentsCount ?? 0,
        url: p.url,
        isCompetitor: p.isCompetitor,
      };
    }),
    ...comments.map((c) => {
      const plat = normalizePlatformName(c.post?.platform, c.url || c.post?.url);
      const conf = c.confidence !== null ? Math.round(c.confidence * 100) : null;
      return {
        id: c.id,
        type: "Comment" as const,
        platform: plat,
        rawPlatform: c.post?.platform || plat,
        keyword: c.keyword.term,
        title: c.post?.title ? `Comment on: ${c.post.title}` : "Comment",
        text: c.text || "",
        author: c.author || "Anonymous",
        authorUrl: c.authorUrl,
        publishedAt: c.publishedAt,
        publishedAtStr: c.publishedAt ? new Date(c.publishedAt).toLocaleString() : "N/A",
        sentiment: c.sentiment || "UNANALYZED",
        confidence: c.confidence,
        confidenceStr: conf !== null ? `${conf}%` : "N/A",
        likes: c.likes ?? 0,
        shares: null,
        commentsCount: null,
        url: c.url || c.post?.url || null,
        isCompetitor: c.isCompetitor,
      };
    }),
  ].sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ORM Reputation Management System";
  workbook.created = new Date();

  // 1. Overview & Summary Sheet
  buildSummarySheet(workbook, items, options);

  // 2. Platform Specific Sheets
  const PLATFORMS = ["Reddit", "Quora", "TeamBlind", "Trustpilot", "LinkedIn", "Web & Google"];
  for (const platName of PLATFORMS) {
    const platItems = items.filter((i) => i.platform === platName);
    buildDataSheet(workbook, platName, platItems);
  }

  // 3. All Mentions / Sentiment Combined Sheet
  let masterTabName = "All Mentions";
  if (options.sentiment === "NEGATIVE") masterTabName = "All Negative Mentions";
  else if (options.sentiment === "POSITIVE") masterTabName = "All Positive Mentions";
  else if (options.sentiment === "NEUTRAL") masterTabName = "All Neutral Mentions";

  buildDataSheet(workbook, masterTabName, items);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function buildSummarySheet(workbook: ExcelJS.Workbook, items: ExportItem[], options: ExcelExportOptions) {
  const sheet = workbook.addWorksheet("Overview & Summary", {
    views: [{ showGridLines: true }],
  });

  sheet.columns = [
    { width: 4 },
    { width: 26 },
    { width: 16 },
    { width: 14 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
  ];

  // Header Title Banner
  sheet.mergeCells("B2:H3");
  const titleCell = sheet.getCell("B2");
  let reportTitle = "📊 Online Reputation Monitoring (ORM) Export Report";
  if (options.sentiment === "NEGATIVE") reportTitle = "📊 Negative Mentions ORM Export Report";
  else if (options.sentiment === "POSITIVE") reportTitle = "📊 Positive Mentions ORM Export Report";
  else if (options.sentiment === "NEUTRAL") reportTitle = "📊 Neutral Mentions ORM Export Report";

  titleCell.value = reportTitle;
  titleCell.font = { name: "Segoe UI", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // Filter Subtitle Info
  sheet.mergeCells("B4:H4");
  const subCell = sheet.getCell("B4");
  const scopeText = (options.scope ?? "all").toUpperCase();
  subCell.value = `Scope: ${scopeText} | Generated At: ${new Date().toLocaleString()} | Total Items: ${items.length}`;
  subCell.font = { name: "Segoe UI", size: 10, italic: true, color: { argb: "FF64748B" } };

  // KPI Metric Cards Table
  const totalPosts = items.filter((i) => i.type === "Post").length;
  const totalComments = items.filter((i) => i.type === "Comment").length;
  const posCount = items.filter((i) => i.sentiment === "POSITIVE").length;
  const negCount = items.filter((i) => i.sentiment === "NEGATIVE").length;
  const neuCount = items.filter((i) => i.sentiment === "NEUTRAL").length;

  // Summary Metrics Table Header
  const summaryHeaderRow = sheet.getRow(6);
  summaryHeaderRow.values = ["", "Metric", "Total Mentions", "Posts", "Comments", "Positive", "Negative", "Neutral"];
  formatHeaderRow(summaryHeaderRow, "FF1E293B");

  const rowData = [
    ["", "Overall Mentions", items.length, totalPosts, totalComments, posCount, negCount, neuCount],
  ];

  rowData.forEach((r, idx) => {
    const row = sheet.getRow(7 + idx);
    row.values = r;
    row.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getCell(`B${7 + idx}`).alignment = { vertical: "middle", horizontal: "left" };
    row.font = { name: "Segoe UI", size: 11, bold: true };

    // Sentiment Cell Shading
    sheet.getCell(`F${7 + idx}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCFCE7" } };
    sheet.getCell(`G${7 + idx}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
    sheet.getCell(`H${7 + idx}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
  });

  // Platform Breakdown Section Header
  sheet.getCell("B10").value = "Platform Breakdown & Sentiment Distribution";
  sheet.getCell("B10").font = { name: "Segoe UI", size: 13, bold: true, color: { argb: "FF0F172A" } };

  const platHeaderRow = sheet.getRow(12);
  platHeaderRow.values = ["", "Platform", "Total Mentions", "Posts", "Comments", "Positive", "Negative", "Neutral"];
  formatHeaderRow(platHeaderRow, "FF334155");

  const PLATFORMS = ["Reddit", "Quora", "TeamBlind", "Trustpilot", "LinkedIn", "Web & Google"];
  PLATFORMS.forEach((plat, idx) => {
    const pItems = items.filter((i) => i.platform === plat);
    const pPosts = pItems.filter((i) => i.type === "Post").length;
    const pComments = pItems.filter((i) => i.type === "Comment").length;
    const pPos = pItems.filter((i) => i.sentiment === "POSITIVE").length;
    const pNeg = pItems.filter((i) => i.sentiment === "NEGATIVE").length;
    const pNeu = pItems.filter((i) => i.sentiment === "NEUTRAL").length;

    const rowIndex = 13 + idx;
    const row = sheet.getRow(rowIndex);
    row.values = ["", plat, pItems.length, pPosts, pComments, pPos, pNeg, pNeu];
    row.font = { name: "Segoe UI", size: 10 };
    row.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getCell(`B${rowIndex}`).alignment = { vertical: "middle", horizontal: "left" };
    sheet.getCell(`B${rowIndex}`).font = { name: "Segoe UI", size: 10, bold: true };

    // Soft zebra striping
    if (idx % 2 === 1) {
      for (let c = 2; c <= 8; c++) {
        sheet.getCell(rowIndex, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    }
  });
}

function buildDataSheet(workbook: ExcelJS.Workbook, sheetName: string, items: ExportItem[]) {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ showGridLines: true, state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Type", key: "type", width: 12 },
    { header: "Platform", key: "platform", width: 14 },
    { header: "Keyword / Brand", key: "keyword", width: 22 },
    { header: "Title / Headline", key: "title", width: 35 },
    { header: "Content / Text", key: "text", width: 55 },
    { header: "Author", key: "author", width: 18 },
    { header: "Author Profile", key: "authorUrl", width: 22 },
    { header: "Published Date", key: "publishedAtStr", width: 20 },
    { header: "Sentiment", key: "sentiment", width: 14 },
    { header: "Confidence", key: "confidenceStr", width: 13 },
    { header: "Likes", key: "likes", width: 10 },
    { header: "Shares", key: "shares", width: 10 },
    { header: "Comments", key: "commentsCount", width: 12 },
    { header: "Direct Link to Post/Comment", key: "url", width: 32 },
  ];

  // Header Styling
  const headerRow = sheet.getRow(1);
  formatHeaderRow(headerRow, "FF1E293B");
  headerRow.height = 28;

  if (items.length === 0) {
    const emptyRow = sheet.getRow(2);
    emptyRow.values = ["No items found for this platform."];
    sheet.mergeCells("A2:N2");
    emptyRow.font = { name: "Segoe UI", size: 11, italic: true, color: { argb: "FF94A3B8" } };
    emptyRow.alignment = { vertical: "middle", horizontal: "center" };
    return;
  }

  items.forEach((item, index) => {
    const rowNum = index + 2;
    const row = sheet.getRow(rowNum);

    row.values = [
      item.type,
      item.platform,
      item.keyword,
      item.title,
      item.text,
      item.author,
      item.authorUrl ? { text: "👤 Author Profile", hyperlink: item.authorUrl } : "N/A",
      item.publishedAtStr,
      item.sentiment,
      item.confidenceStr,
      item.likes ?? "-",
      item.shares ?? "-",
      item.commentsCount ?? "-",
      item.url ? { text: `🔗 View ${item.type} Link`, hyperlink: item.url } : "No URL",
    ];

    row.font = { name: "Segoe UI", size: 10 };
    row.alignment = { vertical: "top" };

    // Column specific alignments
    sheet.getCell(`A${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`B${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`E${rowNum}`).alignment = { vertical: "top", wrapText: true }; // Wrap text for post/comment content
    sheet.getCell(`H${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`I${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`J${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`K${rowNum}`).alignment = { vertical: "top", horizontal: "right" };
    sheet.getCell(`L${rowNum}`).alignment = { vertical: "top", horizontal: "right" };
    sheet.getCell(`M${rowNum}`).alignment = { vertical: "top", horizontal: "right" };
    sheet.getCell(`N${rowNum}`).alignment = { vertical: "top", horizontal: "center" };

    // Author Hyperlink Styling
    if (item.authorUrl) {
      sheet.getCell(`G${rowNum}`).font = { name: "Segoe UI", size: 10, color: { argb: "FF2563EB" }, underline: true };
    }

    // Direct URL Hyperlink Styling
    if (item.url) {
      sheet.getCell(`N${rowNum}`).font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF2563EB" }, underline: true };
    }

    // Sentiment Badge Cell Styling
    const sentCell = sheet.getCell(`I${rowNum}`);
    if (item.sentiment === "POSITIVE") {
      sentCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCFCE7" } };
      sentCell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF15803D" } };
    } else if (item.sentiment === "NEGATIVE") {
      sentCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
      sentCell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FFB91C1C" } };
    } else if (item.sentiment === "NEUTRAL") {
      sentCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
      sentCell.font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF475569" } };
    }

    // Alternating Zebra Row Background
    if (index % 2 === 1) {
      for (let col = 1; col <= 14; col++) {
        const c = sheet.getCell(rowNum, col);
        if (!c.fill) {
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
        }
      }
    }
  });
}

function formatHeaderRow(row: ExcelJS.Row, bgArgb: string) {
  row.font = { name: "Segoe UI", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  });
}

// ---------------------------------------------------------------------------
// Google Scraper Excel Export Support
// ---------------------------------------------------------------------------

export interface GoogleExportItem {
  id?: string;
  title?: string;
  snippet?: string | null;
  domain?: string | null;
  platform?: string | null;
  engine?: string | null;
  query?: string | null;
  published?: string | null;
  first_seen?: string | null;
  date_status?: string | null;
  url: string;
}

export interface GoogleExcelExportOptions {
  platform?: string;
  dateRangeLabel?: string;
  dateFrom?: string;
  dateTo?: string;
  query?: string;
}

export async function generateGoogleExcelReport(
  items: GoogleExportItem[] = [],
  options: GoogleExcelExportOptions = {}
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ORM Reputation Management System - Google Scraper";
  workbook.created = new Date();

  // 1. Overview & Summary Sheet
  buildGoogleSummarySheet(workbook, items, options);

  const selectedPlatform = (options.platform || "All").trim();
  const isAllPlatforms = selectedPlatform.toLowerCase() === "all";

  if (isAllPlatforms) {
    // Determine unique platforms with counts
    const counts: Record<string, number> = {};
    for (const item of items) {
      const p = (item.platform || "Web").trim();
      counts[p] = (counts[p] || 0) + 1;
    }

    const uniquePlatforms = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

    // Platform-specific tabs
    for (const plat of uniquePlatforms) {
      const platItems = items.filter((i) => (i.platform || "Web").trim() === plat);
      const tabName = plat.slice(0, 31);
      buildGoogleDataSheet(workbook, tabName, platItems);
    }

    // Master All Mentions Sheet
    buildGoogleDataSheet(workbook, "All Mentions", items);
  } else {
    // Only the filtered platform tab
    const tabName = `${selectedPlatform} Mentions`.slice(0, 31);
    buildGoogleDataSheet(workbook, tabName, items);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function buildGoogleSummarySheet(
  workbook: ExcelJS.Workbook,
  items: GoogleExportItem[],
  options: GoogleExcelExportOptions
) {
  const sheet = workbook.addWorksheet("Overview & Summary", {
    views: [{ showGridLines: true }],
  });

  sheet.columns = [
    { width: 4 },
    { width: 28 },
    { width: 20 },
    { width: 20 },
    { width: 22 },
    { width: 22 },
  ];

  // Header Title Banner
  sheet.mergeCells("B2:F3");
  const titleCell = sheet.getCell("B2");
  titleCell.value = "🔍 Google Brand Monitor & SERP Mentions Report";
  titleCell.font = { name: "Segoe UI", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // Filter Subtitle Info
  sheet.mergeCells("B4:F4");
  const subCell = sheet.getCell("B4");
  const tabInfo = (options.platform || "All").toUpperCase();
  const dateInfo = options.dateRangeLabel || (options.dateFrom || options.dateTo ? `${options.dateFrom || "Start"} to ${options.dateTo || "Now"}` : "ALL TIME");
  const queryInfo = options.query ? ` | Search Filter: "${options.query}"` : "";
  subCell.value = `Tab: ${tabInfo} | Date Filter: ${dateInfo}${queryInfo} | Generated: ${new Date().toLocaleString()} | Total Items: ${items.length}`;
  subCell.font = { name: "Segoe UI", size: 10, italic: true, color: { argb: "FF64748B" } };

  // Metrics computation
  const uniqueDomains = new Set(items.map((i) => i.domain).filter(Boolean)).size;
  const uniquePlatforms = new Set(items.map((i) => i.platform || "Web").filter(Boolean)).size;
  const uniqueQueries = new Set(items.map((i) => i.query).filter(Boolean)).size;

  // KPI Metrics Table Header
  const summaryHeaderRow = sheet.getRow(6);
  summaryHeaderRow.values = ["", "Metric", "Total Mentions", "Unique Domains", "Platform Categories", "Queries Tracked"];
  formatHeaderRow(summaryHeaderRow, "FF1E293B");

  const rowData = ["", "Google SERP Mentions", items.length, uniqueDomains, uniquePlatforms, uniqueQueries];
  const metricRow = sheet.getRow(7);
  metricRow.values = rowData;
  metricRow.alignment = { vertical: "middle", horizontal: "center" };
  sheet.getCell("B7").alignment = { vertical: "middle", horizontal: "left" };
  metricRow.font = { name: "Segoe UI", size: 11, bold: true };
  sheet.getCell("C7").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };

  // Platform Breakdown Section Header
  sheet.getCell("B10").value = "Platform Breakdown & Distribution";
  sheet.getCell("B10").font = { name: "Segoe UI", size: 13, bold: true, color: { argb: "FF0F172A" } };

  const platHeaderRow = sheet.getRow(12);
  platHeaderRow.values = ["", "Platform", "Mentions Count", "% Share", "Top Domain", "Sample Engine"];
  formatHeaderRow(platHeaderRow, "FF334155");

  const platformCounts: Record<string, { count: number; domains: Record<string, number>; engines: Record<string, number> }> = {};
  for (const item of items) {
    const p = (item.platform || "Web").trim();
    if (!platformCounts[p]) platformCounts[p] = { count: 0, domains: {}, engines: {} };
    platformCounts[p].count += 1;
    if (item.domain) platformCounts[p].domains[item.domain] = (platformCounts[p].domains[item.domain] || 0) + 1;
    if (item.engine) platformCounts[p].engines[item.engine] = (platformCounts[p].engines[item.engine] || 0) + 1;
  }

  const sortedPlatforms = Object.keys(platformCounts).sort((a, b) => platformCounts[b].count - platformCounts[a].count);
  sortedPlatforms.forEach((p, idx) => {
    const data = platformCounts[p];
    const pct = items.length > 0 ? `${((data.count / items.length) * 100).toFixed(1)}%` : "0%";
    const topDomain = Object.keys(data.domains).sort((a, b) => data.domains[b] - data.domains[a])[0] || "N/A";
    const topEngine = Object.keys(data.engines).sort((a, b) => data.engines[b] - data.engines[a])[0] || "Serper";

    const rowIndex = 13 + idx;
    const row = sheet.getRow(rowIndex);
    row.values = ["", p, data.count, pct, topDomain, topEngine];
    row.font = { name: "Segoe UI", size: 10 };
    row.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getCell(`B${rowIndex}`).alignment = { vertical: "middle", horizontal: "left" };
    sheet.getCell(`B${rowIndex}`).font = { name: "Segoe UI", size: 10, bold: true };

    if (idx % 2 === 1) {
      for (let c = 2; c <= 6; c++) {
        sheet.getCell(rowIndex, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
    }
  });
}

function parseGoogleItemDate(item: GoogleExportItem): Date | null {
  const raw = (item.published || "").trim();
  if (raw) {
    const relMatch = raw.toLowerCase().match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
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
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function buildGoogleDataSheet(workbook: ExcelJS.Workbook, sheetName: string, items: GoogleExportItem[]) {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ showGridLines: true, state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Platform", key: "platform", width: 14 },
    { header: "Domain", key: "domain", width: 22 },
    { header: "Recency Tag", key: "recency", width: 14 },
    { header: "Query / Keyword", key: "query", width: 20 },
    { header: "Title / Headline", key: "title", width: 40 },
    { header: "Snippet / Content", key: "snippet", width: 60 },
    { header: "Published Date", key: "published", width: 20 },
    { header: "Date Status", key: "date_status", width: 15 },
    { header: "Search Engine", key: "engine", width: 16 },
    { header: "First Discovered", key: "first_seen", width: 20 },
    { header: "Direct Web Link", key: "url", width: 28 },
  ];

  const headerRow = sheet.getRow(1);
  formatHeaderRow(headerRow, "FF1E293B");
  headerRow.height = 28;

  if (items.length === 0) {
    const emptyRow = sheet.getRow(2);
    emptyRow.values = ["No mentions found matching the active filter criteria."];
    sheet.mergeCells("A2:K2");
    emptyRow.font = { name: "Segoe UI", size: 11, italic: true, color: { argb: "FF94A3B8" } };
    emptyRow.alignment = { vertical: "middle", horizontal: "center" };
    return;
  }

  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

  items.forEach((item, index) => {
    const rowNum = index + 2;
    const row = sheet.getRow(rowNum);

    const parsedDate = parseGoogleItemDate(item);
    let recencyTag = "-";
    if (parsedDate) {
      recencyTag = parsedDate.getTime() >= twoMonthsAgo.getTime() ? "NEW" : "OLD";
    }

    const dateStatus = item.date_status
      ? (item.date_status.charAt(0).toUpperCase() + item.date_status.slice(1))
      : (item.published ? (/\b(?:\d+)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/i.test(item.published) ? "Estimated" : "Confirmed") : "Unknown");

    row.values = [
      item.platform || "Web",
      item.domain || "N/A",
      recencyTag,
      item.query || "-",
      item.title || "Untitled Mention",
      item.snippet || "-",
      item.published || "N/A",
      dateStatus,
      item.engine || "Google",
      item.first_seen || "N/A",
      item.url ? { text: "🔗 Open Link", hyperlink: item.url } : "No URL",
    ];

    row.font = { name: "Segoe UI", size: 10 };
    row.alignment = { vertical: "top" };

    // Column alignments
    sheet.getCell(`A${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`B${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`C${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`D${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`F${rowNum}`).alignment = { vertical: "top", wrapText: true };
    sheet.getCell(`G${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`H${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`I${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`J${rowNum}`).alignment = { vertical: "top", horizontal: "center" };
    sheet.getCell(`K${rowNum}`).alignment = { vertical: "top", horizontal: "center" };

    // Domain styling
    sheet.getCell(`B${rowNum}`).font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF0284C7" } };

    // Recency tag styling
    if (recencyTag === "NEW") {
      sheet.getCell(`C${rowNum}`).font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF16A34A" } };
      sheet.getCell(`C${rowNum}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCFCE7" } };
    } else if (recencyTag === "OLD") {
      sheet.getCell(`C${rowNum}`).font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF64748B" } };
      sheet.getCell(`C${rowNum}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    }

    // Date status coloring
    if (dateStatus === "Confirmed") {
      sheet.getCell(`H${rowNum}`).font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF16A34A" } };
    } else if (dateStatus === "Estimated") {
      sheet.getCell(`H${rowNum}`).font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FFD97706" } };
    } else {
      sheet.getCell(`H${rowNum}`).font = { name: "Segoe UI", size: 10, color: { argb: "FF94A3B8" } };
    }

    // Direct URL Hyperlink Styling
    if (item.url) {
      sheet.getCell(`K${rowNum}`).font = { name: "Segoe UI", size: 10, bold: true, color: { argb: "FF2563EB" }, underline: true };
    }

    // Alternating Zebra Row Background
    if (index % 2 === 1) {
      for (let col = 1; col <= 11; col++) {
        if (col === 3) continue; // preserve recency tag fill
        const c = sheet.getCell(rowNum, col);
        if (!c.fill) {
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
        }
      }
    }
  });
}

